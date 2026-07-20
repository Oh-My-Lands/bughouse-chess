import type {
  BughousePositionSnapshot,
  BughouseBoardId,
} from "@/app/types/analysis";
import type { PieceReserves } from "@/app/types/bughouse";

/**
 * Translates between this app's position model and the dual FEN that the
 * Hivemind engine (Fairy-Stockfish "bughouse" variant) expects.
 *
 * The two models differ in three ways, all handled here:
 *
 *  1. We keep `reserves` beside the FEN; the engine wants them inline, in a
 *     `[...]` bracket appended to the piece placement field.
 *  2. We keep `promotedSquares` as a square list; the engine marks them with a
 *     `~` suffix on the piece.
 *  3. We keep two independent FENs; the engine wants them joined by `|`.
 *
 * Everything asserted below about the engine's dialect was verified by round
 * tripping candidate strings through the built engine rather than assumed:
 *
 *  - `[]` is emitted even when the pocket is empty, but omitting it on input is
 *    accepted (the engine's own startingFen has no bracket).
 *  - A `/pocket` suffix is accepted as an alternative to brackets on input, but
 *    brackets are what it emits. We always emit brackets.
 *  - Canonical pocket order is white then black, each descending by piece value
 *    (QRBNP). We match it so output is stable and comparable.
 *  - `~` IS parsed on input and reaches the network (it feeds planes 22-23 and
 *    54-55 via promotedPieces), but the engine's own fen() never prints it.
 *    So promoted state survives the trip *into* the engine, and cannot be read
 *    back out of an engine-produced FEN. See fromEngineFen.
 *  - A malformed FEN does NOT raise; the engine silently builds a nonsense
 *    position from whatever it could parse. That makes validation our job,
 *    hence the throws below.
 */

/** Piece letters in the engine's canonical pocket order, high value first. */
const CANONICAL_PIECE_ORDER = ["q", "r", "b", "n", "p"] as const;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

export class BughouseFenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BughouseFenError";
  }
}

/**
 * Encodes one side's reserve as pocket letters, in canonical order.
 * White pieces are uppercase, black lowercase.
 */
function encodePocketFor(
  counts: { [piece: string]: number },
  upper: boolean,
): string {
  let out = "";
  for (const piece of CANONICAL_PIECE_ORDER) {
    const n = counts[piece] ?? 0;
    if (n < 0 || !Number.isInteger(n)) {
      throw new BughouseFenError(
        `Reserve count for '${piece}' must be a non-negative integer, got ${n}`,
      );
    }
    out += (upper ? piece.toUpperCase() : piece).repeat(n);
  }
  return out;
}

/**
 * Walks a placement field and returns, for each rank-major square in order, the
 * index into the field where that square's piece character sits (or -1 for an
 * empty square). Digits expand to that many empty squares.
 */
function indexPlacementSquares(placement: string): Map<string, number> {
  const squareToIndex = new Map<string, number>();
  let rank = 8;
  let file = 0;

  for (let i = 0; i < placement.length; i++) {
    const ch = placement[i];

    if (ch === "/") {
      if (file !== 8) {
        throw new BughouseFenError(
          `Rank ${rank} has ${file} squares, expected 8, in "${placement}"`,
        );
      }
      rank -= 1;
      file = 0;
      continue;
    }

    if (ch >= "1" && ch <= "8") {
      file += Number(ch);
      continue;
    }

    if (!/[pnbrqkPNBRQK]/.test(ch)) {
      throw new BughouseFenError(
        `Unexpected character '${ch}' in placement "${placement}"`,
      );
    }

    if (file > 7 || rank < 1) {
      throw new BughouseFenError(
        `Placement overflows the board at index ${i} in "${placement}"`,
      );
    }

    squareToIndex.set(`${FILES[file]}${rank}`, i);
    file += 1;
  }

  if (rank !== 1 || file !== 8) {
    throw new BughouseFenError(
      `Placement ended on rank ${rank} file ${file}, expected 8 full ranks, in "${placement}"`,
    );
  }

  return squareToIndex;
}

/** Inserts `~` after the piece on each promoted square. */
function markPromoted(placement: string, promoted: readonly string[]): string {
  if (promoted.length === 0) return placement;

  const squareToIndex = indexPlacementSquares(placement);

  // Collect target indices first, then splice from the back, so earlier indices
  // stay valid as the string grows.
  const insertAfter: number[] = [];
  for (const square of promoted) {
    const idx = squareToIndex.get(square);
    if (idx === undefined) {
      throw new BughouseFenError(
        `Promoted square ${square} is empty or off-board in "${placement}"`,
      );
    }
    insertAfter.push(idx);
  }
  insertAfter.sort((a, b) => b - a);

  let out = placement;
  for (const idx of insertAfter) {
    out = `${out.slice(0, idx + 1)}~${out.slice(idx + 1)}`;
  }
  return out;
}

/**
 * Builds the engine FEN for a single board.
 *
 * @param fen Plain chess.js FEN, with no pocket bracket and no `~` markers.
 * @param reserves Reserve counts for this board, per side.
 * @param promoted Squares currently holding a promoted piece on this board.
 */
