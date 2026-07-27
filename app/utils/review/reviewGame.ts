import type { EngineLine } from "@/app/utils/engine/engineClient";
import type { ReviewPosition } from "@/app/utils/review/buildReviewPositions";
import {
  MIN_VISITS,
  detectMistake,
  type MistakeVerdict,
} from "@/app/utils/review/detectMistake";
import {
  SEVERITY_THRESHOLDS,
  classifySeverity,
  type MistakeSeverity,
} from "@/app/utils/review/severity";

/**
 * Two-pass game review.
 *
 * Cost, not accuracy, is what shapes this. A blanket deep search of every
 * position is ~4x the price of scanning cheaply and then looking hard only
 * where the scan found something, and the deep look lands in the same places
 * either way. Measured at the one-player scope: ~190s billed against ~730s.
 *
 * The cheap tier is only economical because the searches are issued back to
 * back. RunPod bills worker uptime, so a batch of requests to one warm worker
 * shares a single ~5.5s startup and one trailing idleTimeout; the same requests
 * spaced minutes apart each pay that overhead again and 20k becomes the worst
 * value on the menu. Nothing here may pause between positions.
 */

/** How deep each pass searches. Defaults are the tiers the plan sized. */
export const SCAN_NODES = 20_000;
export const DEEP_NODES = 200_000;

/**
 * Lines to request.
 *
 * Not free -- measured at ~9% throughput against multipv 3 -- but a played move
 * missing from the reported set cannot be scored at all and costs a full deep
 * search instead. Break-even is 0.26 avoided promotions per game.
 *
 * 20 is the proxy's ceiling rather than a derived figure. `playedRank` on every
 * verdict is what will replace it: once a real distribution of played-move
 * ranks exists, pick the smallest N that covers it.
 */
export const REVIEW_MULTIPV = 20;

/** Runs one search. Injected so the driver is testable without an endpoint. */
export type AnalyzePosition = (
  position: ReviewPosition,
  nodes: number,
  multipv: number,
) => Promise<EngineLine[]>;

export interface ReviewedPosition {
  position: ReviewPosition;
  /** The verdict that stands: the deep one where there is one. */
  verdict: MistakeVerdict;
  /** Which pass produced `verdict`. */
  depth: "scan" | "deep";
  /** The scan verdict, kept when a deep pass superseded it. */
  scanVerdict: MistakeVerdict;
  /**
   * The full ranking from the deep search, kept so the engine panel can show
   * the whole analysis a finding was scored against -- not just the two lines
   * `verdict` extracts. Set only on positions the deep pass searched; the raw
   * array is otherwise discarded. See `detectMistake` for what the two-line
   * verdict keeps.
   */
  deepLines?: readonly EngineLine[];
}

export interface ReviewReport {
  positions: ReviewedPosition[];
  /** Positions the scan sent to the deep pass, and why. */
  promoted: number;
  searches: { scan: number; deep: number };
  /**
   * Distribution of the played move's rank among reported lines, keyed by rank;
   * `null` counts moves that were not reported at all.
   *
   * Collected to settle REVIEW_MULTIPV from evidence rather than from the
   * proxy's cap.
   */
  playedRankHistogram: Map<number | null, number>;
}

/**
 * The threshold the deep pass scores against.
 *
 * Tied to the lowest reported band rather than set independently: grading drops
 * everything below `inaccuracy` anyway, so any lower value only produces
 * verdicts labelled `mistake` that no report will ever show. Measured 2026-07-22
 * at 200k, the worst run-to-run spread on lines clearing MIN_VISITS is 0.0125,
 * so this clears noise by 2.4x.
 *
 * Note this is *not* the scan's threshold. The scan must cut lower -- see
 * `scanThresholdFor` -- because it estimates the same loss with a cheaper
 * search and would otherwise filter out positions the deep pass would grade.
 */
export const THRESHOLD_DEEP = SEVERITY_THRESHOLDS.inaccuracy;

/**
 * Visits the played move needs to be scored by the *deep* pass.
 *
 * Zero, deliberately. `MIN_VISITS = 500` was calibrated at 20k, where an
 * unexamined line's `q` is a bare network prior and ungated noise is 0.0904. At
 * 200k the same measurement gives 0.0125 ungated against 0.0119 gated, so the
 * gate buys nothing here -- while discarding the moves the search sampled and
 * abandoned, which are its clearest verdicts.
 *
 * The reference gate is untouched; only the move being reported is ungated.
 */
export const DEEP_PLAYED_MIN_VISITS = 0;

/**
 * The reference gate, as a share of the search rather than a flat count.
 *
 * `MIN_VISITS = 500` was calibrated at 20k, where it is 2.5% of the budget. Left
 * absolute it weakens as the budget grows -- at 200k the same number admits a
 * line the search spent 0.25% of its effort on. That is the wrong direction:
 * the reference sets the bar every loss is measured against, so a bad one
 * invents mistakes rather than merely misreporting their size.
 *
 * 2.5% is not a new calibration. It is the 20k gate restated as a fraction, so
 * the scan's behaviour is unchanged by construction and the deep pass simply
 * keeps the same relative strength.
 *
 * Measured to be a no-op on the reviewed game (2026-07-23, `scripts/
 * phase3-reference-gate.ts`, re-grading its 20 cached 200k searches): sweeping
 * the gate from 500 to 10,000 leaves all 12 findings standing, drops none, and
 * moves one loss by 0.0004 -- inside the noise floor. This is insurance against
 * a case that has not yet occurred, not a fix for an observed error, and it is
 * free precisely because nothing currently depends on the difference.
 */
