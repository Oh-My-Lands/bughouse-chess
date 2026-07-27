import { describe, expect, it } from "vitest";

import type { EngineLine } from "@/app/utils/engine/engineClient";
import { linesWithPlayedMove } from "@/app/utils/engine/engineLines";

/** A ranked line; only `multipv` and `move` matter to the selection. */
function line(multipv: number, move: string | null): EngineLine {
  return {
    multipv,
    move,
    partnerMove: null,
    q: 0,
    visits: 0,
    prior: 0,
    scoreCentipawns: null,
    mateIn: null,
    depth: 0,
    pv: [],
  };
}

/** A five-line ranking, as MultiPV 5 returns. */
const RANKING = ["d2d4", "e2e4", "g1f3", "c2c4", "b1c3"].map((move, i) =>
  line(i + 1, move),
);

describe("linesWithPlayedMove", () => {
  it("shows the top lines when no move was played from here", () => {
    expect(linesWithPlayedMove(RANKING, 3, null).map((l) => l.move)).toEqual([
      "d2d4",
      "e2e4",
      "g1f3",
    ]);
  });

  it("appends the played move when it ranked below the count", () => {
    const lines = linesWithPlayedMove(RANKING, 3, "b1c3");
    expect(lines.map((l) => l.move)).toEqual(["d2d4", "e2e4", "g1f3", "b1c3"]);
  });

  it("keeps the played move's true rank rather than renumbering it", () => {
    // The rank is the point: it says the move was the engine's fifth choice,
    // not its fourth-best line.
    const lines = linesWithPlayedMove(RANKING, 3, "b1c3");
    expect(lines[3].multipv).toBe(5);
  });

  it("does not repeat a played move already among the top lines", () => {
    const lines = linesWithPlayedMove(RANKING, 3, "e2e4");
    expect(lines.map((l) => l.move)).toEqual(["d2d4", "e2e4", "g1f3"]);
  });

  it("leaves out a played move the search never reported", () => {
    // There is no evaluation to show for it, and a blank row would read as one.
    const lines = linesWithPlayedMove(RANKING, 3, "h2h4");
    expect(lines).toHaveLength(3);
  });

  it("sorts by rank before slicing", () => {
    // The slice means "the top N", which the transport's order does not promise.
    const shuffled = [RANKING[2], RANKING[0], RANKING[4], RANKING[1], RANKING[3]];
    expect(linesWithPlayedMove(shuffled, 2, null).map((l) => l.move)).toEqual([
      "d2d4",
      "e2e4",
    ]);
  });

  it("never mutates the ranking it was given", () => {
    const lines = [...RANKING].reverse();
    const before = [...lines];
    linesWithPlayedMove(lines, 2, "d2d4");
    expect(lines).toEqual(before);
  });

  it("does not match a sit against a played move", () => {
    // A sit has no move, and `playedMove` is never null when a move was played;
    // this guards the pairing of the two nulls.
    const withSit = [line(1, null), ...RANKING.slice(1)];
    expect(linesWithPlayedMove(withSit, 1, null).map((l) => l.move)).toEqual([null]);
  });
});
