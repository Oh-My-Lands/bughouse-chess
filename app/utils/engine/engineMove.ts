import type { Square } from "chess.js";

import type {
  AttemptedBughouseHalfMove,
  BughouseBoardId,
  BughousePieceType,
  BughousePositionSnapshot,
  BughousePromotionPiece,
  BughouseSide,
} from "@/app/types/analysis";

/**
 * Converts a move as the engine writes it into the app's attempted-move shape,
 * so an engine suggestion can be played into the variation tree.
 *
 * The engine speaks UCI over the Fairy-Stockfish bughouse variant:
 *
 *   e2e4     normal move
 *   e7e8q    promotion
 *   P@e6     drop from the reserve (piece letter, always uppercase, then @)
 *   null     sit -- see below
 *
 * "Sit" is a real action in bughouse: waiting rather than moving, because
 * moving would help the opponent. It has no from/to squares and no
 * representation in a move tree built from half-moves, so it cannot be played
 * as a variation. Callers get null and should disable the control rather than
 * inventing a move.
 */

const SQUARE = /^[a-h][1-8]$/;
const PROMOTION_PIECES = new Set(["q", "r", "b", "n"]);
const DROPPABLE_PIECES = new Set(["p", "n", "b", "r", "q"]);

/** Reads the side to move for one board out of its FEN. */
export function sideToMove(
  position: BughousePositionSnapshot,
  board: BughouseBoardId,
): BughouseSide {
  const fen = board === "A" ? position.fenA : position.fenB;
  // Field 2 of a FEN is the side to move.
  return fen.trim().split(/\s+/)[1] === "b" ? "black" : "white";
}

/**
 * Parses an engine move for a board.
 *
 * Returns null when the move cannot be represented as a half-move: a sit, or
 * anything malformed. Malformed input returns null rather than throwing
 * because this runs on engine output in a click handler, where a thrown error
 * would take down the panel.
 */
export function engineMoveToAttempted(
  move: string | null,
  board: BughouseBoardId,
  position: BughousePositionSnapshot,
): AttemptedBughouseHalfMove | null {
  if (!move) return null; // sit

  const drop = move.match(/^([A-Za-z])@([a-h][1-8])$/);
  if (drop) {
    const piece = drop[1].toLowerCase();
    if (!DROPPABLE_PIECES.has(piece)) return null;
    return {
      kind: "drop",
      board,
      // Drops come from the reserve of whoever is to move on that board.
      side: sideToMove(position, board),
      piece: piece as BughousePieceType,
      to: drop[2] as Square,
    };
  }

  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  if (!SQUARE.test(from) || !SQUARE.test(to)) return null;

  const promotion = move.slice(4).toLowerCase();
  if (promotion && !PROMOTION_PIECES.has(promotion)) return null;

  return {
    kind: "normal",
    board,
    from: from as Square,
    to: to as Square,
    ...(promotion
      ? { promotion: promotion as BughousePromotionPiece }
      : {}),
  };
}
