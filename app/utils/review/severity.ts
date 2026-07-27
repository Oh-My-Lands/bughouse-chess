/**
 * Grading a mistake by how much it cost.
 *
 * `detectMistake` answers a yes/no question against one threshold. That is the
 * right shape for the cheap scan, whose only job is to decide what deserves a
 * deeper look, but it is the wrong shape for a report: "you made 12 mistakes"
 * flattens a 0.0317 into the same statement as a 0.1985, and the second is six
 * times the first.
 *
 * Severity is deliberately a *reporting* concern and lives outside the
 * detector. The scan must not know about these bands -- it would start making
 * presentation decisions on numbers too noisy to support them.
 */

export type MistakeSeverity = "inaccuracy" | "mistake" | "blunder";

/**
 * Band floors, in `q` lost against the best trusted line.
 *
 * **These are provisional.** Two things are needed to call them calibrated, and
 * neither exists yet:
 *
 *   1. *A floor.* `INACCURACY` must sit above the run-to-run noise of a 200k
 *      search, which is unmeasured. The 20k figure is 0.0124 at >=500 visits;
 *      a deeper search should be tighter, but "should be" is not a measurement.
 *      Until it is taken, 0.03 is a guess with a margin, not a derived number.
 *   2. *A distribution.* What deserves the word "blunder" depends on how often
 *      it happens across many games, not on one. These were chosen against a
 *      single reviewed game.
 *
 * For scale: `q` spans [-1, 1] and maps to a win probability by (q+1)/2, so a
 * loss of 0.20 q is ten percentage points of expected result. Chess review
 * tools conventionally put a blunder near thirty points, which here would be
 * 0.60 q -- far above anything in the reviewed game. Bughouse's evaluations
 * swing harder and its games are shorter, so borrowing those bands wholesale
 * would report almost nothing. That is a reason to calibrate rather than a
 * reason to trust the numbers below.
 */
export interface SeverityThresholds {
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

export const SEVERITY_THRESHOLDS: SeverityThresholds = {
  inaccuracy: 0.03,
  mistake: 0.08,
  blunder: 0.15,
};

/**
 * The margin between the lowest reported band and the scan's cut.
 *
 * The scan estimates the same loss with a cheaper search, so its number differs
 * from the deep one by roughly the scan's own noise -- measured at 0.0124 for
 * lines clearing MIN_VISITS at 20k. A position whose scan loss is 0.02 can have
 * a deep loss of 0.035, which is a reportable inaccuracy. Cutting the scan at
 * the inaccuracy floor would discard it before the deep pass ever saw it.
 */
export const SCAN_NOISE_MARGIN = 0.0124;

/**
 * What the scan's threshold should be, given where reporting starts.
 *
 * This is the constraint that ties the two thresholds together, and it runs in
 * the direction people get backwards: the scan does not get to be chosen
 * freely. It is fixed by the lowest band that will be reported, less the
 * scan's own error. Lower and the scan promotes positions no band would ever
 * report -- which is most of what drove the measured 69% promotion rate.
 * Higher and real inaccuracies are filtered out before anything can grade them.
 */
export function scanThresholdFor(
  lowestReportedBand: number = SEVERITY_THRESHOLDS.inaccuracy,
): number {
  return Math.max(0, lowestReportedBand - SCAN_NOISE_MARGIN);
}

/**
 * Grades a loss, or returns null when it is below the reporting floor.
 *
 * Null is not "no mistake was made" -- it is "not worth telling anyone about".
 * Every move that is not the engine's top choice loses something; a report that
 * said so for all of them would be noise with a scoreboard.
 */
export function classifySeverity(
  loss: number,
  thresholds: SeverityThresholds = SEVERITY_THRESHOLDS,
): MistakeSeverity | null {
  if (loss >= thresholds.blunder) return "blunder";
  if (loss >= thresholds.mistake) return "mistake";
  if (loss >= thresholds.inaccuracy) return "inaccuracy";
  return null;
}

/** Worst first, for ordering a report. */
export const SEVERITY_ORDER: readonly MistakeSeverity[] = [
  "blunder",
  "mistake",
  "inaccuracy",
];

// Note the asymmetry `classifySeverity` carries: only losses at or above the
// reporting floor are graded at all, so a move that *just misses* the floor is
// absent rather than reported as a marginal non-finding. That is deliberate --
// a report padded with things that might not be mistakes is worse than one that
// occasionally omits a marginal case -- but it does mean the bottom edge of the
// report is softer than it looks.
