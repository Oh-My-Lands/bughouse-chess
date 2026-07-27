import type { EngineLine } from "@/app/utils/engine/engineClient";

/**
 * Decides whether the move actually played was a mistake, from a single search.
 *
 * The naive approach searches twice per ply -- once before the move and once
 * after -- and diffs the evaluations. That is exactly twice the GPU time, and
 * it is unnecessary: the search at the position *before* the move already ranks
 * every root move it explored, so the best line's `q` and the played move's `q`
 * come out of the same search. Nothing extra is bought by searching again.
 *
 * Reading that difference honestly is the whole problem, and it has three
 * traps. Each is measured rather than assumed; see POST_GAME_ANALYSIS_PLAN.md
 * (phase 1b, measured 2026-07-22 over 84 searches).
 */

/**
 * Visits below which a line's `q` is not a search result.
 *
 * The trap here is that low-visit lines look *stable*: measured at 20k nodes, a
 * move with one visit had a `q` spread of exactly 0.0000 across seven runs.
 * That is not accuracy, it is determinism -- with no search on top of it, `q`
 * is just the network's raw evaluation, reproduced exactly every time. So a
 * gate cannot be derived from run-to-run spread; it exists to establish that
 * search happened at all.
 *
 * 500 is where the measured noise stops being dominated by outliers: the worst
 * observed `loss` spread is 0.0124 at >=500 visits, against 0.0342 at >=250 and
 * 0.0904 with no gate.
 */
export const MIN_VISITS = 500;

/**
 * The scan threshold, in `q`.
 *
 * Sits above the 0.0124 worst-case run-to-run spread measured at 20k nodes for
 * lines clearing MIN_VISITS. Anything lower reports the search's own
 * nondeterminism as a blunder.
 *
 * Deliberately *not* the threshold used for the final report. This one filters
 * a cheap 20k scan and should over-flag, because a false positive costs one
 * deeper search while a false negative loses the mistake entirely. The number
 * shown to a user comes from the 200k pass and carries its own threshold,
 * measured separately at that budget.
 *
 * Note this invalidates the 0.02 figure inherited from 50k measurements: at 20k
 * a 0.02 threshold reports noise for any line under ~500 visits.
 */
export const THRESHOLD_SCAN = 0.015;

export interface DetectMistakeOptions {
  /**
   * Visits a line needs to be eligible as the *reference*. Defaults to
   * MIN_VISITS.
   *
   * This gate must stay: a fluke high-`q` line on few visits, taken as the
   * baseline, manufactures a loss out of nothing.
   */
  minVisits?: number;
  /**
   * Visits the *played* move needs to be scored at all. Defaults to
   * `minVisits`.
   *
   * Separate from the reference gate because the two answer different
   * questions. A reference sets the bar, so a bad one invents mistakes. The
   * played move's `q` is only being *reported*, so a noisy one is merely
   * imprecise -- and at 200k it is not even noisy: ungated run-to-run spread is
   * 0.0125, against gated 0.0119.
   *
   * The deeper reason to separate them is that a low visit count on a move with
   * a real prior is not missing information -- it is the search's verdict.
   * MCTS funds moves that keep looking good, so a move sampled a few hundred
   * times and then abandoned was *tried and rejected*. Measured on the reviewed
   * game: ply 91's `f2e3` held a prior of 0.0625 and settled at 335 visits with
   * q -0.117 while siblings returned +0.288. A single gate treats that
   * identically to a line the search never returned to, and so discards the
   * clearest verdicts in the game -- ply 91 would have been the largest finding
   * in it, at 0.4054.
   */
  playedMinVisits?: number;
  /** Defaults to THRESHOLD_SCAN. */
  threshold?: number;
  /**
   * Whether this position's place in the interleaved timeline was decided by a
   * timestamp tie-break rather than by the clock.
   *
   * Measured at 4.7% of positions (median 5 per game). The two boards are
   * merged by elapsed time and same-timestamp moves resolve in favour of board
   * A, so at a tie the partner board may legitimately be one move ahead or
   * behind. The engine reads both boards, so the evaluation is conditioned on a
   * board state that is a guess. Echoed on the verdict rather than acted on:
   * a mistake found only here should be shown with that caveat, not hidden.
   */
  orderingAmbiguous?: boolean;
}

interface VerdictBase {
  /**
   * Whether this position needs the deep pass. True whenever the scan could
   * not score the played move, as well as when it scored it as a mistake.
   */
  promote: boolean;
  /** See DetectMistakeOptions.orderingAmbiguous. */
  orderingAmbiguous: boolean;
  /**
   * 1-based rank of the played move among the reported lines, or null when it
   * was not reported.
   *
   * Recorded so the review's `multipv` can be chosen from evidence: widening it
   * only helps if played moves actually turn up beyond the default five, and
   * that distribution is not yet known for real games.
   */
  playedRank: number | null;
}

