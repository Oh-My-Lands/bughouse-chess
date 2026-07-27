import { describe, expect, it } from "vitest";

import type { EngineLine } from "@/app/utils/engine/engineClient";
import {
  MIN_VISITS,
  THRESHOLD_SCAN,
  detectMistake,
  methodologyCaveats,
} from "@/app/utils/review/detectMistake";

/**
 * Line fixtures are shaped after real 20k output (see
 * `scripts/phase1-noise-20k.raw.json`); only the fields the detector reads are
 * varied.
 */
function line(partial: Partial<EngineLine> & { move: string | null }): EngineLine {
  return {
    multipv: 1,
    partnerMove: null,
    q: 0,
    visits: 10_000,
    prior: 0.3,
    scoreCentipawns: null,
    mateIn: null,
    depth: 12,
    pv: [],
    ...partial,
  };
}

describe("detectMistake", () => {
  it("flags a played move that loses more than the threshold", () => {
    const lines = [
      line({ move: "e2e4", q: 0.12, multipv: 1 }),
      line({ move: "a2a3", q: 0.05, multipv: 2 }),
    ];

    const verdict = detectMistake(lines, "a2a3");

    expect(verdict.kind).toBe("mistake");
    expect(verdict.promote).toBe(true);
    if (verdict.kind !== "mistake") throw new Error("unreachable");
    expect(verdict.loss).toBeCloseTo(0.07, 10);
    expect(verdict.reference.move).toBe("e2e4");
  });

  it("passes a played move within the threshold", () => {
    const lines = [
      line({ move: "e2e4", q: 0.12, multipv: 1 }),
      line({ move: "d2d4", q: 0.112, multipv: 2 }),
    ];

    const verdict = detectMistake(lines, "d2d4");

    expect(verdict.kind).toBe("ok");
    expect(verdict.promote).toBe(false);
  });

  it("does not flag a loss exactly at the measured 20k noise ceiling", () => {
    // 0.0124 was the worst run-to-run `loss` spread observed at >=500 visits.
    // A detector that flagged it would be reporting search nondeterminism.
    const lines = [
      line({ move: "e2e4", q: 0.12, multipv: 1 }),
      line({ move: "d2d4", q: 0.12 - 0.0124, multipv: 2 }),
    ];

    expect(detectMistake(lines, "d2d4").kind).toBe("ok");
  });

  describe("the reference line", () => {
    it("is the highest-q trusted line, not rank 1", () => {
      // Measured in three of six benchmark positions: rank 1 follows visits,
      // so the engine's choice can carry a lower q than a sibling's.
      const lines = [
        line({ move: "f5h4", q: 0.20, visits: 11_103, multipv: 1 }),
        line({ move: "f5d4", q: 0.26, visits: 4_801, multipv: 2 }),
        line({ move: "g7g6", q: 0.10, visits: 600, multipv: 3 }),
      ];

      const verdict = detectMistake(lines, "g7g6");

      if (verdict.kind !== "mistake") throw new Error("expected a mistake");
      expect(verdict.reference.move).toBe("f5d4");
      expect(verdict.loss).toBeCloseTo(0.16, 10);
    });

    it("never yields a negative loss when the played move beats rank 1", () => {
      const lines = [
        line({ move: "f5h4", q: 0.20, visits: 11_103, multipv: 1 }),
        line({ move: "f5d4", q: 0.26, visits: 4_801, multipv: 2 }),
      ];

      const verdict = detectMistake(lines, "f5d4");

      expect(verdict.kind).toBe("ok");
      if (verdict.kind !== "ok") throw new Error("unreachable");
      expect(verdict.loss).toBe(0);
    });

    it("ignores an untrusted line even when its q is the highest", () => {
      // A 1-visit line's q is the raw network eval. Letting it set the
      // reference would manufacture a loss against a number no search backs.
      const lines = [
        line({ move: "e2e4", q: 0.12, visits: 9_377, multipv: 1 }),
        line({ move: "d2d4", q: 0.115, visits: 8_366, multipv: 2 }),
        line({ move: "a2a4", q: 0.90, visits: 5, multipv: 3 }),
      ];

      const verdict = detectMistake(lines, "d2d4");

      expect(verdict.kind).toBe("ok");
      if (verdict.kind !== "ok") throw new Error("unreachable");
      expect(verdict.reference.move).toBe("e2e4");
    });
  });

  describe("promotion to the deep pass", () => {
    it("promotes a played move absent from the reported lines", () => {
      const lines = [
        line({ move: "d8e8", q: 0.3, multipv: 1 }),
        line({ move: "d7b5", q: 0.1, multipv: 2 }),
      ];

      const verdict = detectMistake(lines, "b4c3");

      expect(verdict.kind).toBe("unexplored");
      expect(verdict.promote).toBe(true);
      expect(verdict.playedRank).toBeNull();
    });

    it("promotes a played move with too few visits rather than scoring it", () => {
      const lines = [
        line({ move: "e1d2", q: 0.4, visits: 10_209, multipv: 1 }),
        line({ move: "a2a3", q: 0.1, visits: MIN_VISITS - 1, multipv: 2 }),
      ];

      const verdict = detectMistake(lines, "a2a3");

      // The q gap here is 0.3 -- far past the threshold -- but the measured
      // spread at this visit count reaches 0.09, so the number is not readable.
      expect(verdict.kind).toBe("low-confidence");
      expect(verdict.promote).toBe(true);
    });

    it("scores a played move exactly at the visits gate", () => {
      const lines = [
        line({ move: "e1d2", q: 0.4, visits: 10_209, multipv: 1 }),
        line({ move: "a2a3", q: 0.1, visits: MIN_VISITS, multipv: 2 }),
      ];

      expect(detectMistake(lines, "a2a3").kind).toBe("mistake");
    });

    it("treats an empty ranking as unexplored", () => {
      expect(detectMistake([], "e2e4").kind).toBe("unexplored");
    });
  });

  it("ranks and scores a sit, which is a real action in bughouse", () => {
    const lines = [
      line({ move: null, q: 0.30, multipv: 1 }),
      line({ move: "e2e4", q: 0.28, multipv: 2 }),
    ];

    const verdict = detectMistake(lines, null);

    expect(verdict.kind).toBe("ok");
    expect(verdict.playedRank).toBe(1);
  });

  it("records the played move's rank so multipv can be chosen from evidence", () => {
    const lines = [
      line({ move: "e2e4", q: 0.12, multipv: 1 }),
      line({ move: "d2d4", q: 0.11, multipv: 2 }),
      line({ move: "b1c3", q: 0.11, multipv: 7 }),
    ];

    expect(detectMistake(lines, "b1c3").playedRank).toBe(7);
  });

  it("honours overridden thresholds", () => {
    const lines = [
      line({ move: "e2e4", q: 0.12, multipv: 1 }),
      line({ move: "d2d4", q: 0.11, multipv: 2 }),
    ];

    expect(detectMistake(lines, "d2d4").kind).toBe("ok");
    expect(detectMistake(lines, "d2d4", { threshold: 0.005 }).kind).toBe("mistake");
  });

  it("uses a scan threshold above the measured noise floor", () => {
    // Guards the constant itself: the 0.02 figure inherited from 50k
    // measurements, and anything below 0.0124, both report noise at 20k.
    expect(THRESHOLD_SCAN).toBeGreaterThan(0.0124);
  });
});

