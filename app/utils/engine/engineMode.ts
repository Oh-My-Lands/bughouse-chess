import type { BughouseTeam } from "@/app/utils/board/clockAdvantage";
import type { BughouseBoardId, BughouseSide } from "@/app/types/analysis";

/**
 * Maps the board and colour being analysed onto the engine's `Team` option, and
 * defines the team pairing the rest of the engine code shares.
 *
 * `Mode` itself is chosen explicitly by the user. It was previously derived
 * from the clocks, but the deadband made it flip on its own mid-analysis, and a
 * flip is not cosmetic: Mode feeds an NN input plane and is hashed into the
 * position key, so it silently invalidated the tree and changed the evaluation
 * underneath whoever was reading it.
 */

/** Engine option value. "sit" means the team may double-sit. */
export type EngineMode = "go" | "sit";

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