export function toEngineBoardFen(
  fen: string,
  reserves: { white: { [p: string]: number }; black: { [p: string]: number } },
  promoted: readonly string[] = [],
): string {
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6) {
    throw new BughouseFenError(
      `Expected 6 FEN fields, got ${fields.length}: "${fen}"`,
    );
  }

  const [placement, stm, castling, ep, halfmove, fullmove] = fields;

  if (placement.includes("[") || placement.includes("~")) {
    throw new BughouseFenError(
      `Placement already carries engine markup; expected a plain FEN: "${fen}"`,
    );
  }
  if (stm !== "w" && stm !== "b") {
    throw new BughouseFenError(`Side to move must be w or b, got "${stm}"`);
  }

  const marked = markPromoted(placement, promoted);
  const pocket =
    encodePocketFor(reserves.white, true) + encodePocketFor(reserves.black, false);

  return `${marked}[${pocket}] ${stm} ${castling} ${ep} ${halfmove} ${fullmove}`;
}

/**
 * Builds the full dual FEN, board A then board B, joined by `|`.
 */
export function toEngineFen(snapshot: BughousePositionSnapshot): string {
  const a = toEngineBoardFen(
    snapshot.fenA,
    snapshot.reserves.A,
    snapshot.promotedSquares.A,
  );
  const b = toEngineBoardFen(
    snapshot.fenB,
    snapshot.reserves.B,
    snapshot.promotedSquares.B,
  );
  return `${a}|${b}`;
}

export interface ParsedEngineBoard {
  /** Plain FEN, pocket bracket and `~` markers removed. */
  fen: string;
  reserves: { white: { [p: string]: number }; black: { [p: string]: number } };
  promotedSquares: string[];
}

/**
 * Inverse of toEngineBoardFen.
 *
 * Note this parses OUR encoding, which is lossless. It is not a general reader
 * for engine output: the engine's fen() drops `~`, so a FEN it produced will
 * always come back with an empty promotedSquares regardless of the real
 * position. Use this to verify our own encoding, not to trust the engine's.
 */
export function fromEngineBoardFen(engineFen: string): ParsedEngineBoard {
  const fields = engineFen.trim().split(/\s+/);
  if (fields.length !== 6) {
    throw new BughouseFenError(
      `Expected 6 FEN fields, got ${fields.length}: "${engineFen}"`,
    );
  }

  const [rawPlacement, ...rest] = fields;

  const open = rawPlacement.indexOf("[");
  let placement = rawPlacement;
  let pocket = "";
  if (open !== -1) {
    if (!rawPlacement.endsWith("]")) {
      throw new BughouseFenError(`Unterminated pocket in "${engineFen}"`);
    }
    placement = rawPlacement.slice(0, open);
    pocket = rawPlacement.slice(open + 1, -1);
  }

  const reserves = {
    white: {} as { [p: string]: number },
    black: {} as { [p: string]: number },
  };
  for (const ch of pocket) {
    if (!/[pnbrqPNBRQ]/.test(ch)) {
      throw new BughouseFenError(`Unexpected pocket character '${ch}'`);
    }
    const side = ch === ch.toUpperCase() ? reserves.white : reserves.black;
    const piece = ch.toLowerCase();
    side[piece] = (side[piece] ?? 0) + 1;
  }

  // Strip `~` and record which squares carried it. Indexing happens on the
  // cleaned placement, so the square mapping is unaffected by the markers.
  const promotedSquares: string[] = [];
  const cleaned = placement.replace(/~/g, "");
  if (placement.includes("~")) {
    const squareToIndex = indexPlacementSquares(cleaned);
    const indexToSquare = new Map<number, string>();
    for (const [square, idx] of squareToIndex) indexToSquare.set(idx, square);

    let cleanIdx = 0;
    for (let i = 0; i < placement.length; i++) {
      if (placement[i] === "~") {
        const square = indexToSquare.get(cleanIdx - 1);
        if (square === undefined) {
          throw new BughouseFenError(
            `Stray '~' at index ${i} in "${placement}"`,
          );
        }
        promotedSquares.push(square);
        continue;
      }
      cleanIdx += 1;
    }
  }

  return {
    fen: [cleaned, ...rest].join(" "),
    reserves,
    promotedSquares,
  };
}

/** Splits a dual FEN and parses both halves. */
export function fromEngineFen(engineFen: string): {
  A: ParsedEngineBoard;
  B: ParsedEngineBoard;
} {
  const halves = engineFen.split("|");
  if (halves.length !== 2) {
    throw new BughouseFenError(
      `Expected two boards separated by '|', got ${halves.length}`,
    );
  }
  return {
    A: fromEngineBoardFen(halves[0]),
    B: fromEngineBoardFen(halves[1]),
  };
}

/**
 * Prefixes a UCI move with its board number, which is how the engine's
 * `position ... moves` list identifies which board a move belongs to
 * ('1' for A, '2' for B).
 */
export function toEngineMove(board: BughouseBoardId, uciMove: string): string {
  return `${board === "A" ? "1" : "2"}${uciMove}`;
}

/** Convenience for callers holding a whole PieceReserves. */
export function reservesForBoard(
  reserves: PieceReserves,
  board: BughouseBoardId,
): { white: { [p: string]: number }; black: { [p: string]: number } } {
  return reserves[board];
}
