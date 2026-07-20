import { describe, expect, it } from "vitest";

import { engineMoveToAttempted, sideToMove } from "@/app/utils/engine/engineMove";
import type { BughousePositionSnapshot } from "@/app/types/analysis";

const WHITE_TO_MOVE = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const BLACK_TO_MOVE = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 3 7";

function snapshot(fenA = WHITE_TO_MOVE, fenB = WHITE_TO_MOVE): BughousePositionSnapshot {
  return {
    fenA,
    fenB,
    reserves: { A: { white: {}, black: {} }, B: { white: {}, black: {} } },
    promotedSquares: { A: [], B: [] },
    captureMaterial: {} as BughousePositionSnapshot["captureMaterial"],
  };
}

describe("sideToMove", () => {
  it("reads each board independently", () => {
    // Boards have independent turns in bughouse.
    const position = snapshot(WHITE_TO_MOVE, BLACK_TO_MOVE);
    expect(sideToMove(position, "A")).toBe("white");
    expect(sideToMove(position, "B")).toBe("black");
  });
});

describe("engineMoveToAttempted", () => {
  it("converts a normal move", () => {
    expect(engineMoveToAttempted("e2e4", "A", snapshot())).toEqual({
      kind: "normal",
      board: "A",
      from: "e2",
      to: "e4",
    });
  });

  it("converts a promotion", () => {
    expect(engineMoveToAttempted("e7e8q", "B", snapshot())).toEqual({
      kind: "normal",
      board: "B",
      from: "e7",
      to: "e8",
      promotion: "q",
    });
  });

  it("omits promotion when there is none", () => {
    const got = engineMoveToAttempted("e2e4", "A", snapshot());
    expect(got).not.toHaveProperty("promotion");
  });

  it("converts a drop and takes the side from whoever is to move", () => {
    expect(engineMoveToAttempted("P@e6", "A", snapshot())).toEqual({
      kind: "drop",
      board: "A",
      side: "white",
      piece: "p",
      to: "e6",
    });

    expect(
      engineMoveToAttempted("N@f7", "B", snapshot(WHITE_TO_MOVE, BLACK_TO_MOVE)),
    ).toEqual({
      kind: "drop",
      board: "B",
      side: "black",
      piece: "n",
      to: "f7",
    });
  });

  it("returns null for a sit", () => {
    // Sit is a real action with no from/to squares, so it has no half-move
    // representation and cannot become a variation.
    expect(engineMoveToAttempted(null, "A", snapshot())).toBeNull();
  });

  describe("malformed input returns null rather than throwing", () => {
    // This runs on engine output inside a click handler; a throw would take the
    // panel down.
    it.each([
      ["empty string", ""],
      ["too short", "e2"],
      ["off-board square", "e2j9"],
      ["king drop", "K@e4"],
      ["bad promotion piece", "e7e8k"],
      ["nonsense", "not-a-move"],
    ])("%s", (_label, move) => {
      expect(engineMoveToAttempted(move, "A", snapshot())).toBeNull();
    });
  });
});