describe("methodologyCaveats", () => {
  it("names the assumed partner move behind a joint-action q", () => {
    const lines = [
      line({ move: "e2e4", q: 0.12, partnerMove: "d7d5", multipv: 1 }),
      line({ move: "d2d4", q: 0.05, partnerMove: "g8f6", multipv: 2 }),
    ];

    const caveats = methodologyCaveats(detectMistake(lines, "d2d4"));

    expect(caveats.join(" ")).toContain("g8f6");
  });

  it("flags a position whose place in the timeline came from a tie-break", () => {
    const lines = [
      line({ move: "e2e4", q: 0.12, multipv: 1 }),
      line({ move: "d2d4", q: 0.05, multipv: 2 }),
    ];

    const verdict = detectMistake(lines, "d2d4", { orderingAmbiguous: true });

    expect(verdict.orderingAmbiguous).toBe(true);
    expect(methodologyCaveats(verdict).join(" ")).toContain("one move out");
  });

  it("says nothing when neither caveat applies", () => {
    const lines = [line({ move: "e2e4", q: 0.12, multipv: 1 })];

    expect(methodologyCaveats(detectMistake(lines, "e2e4"))).toEqual([]);
  });
});

describe("the reference and played-move gates are separate", () => {
  /**
   * Ply 91 of the reviewed game, from its cached 200k search. The played move
   * was sampled 335 times and abandoned -- the search's verdict, not missing
   * information -- while a single gate discarded it as unreadable.
   */
  const ply91 = [
    line({ move: "b4d6", q: 0.2815, visits: 141_198, multipv: 1 }),
    line({ move: null, q: 0.2884, visits: 57_954, multipv: 2 }),
    line({ move: "f2e3", q: -0.1170, visits: 335, multipv: 3 }),
  ];

  it("drops a real finding when one gate covers both roles", () => {
    expect(detectMistake(ply91, "f2e3").kind).toBe("low-confidence");
  });

  it("scores it once the played move is ungated", () => {
    const verdict = detectMistake(ply91, "f2e3", { playedMinVisits: 0 });

    expect(verdict.kind).toBe("mistake");
    if (verdict.kind !== "mistake") throw new Error("unreachable");
    // Would be the largest finding in the game; the reported blunder is 0.2247.
    expect(verdict.loss).toBeCloseTo(0.4054, 4);
    // The reference is the sit, which cleared the untouched reference gate.
    expect(verdict.reference.move).toBeNull();
  });

  it("still refuses a low-visit line as the reference", () => {
    // A fluke high-q line on few visits must not set the bar: that invents a
    // loss rather than reporting one.
    const lines = [
      line({ move: "e2e4", q: 0.10, visits: 90_000, multipv: 1 }),
      line({ move: "d2d4", q: 0.09, visits: 40_000, multipv: 2 }),
      line({ move: "a2a4", q: 0.80, visits: 12, multipv: 3 }),
    ];

    const verdict = detectMistake(lines, "d2d4", { playedMinVisits: 0 });

    if (verdict.kind !== "ok") throw new Error("expected ok");
    expect(verdict.reference.move).toBe("e2e4");
    expect(verdict.loss).toBeCloseTo(0.01, 10);
  });

  it("never returns a negative loss when the played move beats every reference", () => {
    const lines = [
      line({ move: "e2e4", q: 0.10, visits: 90_000, multipv: 1 }),
      line({ move: "a2a4", q: 0.30, visits: 12, multipv: 2 }),
    ];

    const verdict = detectMistake(lines, "a2a4", { playedMinVisits: 0 });

    if (verdict.kind !== "ok") throw new Error("expected ok");
    expect(verdict.loss).toBe(0);
  });

  it("reports no-reference when nothing clears the reference gate", () => {
    const lines = [
      line({ move: "e2e4", q: 0.10, visits: 100, multipv: 1 }),
      line({ move: "d2d4", q: 0.02, visits: 80, multipv: 2 }),
    ];

    const verdict = detectMistake(lines, "d2d4", { playedMinVisits: 0 });

    expect(verdict.kind).toBe("no-reference");
    expect(verdict.promote).toBe(true);
  });
});