export const REFERENCE_VISIT_FRACTION = 0.025;

/** The reference gate at a given budget. Returns exactly MIN_VISITS at 20k. */
export function referenceMinVisitsFor(nodes: number): number {
  return Math.max(MIN_VISITS, Math.round(REFERENCE_VISIT_FRACTION * nodes));
}

export interface ReviewGameOptions {
  scanNodes?: number;
  deepNodes?: number;
  multipv?: number;
  /** Defaults to THRESHOLD_DEEP. The scan keeps `detectMistake`'s own default. */
  deepThreshold?: number;
  /** Defaults to DEEP_PLAYED_MIN_VISITS. Applies to the played move only. */
  deepPlayedMinVisits?: number;
  /** Called after each search, for progress in a long review. */
  onProgress?: (done: number, total: number, phase: "scan" | "deep") => void;
}

/**
 * Reviews a list of positions and returns a verdict for each.
 *
 * Pass 1 scans every position cheaply. Pass 2 re-searches only those the scan
 * either flagged or could not score -- an unexplored or low-confidence played
 * move is promoted precisely because the cheap search failed to answer, and
 * those are the positions where an answer is most wanted.
 */
export async function reviewGame(
  positions: readonly ReviewPosition[],
  analyze: AnalyzePosition,
  options: ReviewGameOptions = {},
): Promise<ReviewReport> {
  const scanNodes = options.scanNodes ?? SCAN_NODES;
  const deepNodes = options.deepNodes ?? DEEP_NODES;
  const multipv = options.multipv ?? REVIEW_MULTIPV;

  const reviewed: ReviewedPosition[] = [];

  for (const position of positions) {
    const lines = await analyze(position, scanNodes, multipv);
    const verdict = detectMistake(lines, position.playedMove, {
      orderingAmbiguous: position.orderingAmbiguous,
      minVisits: referenceMinVisitsFor(scanNodes),
    });
    reviewed.push({ position, verdict, depth: "scan", scanVerdict: verdict });
    options.onProgress?.(reviewed.length, positions.length, "scan");
  }

  const promoted = reviewed.filter((entry) => entry.verdict.promote);

  let done = 0;
  for (const entry of promoted) {
    const lines = await analyze(entry.position, deepNodes, multipv);
    // The deep verdict replaces the scan's rather than being averaged with it:
    // the scan's threshold is a filter tuned to over-flag, and its number was
    // never meant to be shown.
    entry.verdict = detectMistake(lines, entry.position.playedMove, {
      orderingAmbiguous: entry.position.orderingAmbiguous,
      threshold: options.deepThreshold ?? THRESHOLD_DEEP,
      playedMinVisits: options.deepPlayedMinVisits ?? DEEP_PLAYED_MIN_VISITS,
      minVisits: referenceMinVisitsFor(deepNodes),
    });
    entry.depth = "deep";
    // Keep the whole ranking, not just the verdict's two lines: the engine panel
    // renders it when the cursor is on this finding.
    entry.deepLines = lines;
    options.onProgress?.(++done, promoted.length, "deep");
  }

  const playedRankHistogram = new Map<number | null, number>();
  for (const entry of reviewed) {
    const rank = entry.scanVerdict.playedRank;
    playedRankHistogram.set(rank, (playedRankHistogram.get(rank) ?? 0) + 1);
  }

  return {
    positions: reviewed,
    promoted: promoted.length,
    searches: { scan: reviewed.length, deep: promoted.length },
    playedRankHistogram,
  };
}

/**
 * The mistakes worth showing, worst first.
 *
 * Only deep verdicts qualify. A scan-grade `mistake` is a candidate the deep
 * pass was meant to adjudicate, and reporting one that the deep pass then
 * cleared would put the cheap threshold's false positives in front of the user
 * -- which is the entire thing two passes exist to avoid.
 */
export function mistakesFrom(report: ReviewReport): ReviewedPosition[] {
  return report.positions
    .filter((entry) => entry.depth === "deep" && entry.verdict.kind === "mistake")
    .sort((a, b) => {
      const loss = (entry: ReviewedPosition) =>
        entry.verdict.kind === "mistake" ? entry.verdict.loss : 0;
      return loss(b) - loss(a);
    });
}

export interface GradedMistake {
  entry: ReviewedPosition;
  loss: number;
  severity: MistakeSeverity;
}

/**
 * The report's graded findings, worst first.
 *
 * Grading is applied here rather than inside the detector because it is a
 * presentation decision: the same `loss` is a yes/no answer to the scan and a
 * three-way one to a reader. Anything below the inaccuracy floor is dropped
 * entirely -- every move that is not the top choice loses *something*, and
 * listing all of them would bury the two that matter.
 */
export function gradedMistakesFrom(
  report: ReviewReport,
  thresholds = SEVERITY_THRESHOLDS,
): GradedMistake[] {
  const graded: GradedMistake[] = [];

  for (const entry of mistakesFrom(report)) {
    if (entry.verdict.kind !== "mistake") continue;
    const severity = classifySeverity(entry.verdict.loss, thresholds);
    if (severity === null) continue;
    graded.push({
      entry,
      loss: entry.verdict.loss,
      severity,
    });
  }

  return graded.sort((a, b) => b.loss - a.loss);
}

/** Counts per band, including bands with none, for a report summary line. */
export function severityCounts(
  graded: readonly GradedMistake[],
): Record<MistakeSeverity, number> {
  const counts: Record<MistakeSeverity, number> = {
    blunder: 0,
    mistake: 0,
    inaccuracy: 0,
  };
  for (const item of graded) counts[item.severity] += 1;
  return counts;
}
