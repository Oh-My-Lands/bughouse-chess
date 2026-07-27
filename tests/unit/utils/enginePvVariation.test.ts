import { describe, expect, it } from "vitest";

import { engineLineToMovePath } from "@/app/utils/engine/enginePvVariation";
import {
  createInitialPositionSnapshot,
  validateAndApplyBughouseHalfMove,
} from "@/app/utils/analysis/applyMove";
import type {
  AttemptedBughouseHalfMove,
  BughousePositionSnapshot,
} from "@/app/types/analysis";

/** Applies a setup move, failing loudly rather than testing against a wrong position. */
function play(
  position: BughousePositionSnapshot,
  attempted: AttemptedBughouseHalfMove,
): BughousePositionSnapshot {
  const result = validateAndApplyBughouseHalfMove(position, attempted);
  if (result.type !== "ok") {
    throw new Error(`setup move rejected: ${JSON.stringify(attempted)}`);
  }
  return result.next;
}

const START = createInitialPositionSnapshot();

describe("engineLineToMovePath", () => {
  it("takes both boards of a ply, analysed board first", () => {
    // A PV ply is a joint action, and the evaluation shown against it is the
    // value of that joint sequence. Half of it is a line the engine never scored.
    const { steps, completedPlies } = engineLineToMovePath(
      { move: "e2e4", pv: [{ a: "e2e4", b: "d2d4" }] },
      1,
      "A",
      START,
    );

    expect(completedPlies).toBe(1);
    expect(steps.map((step) => [step.move.board, step.move.san])).toEqual([
      ["A", "e4"],
      ["B", "d4"],
    ]);
  });

  it("stops at the requested ply", () => {
    const line = {
      move: "e2e4",
      pv: [
        { a: "e2e4", b: "d2d4" },
        { a: "e7e5", b: "d7d5" },
        { a: "g1f3", b: "g1f3" },
      ],
    };
    const { steps, completedPlies } = engineLineToMovePath(line, 2, "A", START);

    expect(completedPlies).toBe(2);
    expect(steps).toHaveLength(4);
  });

  it("adds nothing for a board that does not move that ply", () => {
    // Null is a sit or a player not on turn. Neither has a half-move, and the
    // tree says so by having no edge there -- it is not a failure.
    const { steps, completedPlies } = engineLineToMovePath(
      { move: "e2e4", pv: [{ a: "e2e4", b: null }] },
      1,
      "A",
      START,
    );

    expect(completedPlies).toBe(1);
    expect(steps).toHaveLength(1);
    expect(steps[0].move.board).toBe("A");
  });

  it("reorders a ply when the partner's capture is what feeds the drop", () => {
    // The case that makes ordering matter: black on A can only drop a pawn
    // because white on B captured one, and both happen in the same ply. Played
    // in the listed order the drop is illegal, so the other order has to be
    // tried before the line is called unplayable.
    let position = play(START, { kind: "normal", board: "A", from: "e2", to: "e4" });
    position = play(position, { kind: "normal", board: "B", from: "e2", to: "e4" });
    position = play(position, { kind: "normal", board: "B", from: "d7", to: "d5" });
    expect(position.reserves.A.black.p ?? 0).toBe(0);

    const { steps, completedPlies } = engineLineToMovePath(
      { move: "P@e6", pv: [{ a: "P@e6", b: "e4d5" }] },
      1,
      "A",
      position,
    );

    expect(completedPlies).toBe(1);
    expect(steps.map((step) => step.move.board)).toEqual(["B", "A"]);
    expect(steps[1].move.san).toBe("P@e6");
  });

  it("keeps the playable prefix when the line stops being legal", () => {
    // The engine and our board can disagree about a position. A short variation
    // is a fine outcome; a tree with a hole in it is not.
    const { steps, completedPlies } = engineLineToMovePath(
      {
        move: "e2e4",
        pv: [
          { a: "e2e4", b: null },
          { a: "e2e4", b: null }, // that pawn has already moved
          { a: "d2d4", b: null },
        ],
      },
      3,
      "A",
      START,
    );

    expect(completedPlies).toBe(1);
    expect(steps).toHaveLength(1);
  });

  it("falls back to the candidate move when the search reported no line", () => {
    const { steps, completedPlies } = engineLineToMovePath(
      { move: "e2e4", pv: [] },
      1,
      "A",
      START,
    );

    expect(completedPlies).toBe(1);
    expect(steps).toHaveLength(1);
    expect(steps[0].move.san).toBe("e4");
  });

  it("has nothing to play for a sit", () => {
    // Sit is the analysed side choosing not to move: a real bughouse action
    // with no half-move, so there is no edge to graft.
    const { steps, completedPlies } = engineLineToMovePath(
      { move: null, pv: [] },
      1,
      "A",
      START,
    );

    expect(steps).toHaveLength(0);
    expect(completedPlies).toBe(0);
  });
});
