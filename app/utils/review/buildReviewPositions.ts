import type {
  BughouseBoardId,
  BughousePositionSnapshot,
  BughouseSide,
} from "@/app/types/analysis";
import type { BughouseMove } from "@/app/types/bughouse";
import {
  createInitialPositionSnapshot,
  validateAndApplyMoveFromNotation,
} from "@/app/utils/analysis/applyMove";
import { halfMoveToUci } from "@/app/utils/engine/engineMove";

/**
 * Turns a loaded game into the list of positions a review has to search.
 *
 * The unit of review is not the move number. Bughouse's two boards interleave
 * in real time, so the sequence a review walks is `combinedMoves` -- one entry
 * per half-move on *either* board, merged by elapsed clock time in
 * `processGameData`. A review of one player is the subset of those entries
 * where that player is to move.
 *
 * Scope is applied here, as a filter over one canonical sequence, and nowhere
 * else. Reviewing a team or all four players later is the same walk with a
 * wider predicate, and because the scopes are disjoint subsets it re-uses
 * every position already searched.
 *
 * Each position is the state *before* the move, which is what makes
 * single-search mistake detection possible: that search ranks every root move
 * it explored, so the best line's `q` and the played move's `q` come from it
 * together. See `detectMistake`.
 */
export interface ReviewPosition {
  /** Index into `combinedMoves`, so a verdict can be traced back to the game. */
  globalPly: number;
  board: BughouseBoardId;
  side: BughouseSide;
  /** The position as it stood *before* the move was played. */
  position: BughousePositionSnapshot;
  /**
   * The move actually played, in the engine's UCI form -- `e2e4`, `e7e8q`, or
   * `P@e6` for a drop. This is what `detectMistake` matches against the
   * engine's reported lines, so it has to be the engine's spelling and not the
   * SAN the game recorded.
   */
  playedMove: string;
  /** As recorded by chess.com, for display next to a verdict. */
  san: string;
  /**
   * True when this entry's place in the interleaved sequence was decided by a
   * tie-break rather than by the clock.
   *
   * `createCombinedMoveList` merges the boards by elapsed time and resolves a
   * dead heat in favour of board A. Measured at 4.7% of positions (median 5 per
   * game). The engine reads both boards, so at a tie the partner board state it
   * evaluates may legitimately be one move out. Carried through to the verdict
   * rather than corrected, because there is nothing here to correct it with.
   */
  orderingAmbiguous: boolean;
}

export interface BuildReviewPositionsResult {
  positions: ReviewPosition[];
  /**
   * Where the replay stopped, if it did.
   *
   * Returned rather than thrown, and alongside the positions built so far. A
   * game that fails to replay at move 40 still yields 39 reviewable positions,
   * and a review of most of a game beats an exception -- but the caller must be
   * able to say the report is partial, so this is not silently swallowed.
   */
  replayError: string | null;
}

/**
 * @param combinedMoves The interleaved timeline from `processGameData`.
 * @param reviewed      Which player's moves to collect positions for.
 */
export function buildReviewPositions(
  combinedMoves: readonly BughouseMove[],
  reviewed: { board: BughouseBoardId; side: BughouseSide },
): BuildReviewPositionsResult {
  const positions: ReviewPosition[] = [];
  let current = createInitialPositionSnapshot();

  for (let index = 0; index < combinedMoves.length; index++) {
    const entry = combinedMoves[index];
    const previous = index > 0 ? combinedMoves[index - 1] : null;

    // Only a cross-board dead heat is ambiguous: two moves on one board have a
    // fixed order whatever the clock says.
    const orderingAmbiguous =
      previous !== null &&
      previous.timestamp === entry.timestamp &&
      previous.board !== entry.board;

    const isReviewed =
      entry.board === reviewed.board && entry.side === reviewed.side;

    const applied = validateAndApplyMoveFromNotation(current, {
      board: entry.board,
      side: entry.side,
      move: entry.move,
      // The game is a record of what happened, so a move that ends the game on
      // the other board must still replay. Without this the walk stops at the
      // first checkmate and loses every later position.
    }, { bypassCheckmateCheck: true });

    if (applied.type !== "ok") {
      const reason =
        applied.type === "error" ? applied.message : "move needs a promotion choice";
      return {
        positions,
        replayError:
          `stopped at ply ${index} (${entry.board}/${entry.side} ${entry.move}): ${reason}`,
      };
    }

    if (isReviewed) {
      positions.push({
        globalPly: index,
        board: entry.board,
        side: entry.side,
        // The snapshot from *before* this move was applied.
        position: current,
        // An edge with neither a normal move nor a drop cannot be spelled; it
        // matches no reported line either way, so the empty string carries that
        // through as a move the engine never ranked.
        playedMove: halfMoveToUci(applied.move) ?? "",
        san: entry.move,
        orderingAmbiguous,
      });
    }

    current = applied.next;
  }

  return { positions, replayError: null };
}
