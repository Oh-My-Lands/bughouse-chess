import type { BughouseBoardId, BughouseSide } from "@/app/types/analysis";
import type { BughousePlayer } from "@/app/types/bughouse";

/**
 * Who a review can be run for.
 *
 * A review's scope is one player at a time (see Phase 0 in
 * POST_GAME_ANALYSIS_PLAN.md), and a player is a `(board, side)` pair -- the
 * two coordinates `buildReviewPositions` filters on. This turns the four
 * players of a loaded game into that list, carrying the username so the picker
 * has something to show and the board/side so the review has something to run.
 *
 * Kept separate from the panel because it is pure: the mapping from the four
 * player slots to their board and side is fixed, and testing it needs no React.
 */
export interface ReviewScopeChoice {
  board: BughouseBoardId;
  side: BughouseSide;
  username: string;
}

/** Stable identity for a scope, for React keys and equality. */
export function reviewScopeId(scope: {
  board: BughouseBoardId;
  side: BughouseSide;
}): string {
  return `${scope.board}${scope.side}`;
}

/**
 * The four review scopes for a loaded game, in board-reading order (A-white,
 * A-black, B-white, B-black).
 *
 * The board/side of each slot is not a guess: `aWhite` is by construction the
 * white player on board A, and so on -- `processGameData` derives the four
 * slots from the recorded colours.
 */
export function reviewScopeChoices(players: {
  aWhite: BughousePlayer;
  aBlack: BughousePlayer;
  bWhite: BughousePlayer;
  bBlack: BughousePlayer;
}): ReviewScopeChoice[] {
  return [
    { board: "A", side: "white", username: players.aWhite.username },
    { board: "A", side: "black", username: players.aBlack.username },
    { board: "B", side: "white", username: players.bWhite.username },
    { board: "B", side: "black", username: players.bBlack.username },
  ];
}
