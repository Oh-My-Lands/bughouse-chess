import { Chess } from "chess.js";

import { teamFor } from "@/app/utils/engine/engineMode";
import type {
  BughouseBoardId,
  BughousePositionSnapshot,
  BughouseSide,
} from "@/app/types/analysis";

/**
 * Renders engine moves as algebraic notation for display.
 *
 * This is a presentation concern only. The engine speaks UCI, the client parses
 * UCI, and playing a line into the variation tree needs UCI -- none of that
 * changes. Only the rendered text does.
 *
 * The guiding rule is that a wrong move name is worse than an ugly one: an
 * analysis tool that labels a move incorrectly is actively misleading, whereas
 * one that falls back to `d1e2` is merely harder to read. So every conversion
 * that cannot be verified against a real position falls back to the raw UCI.
 */

/** "sit" is a real bughouse action, not a missing move. */
export const SIT_LABEL = "sit";

/**
 * Rendered when a player had no move to make because it was not their turn.
 *
 * The engine emits MOVE_NONE for both "chose to wait" and "could not move", but
 * they are completely different things: one is a decision the search evaluated,
 * the other is turn order. Showing "sit" for both implies an agency that is not
 * there, and makes a line look like it is stalling when it is simply waiting for
 * the other player on that board.
 */
export const NOT_ON_TURN_LABEL = "—";

type Colour = "w" | "b";

/** The colours the analysed team holds on each board. */
export interface TeamColours {
  a: Colour;
  b: Colour;
}

/**
 * Which colour the analysed team plays on each board.
 *
 * Bughouse teams are diagonal, so this is not the same colour on both boards.
 * Derived from teamFor rather than recomputed, to keep one definition of who
 * partners whom.
 */
export function teamColoursFor(
  board: BughouseBoardId,
  side: BughouseSide,
): TeamColours {
  return teamFor(board, side) === "AWhite_BBlack"
    ? { a: "w", b: "b" }
    : { a: "b", b: "w" };
}

/**
 * Drops are already algebraic. Crazyhouse/bughouse notation writes them as
 * `P@e6`, which is what the engine emits and what a player expects to read, so
 * they pass through with the piece letter normalised.
 */
function formatDrop(uci: string): string | null {
  const drop = uci.match(/^([A-Za-z])@([a-h][1-8])$/);
  return drop ? `${drop[1].toUpperCase()}@${drop[2]}` : null;
}

/**
 * Converts one UCI move to SAN in the context of `fen`.
 *
 * Returns the raw UCI unchanged if the position will not load, the move is not
 * legal there, or the move is not in UCI shape — never a guess.
 */
export function uciToSan(uci: string, fen: string): string {
  const drop = formatDrop(uci);
  if (drop) return drop;

  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.slice(4, 5).toLowerCase();
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return uci;

  try {
    const chess = new Chess(fen);
    const move = chess.move(
      promotion ? { from, to, promotion } : { from, to },
    );
    return move?.san ?? uci;
  } catch {
    // Bughouse positions can be illegal for standard chess (drops produce
    // material standard rules cannot), so this is an expected path, not a bug.
    return uci;
  }
}

/** The board's plain FEN from a snapshot. */
export function fenForBoard(
  position: BughousePositionSnapshot,
  board: BughouseBoardId,
): string {
  return board === "A" ? position.fenA : position.fenB;
}

/** Converts the candidate move on the analysed board, or "sit". */
export function candidateToSan(
  move: string | null,
  board: BughouseBoardId,
  position: BughousePositionSnapshot | null,
): string {
  if (move === null) return SIT_LABEL;
  if (!position) return move;
  return uciToSan(move, fenForBoard(position, board));
}

export interface JointPly {
  a: string | null;
  b: string | null;
}

/**
 * Converts a whole principal variation, replaying each board to keep the
 * context correct for later plies.
 *
 * The two boards are replayed independently: a PV entry is a joint action, and
 * a `null` half means that board simply did not move on that ply, so its side
 * to move is unchanged.
 *
 * Replay stops for a board the moment a ply cannot be applied — most often a
 * drop, which chess.js has no concept of, and which also changes material in a
 * way the replay cannot track. From that point on the board emits raw UCI,
 * because every position after an unapplied move is wrong and any SAN derived
 * from it would be fiction.
 */
export function pvToSan(
  pv: readonly JointPly[],
  position: BughousePositionSnapshot | null,
  teamColours: TeamColours | null = null,
): Array<{ a: string; b: string }> {
  /**
   * Distinguishes a chosen wait from a forced one.
   *
   * Plies alternate teams -- the PV opens with the analysed team -- so on odd
   * plies the colours belong to the opponents. A board's turn only advances
   * when a move is played on it, so comparing the replayed side to move against
   * whoever was due to act on that ply says whether a move was even possible.
   *
   * Falls back to "sit" whenever it cannot be sure: without team colours, or
   * once the replay has desynced and the side to move is no longer known.
   */
  const noMoveLabel = (
    key: "a" | "b",
    index: number,
    chess: Chess | null,
  ): string => {
    if (!teamColours || !chess) return SIT_LABEL;
    const mine = teamColours[key];
    const due = index % 2 === 0 ? mine : mine === "w" ? "b" : "w";
    return chess.turn() === due ? SIT_LABEL : NOT_ON_TURN_LABEL;
  };

  const boards: Record<"a" | "b", { chess: Chess | null }> = {
    a: { chess: null },
    b: { chess: null },
  };

  if (position) {
    for (const [key, fen] of [
      ["a", position.fenA],
      ["b", position.fenB],
    ] as const) {
      try {
        boards[key].chess = new Chess(fen);
      } catch {
        boards[key].chess = null; // unloadable: fall back for this whole board
      }
    }
  }

  return pv.map((ply, index) =>
    (["a", "b"] as const).reduce(
      (acc, key) => {
        const uci = ply[key];
        if (uci === null) {
          acc[key] = noMoveLabel(key, index, boards[key].chess);
          return acc;
        }

        const state = boards[key];
        if (state.chess === null) {
          acc[key] = uci; // already desynced, or never loaded
          return acc;
        }

        const drop = formatDrop(uci);
        if (drop) {
          // chess.js cannot apply a drop, so the replay is over for this board.
          state.chess = null;
          acc[key] = drop;
          return acc;
        }

        try {
          const move = state.chess.move({
            from: uci.slice(0, 2),
            to: uci.slice(2, 4),
            ...(uci.slice(4, 5) ? { promotion: uci.slice(4, 5).toLowerCase() } : {}),
          });
          acc[key] = move?.san ?? uci;
          if (!move) state.chess = null;
        } catch {
          state.chess = null;
          acc[key] = uci;
        }
        return acc;
      },
      { a: "", b: "" } as { a: string; b: string },
    ),
  );
}
