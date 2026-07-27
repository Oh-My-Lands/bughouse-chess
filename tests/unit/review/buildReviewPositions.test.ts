import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ChessGame } from "@/app/actions";
import type { BughouseMove } from "@/app/types/bughouse";
import { processGameData } from "@/app/utils/board/moveOrdering";
import { buildReviewPositions } from "@/app/utils/review/buildReviewPositions";

const FIXTURES = join(process.cwd(), "tests/fixtures/chesscom");

function loadPair(idA: string, idB: string) {
  const read = (id: string) =>
    JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), "utf8")) as ChessGame;
  return processGameData(read(idA), read(idB));
}

function move(partial: Partial<BughouseMove> & { move: string }): BughouseMove {
  return {
    board: "A",
    side: "white",
    moveNumber: 1,
    timestamp: 0,
    ...partial,
  };
}

describe("buildReviewPositions", () => {
  it("collects only the reviewed player's moves", () => {
    const moves: BughouseMove[] = [
      move({ board: "A", side: "white", move: "e4", timestamp: 10 }),
      move({ board: "B", side: "white", move: "d4", timestamp: 20 }),
      move({ board: "A", side: "black", move: "e5", timestamp: 30 }),
      move({ board: "A", side: "white", move: "Nf3", timestamp: 40 }),
    ];

    const { positions, replayError } = buildReviewPositions(moves, {
      board: "A",
      side: "white",
    });

    expect(replayError).toBeNull();
    expect(positions.map((p) => p.san)).toEqual(["e4", "Nf3"]);
    expect(positions.map((p) => p.globalPly)).toEqual([0, 3]);
  });

  it("snapshots the position before the move, not after", () => {
    const moves = [move({ move: "e4", timestamp: 10 })];

    const { positions } = buildReviewPositions(moves, {
      board: "A",
      side: "white",
    });

    // The pawn is still on e2: this is the position the engine must search for
    // the played move to be one of the candidates it ranks.
    expect(positions[0].position.fenA).toContain(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
    );
    expect(positions[0].playedMove).toBe("e2e4");
  });

  describe("engine spelling of the played move", () => {
    it("renders a normal move as UCI", () => {
      const { positions } = buildReviewPositions([move({ move: "Nf3" })], {
        board: "A",
        side: "white",
      });

      expect(positions[0].playedMove).toBe("g1f3");
    });

    it("renders a drop in the engine's piece@square form", () => {
      // Taken from a real game rather than a constructed one: a drop needs a
      // reserve, and a reserve needs the partner board to have made the right
      // captures first, which is exactly the state a hand-written sequence
      // gets wrong.
      const processed = loadPair("160842422747", "160842422749");
      const { positions } = buildReviewPositions(processed.combinedMoves, {
        board: "A",
        side: "white",
      });

      const drops = positions.filter((p) => p.playedMove.includes("@"));

      expect(drops.length).toBeGreaterThan(0);
      // Uppercase piece, `@`, square -- what `uci_parse` and the engine expect.
      for (const drop of drops) {
        expect(drop.playedMove).toMatch(/^[PNBRQ]@[a-h][1-8]$/);
      }
    });
  });

  describe("ordering ambiguity", () => {
    it("flags a cross-board dead heat", () => {
      const moves: BughouseMove[] = [
        move({ board: "B", side: "white", move: "d4", timestamp: 50 }),
        move({ board: "A", side: "white", move: "e4", timestamp: 50 }),
      ];

      const { positions } = buildReviewPositions(moves, {
        board: "A",
        side: "white",
      });

      expect(positions[0].orderingAmbiguous).toBe(true);
    });

    it("does not flag a same-board tie, whose order is fixed regardless", () => {
      const moves: BughouseMove[] = [
        move({ board: "A", side: "white", move: "e4", timestamp: 50 }),
        move({ board: "A", side: "black", move: "e5", timestamp: 50 }),
        move({ board: "A", side: "white", move: "Nf3", timestamp: 50 }),
      ];

      const { positions } = buildReviewPositions(moves, {
        board: "A",
        side: "white",
      });

      expect(positions.map((p) => p.orderingAmbiguous)).toEqual([false, false]);
    });
  });

  describe("replay failures", () => {
    it("returns the positions built so far alongside the error", () => {
      const moves: BughouseMove[] = [
        move({ move: "e4", timestamp: 10 }),
        move({ side: "black", move: "e5", timestamp: 20 }),
        move({ move: "Qz9", timestamp: 30 }),
      ];

      const { positions, replayError } = buildReviewPositions(moves, {
        board: "A",
        side: "white",
      });

      expect(positions).toHaveLength(1);
      expect(replayError).toContain("ply 2");
    });
  });

  describe("against recorded games", () => {
    it("replays a real game end to end and matches the Phase 0 count", () => {
      const processed = loadPair("160842422747", "160842422749");

      const { positions, replayError } = buildReviewPositions(
        processed.combinedMoves,
        { board: "A", side: "white" },
      );

      expect(replayError).toBeNull();
      // Phase 0 measured 107 combined plies for this pair, 57 on board A.
      expect(processed.combinedMoves).toHaveLength(107);
      // 29 is also the median one-player review size measured across all 41
      // recorded pairs, so this game is a representative one to cost against.
      expect(positions).toHaveLength(29);
      expect(positions.every((p) => p.playedMove.length > 0)).toBe(true);
    });

    it("replays a game that ends in checkmate", () => {
      // The losing board is mated while the other board may still have a move
      // in flight; the replay must not stop there.
      const processed = loadPair("161528221791", "161528221793");

      const { replayError } = buildReviewPositions(processed.combinedMoves, {
        board: "A",
        side: "white",
      });

      expect(replayError).toBeNull();
    });
  });
});