export type MistakeVerdict = VerdictBase &
  (
    | {
        /** Scored, and within tolerance. */
        kind: "ok";
        loss: number;
        played: EngineLine;
        reference: EngineLine;
      }
    | {
        /** Scored, and worse than the threshold. */
        kind: "mistake";
        loss: number;
        played: EngineLine;
        reference: EngineLine;
      }
    | {
        /**
         * The played move is not among the reported lines.
         *
         * A weak signal, not a verdict. Under progressive widening a move can
         * be absent because the search never looked at it, which is not the
         * same as it being bad -- and no `q` comes back, so the mistake cannot
         * be quantified even if it is one. Measured: sharp positions return as
         * few as 3 lines however many are requested, so this fires most often
         * exactly where the interesting mistakes are.
         */
        kind: "unexplored";
      }
    | {
        /** The played move was reported, but on too few visits to read. */
        kind: "low-confidence";
        played: EngineLine;
      }
    | {
        /**
         * No line cleared the reference gate, so there is nothing to measure
         * against. Distinct from `unexplored`: the search is unusable here
         * rather than the move being unexamined.
         *
         * Reachable only because the two gates are separate -- with a single
         * gate the played move was always itself eligible as the reference.
         */
        kind: "no-reference";
        played: EngineLine;
      }
  );

/**
 * @param lines   The settled ranking from one search of the position *before*
 *                the move, as returned for the board being reviewed.
 * @param playedMove The move actually played, in the engine's UCI form. Null
 *                means the player sat -- a real action in bughouse, and one the
 *                engine ranks like any other.
 */
export function detectMistake(
  lines: readonly EngineLine[],
  playedMove: string | null,
  options: DetectMistakeOptions = {},
): MistakeVerdict {
  const minVisits = options.minVisits ?? MIN_VISITS;
  const playedMinVisits = options.playedMinVisits ?? minVisits;
  const threshold = options.threshold ?? THRESHOLD_SCAN;
  const orderingAmbiguous = options.orderingAmbiguous ?? false;

  const played = lines.find((line) => line.move === playedMove) ?? null;
  const playedRank = played?.multipv ?? null;
  const base = { orderingAmbiguous, playedRank };

  if (played === null) {
    return { ...base, kind: "unexplored", promote: true };
  }

  if (played.visits < playedMinVisits) {
    return { ...base, kind: "low-confidence", promote: true, played };
  }

  const trusted = lines.filter((line) => line.visits >= minVisits);
  if (trusted.length === 0) {
    return { ...base, kind: "no-reference", promote: true, played };
  }

  /**
   * The reference is the highest-`q` line eligible to set the bar, not
   * `lines[0]`.
   *
   * Rank 1 is the engine's *choice*, which follows the most-visited move rather
   * than the highest-q one -- measured as differing in three of six benchmark
   * positions. Using `lines[0].q` as the baseline therefore produces negative
   * losses for moves the engine rated higher than the one it picked, which
   * would read as "better than best" rather than as the tie it is.
   *
   * The played move joins the candidates even when it misses the reference
   * gate. That can only ever *lower* the loss, never invent one, and it keeps
   * `loss` non-negative: a played move better than everything trusted is its
   * own reference and scores zero.
   */
  const candidates = trusted.includes(played) ? trusted : [...trusted, played];
  const reference = candidates.reduce((best, line) => (line.q > best.q ? line : best));
  const loss = reference.q - played.q;

  return {
    ...base,
    kind: loss >= threshold ? "mistake" : "ok",
    promote: loss >= threshold,
    loss,
    played,
    reference,
  };
}

/**
 * Why a reported evaluation is not exact, in one sentence per reason.
 *
 * Surfaced in the report rather than kept here: both caveats are properties of
 * the method, not bugs to be fixed later, and a number presented without them
 * claims a precision the search does not have.
 */
export function methodologyCaveats(verdict: MistakeVerdict): string[] {
  const caveats: string[] = [];

  /**
   * `q` belongs to a joint action over both boards. The value read for the
   * played move is q(played move here, engine's choice on the partner board),
   * which the line records as `partnerMove`. When the real game's partner-board
   * action differed, this is not the evaluation of what actually happened.
   */
  if (
    (verdict.kind === "ok" || verdict.kind === "mistake") &&
    verdict.played.partnerMove !== null
  ) {
    caveats.push(
      `Evaluated assuming the partner plays ${verdict.played.partnerMove}; ` +
        "the game may have continued differently on that board.",
    );
  }

  if (verdict.orderingAmbiguous) {
    caveats.push(
      "The two boards' moves landed on the same clock reading here, so the " +
        "partner board's state at this point may be one move out.",
    );
  }

  return caveats;
}
