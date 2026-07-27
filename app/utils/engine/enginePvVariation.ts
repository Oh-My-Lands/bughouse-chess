import { validateAndApplyBughouseHalfMove } from "@/app/utils/analysis/applyMove";
import type { PieceValuePreset } from "@/app/utils/analysis/captureMaterial";
import { engineMoveToAttempted } from "@/app/utils/engine/engineMove";
import type { EngineLine } from "@/app/utils/engine/engineClient";
import type {
  BughouseBoardId,
  BughousePositionSnapshot,
  MovePathStep,
} from "@/app/types/analysis";

/**
 * Turns the front of an engine line into a chain of moves the analysis tree can
 * hold, so a candidate can be played into the move list as a variation.
 *
 * The engine searches *joint* actions: every ply of a PV is a move on both
 * boards at once, and the evaluation attached to the line is the value of that
 * joint sequence. So this converts both halves. Taking only the analysed board's
 * moves would build a line the engine never scored -- and would not even stay
 * legal, since a drop on one board is often only possible because the partner
 * captured that piece on the other (see `applyMove`, where captures feed the
 * partner board's reserves).
 *
 * The result is validated against real positions rather than trusted: an engine
 * that disagrees with our board about a position should leave the user with a
 * short variation, not a corrupt tree.
 */

/** One ply of a PV: what each board does, `null` for a board that does not move. */
type PvPly = { a: string | null; b: string | null };

export interface EngineLineMovePath {
  /** The validated chain, ready for `applyMovePath`. */
  steps: MovePathStep[];
  /**
   * How many plies of the requested prefix made it in.
   *
   * Below the requested count when the line stopped being playable -- an
   * illegal move, or a position our validator considers finished. The caller
   * decides whether a short line is worth mentioning; it is always the *prefix*
   * that survives, never a line with a hole in it.
   */
  completedPlies: number;
}

/**
 * The line's own plies, or the candidate alone when the search reported no PV.
 *
 * `move` and `pv[0]` are the same move in practice, so the PV is preferred and
 * the candidate is only a fallback -- it keeps a one-move click working against
 * a result that carries a bare move.
 */
function pliesFor(
  line: Pick<EngineLine, "move" | "pv">,
  board: BughouseBoardId,
): readonly PvPly[] {
  if (line.pv.length > 0) return line.pv;
  if (line.move === null) return [];
  return [
    {
      a: board === "A" ? line.move : null,
      b: board === "B" ? line.move : null,
    },
  ];
}

/**
 * The two boards' moves for one ply, analysed board first.
 *
 * `null` is dropped rather than treated as a failure: it means the board did not
 * move that ply -- either a sit or a player who was not on turn -- and the tree
 * represents both the same way, by having no edge there.
 */
function entriesFor(
  ply: PvPly,
  board: BughouseBoardId,
): { board: BughouseBoardId; uci: string }[] {
  const partner: BughouseBoardId = board === "A" ? "B" : "A";
  return [
    { board, uci: board === "A" ? ply.a : ply.b },
    { board: partner, uci: partner === "A" ? ply.a : ply.b },
  ].filter((entry): entry is { board: BughouseBoardId; uci: string } =>
    entry.uci !== null,
  );
}

/**
 * Applies one ply's moves in the given order, or reports that the order fails.
 *
 * All or nothing: a partially applied ply would put half a joint action in the
 * tree, so the caller can try the other order from an untouched position.
 */
function applyOrder(
  entries: readonly { board: BughouseBoardId; uci: string }[],
  from: BughousePositionSnapshot,
  pieceValuePreset: PieceValuePreset | undefined,
): MovePathStep[] | null {
  const steps: MovePathStep[] = [];
  let position = from;

  for (const entry of entries) {
    const attempted = engineMoveToAttempted(entry.uci, entry.board, position);
    if (!attempted) return null;

    const applied = validateAndApplyBughouseHalfMove(position, attempted, {
      pieceValuePreset,
    });
    if (applied.type !== "ok") return null;

    steps.push({ move: applied.move, next: applied.next });
    position = applied.next;
  }

  return steps;
}

/**
 * The first `plyCount` plies of `line`, as a validated chain from `from`.
 *
 * @param plyCount 1-based: 1 is the candidate move itself, and every ply after
 * that adds both boards' moves for that ply.
 * @param board The board the line was analysed for. Its move goes into the tree
 * first within each ply, with the partner's second.
 */
export function engineLineToMovePath(
  line: Pick<EngineLine, "move" | "pv">,
  plyCount: number,
  board: BughouseBoardId,
  from: BughousePositionSnapshot,
  options?: { pieceValuePreset?: PieceValuePreset },
): EngineLineMovePath {
  const prefix = pliesFor(line, board).slice(0, Math.max(0, plyCount));
  const steps: MovePathStep[] = [];
  let position = from;
  let completedPlies = 0;

  for (const ply of prefix) {
    const entries = entriesFor(ply, board);
    // Order matters inside a ply, and only one order may be legal: a drop needs
    // the capture that feeds it to have happened first. The two boards move
    // simultaneously, so neither order is more faithful than the other -- try
    // the analysed board first and fall back, the way loading a game already
    // resolves simultaneous moves (see reorderSimultaneousCheckmateMove).
    const orders =
      entries.length === 2 ? [entries, [entries[1], entries[0]]] : [entries];

    let applied: MovePathStep[] | null = null;
    for (const order of orders) {
      applied = applyOrder(order, position, options?.pieceValuePreset);
      if (applied) break;
    }
    // Unplayable ply: keep the prefix that worked rather than skipping ahead,
    // which would show a line the engine never suggested.
    if (!applied) break;

    steps.push(...applied);
    position = applied.at(-1)?.next ?? position;
    completedPlies += 1;
  }

  return { steps, completedPlies };
}
