import {
  getTeamTimeDiffDeciseconds,
  type BughouseTeam,
} from "@/app/utils/board/clockAdvantage";
import type { BughouseBoardId, BughouseSide } from "@/app/types/analysis";
import type { BughouseClocksSnapshotByBoard } from "@/app/types/bughouse";

/**
 * Maps the board and colour being analysed onto the engine's `Team` option, and
 * defines the team pairing the rest of the engine code shares.
 *
 * `Mode` is derived from the clock -- see `deriveEngineMode`. An earlier version
 * derived it continuously and let it flip on its own mid-analysis, which was not
 * cosmetic: Mode feeds an NN input plane and is hashed into the position key, so
 * a flip silently invalidated the tree and changed the evaluation underneath
 * whoever was reading it. The fix is not to stop deriving it but to sample it
 * *once per position*: the derived value is a pure function of that position's
 * (static, historical) clock and is part of the request key, so it is constant
 * within any one search and only ever changes when the analysed position does --
 * which starts a new search anyway. The live panel additionally lets the user
 * pin an explicit override.
 */

/** Engine option value. "sit" means the team may double-sit. */
export type EngineMode = "go" | "sit";

/**
 * Team uptime, in deciseconds, at which a team may start double-sitting.
 *
 * Below this the team is treated as "go" (the conservative default: the smaller
 * action space, so it cannot invent a double-sit the team has not earned). The
 * threshold is a floor, not a deadband around a live signal -- because Mode is
 * sampled once per position it cannot chatter, so a single edge is enough.
 */
export const MODE_SIT_THRESHOLD_DCS = 15;

/**
 * Derive Mode from the analysed team's clock advantage at a single instant.
 *
 * "Uptime" is the diagonal-team difference, not the same-board opponent's clock:
 * `getTeamTimeDiffDeciseconds` sums each team's diagonal partners (A-White with
 * B-Black) and subtracts, and `teamFor` says which side of that the analysed
 * team is on. A team `MODE_SIT_THRESHOLD_DCS` or more ahead may sit; otherwise
 * it goes.
 *
 * Must be sampled once and held for the whole search (see `requestKey` in
 * useEngineAnalysis); re-deriving it mid-search is the mid-analysis flip this
 * design exists to avoid.
 */
export function deriveEngineMode(
  snapshot: BughouseClocksSnapshotByBoard,
  board: BughouseBoardId,
  side: BughouseSide,
): EngineMode {
  const diff = getTeamTimeDiffDeciseconds(snapshot);
  const teamUptimeDcs =
    teamFor(board, side) === "AWhite_BBlack" ? diff : -diff;
  return teamUptimeDcs >= MODE_SIT_THRESHOLD_DCS ? "sit" : "go";
}

/**
 * Maps a board and colour onto the team pairing the clocks are scored by.
 *
 * Bughouse teams are diagonal: A-White partners B-Black. So board A white and
 * board B black are the same team, and the naive "white is team 1" is wrong for
 * board B.
 */
export function teamFor(board: BughouseBoardId, side: BughouseSide): BughouseTeam {
  const isTeamOne = (board === "A") === (side === "white");
  return isTeamOne ? "AWhite_BBlack" : "ABlack_BWhite";
}

/**
 * Maps a board and colour onto the engine's `Team` option.
 *
 * The engine does not take a board -- it plays `teamSide` on board A and the
 * opposite colour on board B (see UCI::policy). So a user sitting at board B as
 * white is, in the engine's terms, playing team black.
 */
export function engineTeamColour(
  board: BughouseBoardId,
  side: BughouseSide,
): BughouseSide {
  if (board === "A") return side;
  return side === "white" ? "black" : "white";
}
