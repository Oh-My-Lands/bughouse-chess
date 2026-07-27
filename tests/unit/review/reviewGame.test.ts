import { describe, expect, it, vi } from "vitest";

import type { EngineLine } from "@/app/utils/engine/engineClient";
import type { ReviewPosition } from "@/app/utils/review/buildReviewPositions";
import { MIN_VISITS } from "@/app/utils/review/detectMistake";
import {
  DEEP_NODES,
  SCAN_NODES,
  gradedMistakesFrom,
  mistakesFrom,
  referenceMinVisitsFor,
  reviewGame,
  THRESHOLD_DEEP,
  type AnalyzePosition,
} from "@/app/utils/review/reviewGame";

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

function position(playedMove: string, globalPly = 0): ReviewPosition {
  return {
    globalPly,
    board: "A",
    side: "white",
    position: {} as ReviewPosition["position"],
    playedMove,
    san: playedMove,
    orderingAmbiguous: false,
  };
}

/** Best move `e2e4` at q 0.12; the played move's q is whatever is passed. */
function ranking(playedMove: string, playedQ: number, visits = 10_000) {
  return [
    line({ move: "e2e4", q: 0.12, multipv: 1 }),
    line({ move: playedMove, q: playedQ, visits, multipv: 2 }),
  ];
}

describe("reviewGame", () => {
  it("scans every position and deepens only the promoted ones", async () => {
    const positions = [
      position("d2d4", 0), // fine
      position("a2a3", 1), // a mistake
      position("b2b3", 2), // fine
    ];

    const analyze = vi.fn<AnalyzePosition>(async (p) =>
      p.playedMove === "a2a3" ? ranking("a2a3", 0.02) : ranking(p.playedMove, 0.118),
    );

    const report = await reviewGame(positions, analyze);

    expect(report.searches).toEqual({ scan: 3, deep: 1 });
    expect(analyze).toHaveBeenCalledTimes(4);

    const budgets = analyze.mock.calls.map((call) => call[1]);
    expect(budgets.slice(0, 3)).toEqual([SCAN_NODES, SCAN_NODES, SCAN_NODES]);
    expect(budgets[3]).toBe(DEEP_NODES);
  });

  it("promotes a position the scan could not score, not just a flagged one", async () => {
    // An unexplored or low-confidence played move is promoted *because* the
    // cheap search failed to answer -- which is when an answer matters most.
    const positions = [position("g1h3")];

    const analyze = vi.fn(async (_p: ReviewPosition, nodes: number) =>
      nodes === SCAN_NODES
        ? [line({ move: "e2e4", q: 0.12 })] // played move absent
        : ranking("g1h3", 0.05),
    );

    const report = await reviewGame(positions, analyze);

    expect(report.positions[0].scanVerdict.kind).toBe("unexplored");
    expect(report.searches.deep).toBe(1);
    expect(report.positions[0].depth).toBe("deep");
  });

  it("lets the deep verdict overrule the scan, keeping the scan for reference", async () => {
    const positions = [position("d2d4")];

    const analyze = vi.fn(async (_p: ReviewPosition, nodes: number) =>
      nodes === SCAN_NODES
        ? ranking("d2d4", 0.02) // scan says mistake
        : ranking("d2d4", 0.118), // deeper search says it is fine
    );

    const report = await reviewGame(positions, analyze);

    expect(report.positions[0].scanVerdict.kind).toBe("mistake");
    expect(report.positions[0].verdict.kind).toBe("ok");
    expect(mistakesFrom(report)).toHaveLength(0);
  });

  it("requests the same multipv in both passes", async () => {
    const analyze = vi.fn<AnalyzePosition>(async () => ranking("a2a3", 0.02));

    await reviewGame([position("a2a3")], analyze, { multipv: 12 });

    expect(analyze.mock.calls.every((call) => call[2] === 12)).toBe(true);
  });

  describe("mistakesFrom", () => {
    it("reports only deep verdicts, worst first", async () => {
      const positions = [position("a2a3", 0), position("h2h3", 1)];

      const analyze = vi.fn(async (p: ReviewPosition) =>
        p.playedMove === "a2a3" ? ranking("a2a3", 0.02) : ranking("h2h3", -0.20),
      );

      const mistakes = mistakesFrom(await reviewGame(positions, analyze));

      expect(mistakes.map((m) => m.position.playedMove)).toEqual(["h2h3", "a2a3"]);
      expect(mistakes.every((m) => m.depth === "deep")).toBe(true);
    });

    it("is empty when nothing was promoted, without any deep search", async () => {
      const analyze = vi.fn(async () => ranking("d2d4", 0.118));

      const report = await reviewGame([position("d2d4")], analyze);

      expect(report.searches.deep).toBe(0);
      expect(mistakesFrom(report)).toEqual([]);
    });
  });

  it("records the played move's rank so multipv can be sized from evidence", async () => {
    const positions = [position("d2d4", 0), position("g1h3", 1)];

    const analyze = vi.fn(async (p: ReviewPosition) =>
      p.playedMove === "d2d4"
        ? [line({ move: "e2e4", q: 0.12, multipv: 1 }), line({ move: "d2d4", q: 0.118, multipv: 9 })]
        : [line({ move: "e2e4", q: 0.12, multipv: 1 })],
    );

    const report = await reviewGame(positions, analyze);

    expect(report.playedRankHistogram.get(9)).toBe(1);
    expect(report.playedRankHistogram.get(null)).toBe(1);
  });

  it("reports progress for both phases", async () => {
    const onProgress = vi.fn();
    const analyze = vi.fn(async () => ranking("a2a3", 0.02));

    await reviewGame([position("a2a3")], analyze, { onProgress });

    expect(onProgress).toHaveBeenCalledWith(1, 1, "scan");
    expect(onProgress).toHaveBeenCalledWith(1, 1, "deep");
  });
});

describe("the deep pass has its own threshold", () => {
  it("scores the deep pass against THRESHOLD_DEEP, not the scan's cut", async () => {
    // A loss of 0.02 clears the scan's threshold (0.015) but not the deep
    // one (0.03, the inaccuracy floor). Before this was wired, the deep pass
    // silently inherited the scan's number -- a value derived from 20k noise
    // and documented as not being the reporting threshold.
    const analyze = vi.fn<AnalyzePosition>(async () => ranking("d2d4", 0.10));

    const report = await reviewGame([position("d2d4")], analyze);

    expect(report.positions[0].scanVerdict.kind).toBe("mistake");
    expect(report.positions[0].verdict.kind).toBe("ok");
  });

  it("still flags a loss above the deep threshold", async () => {
    const analyze = vi.fn<AnalyzePosition>(async () => ranking("a2a3", 0.02));

    const report = await reviewGame([position("a2a3")], analyze);

    expect(report.positions[0].verdict.kind).toBe("mistake");
  });

  it("clears the measured 200k noise floor by a wide margin", () => {
    // Worst run-to-run `loss` spread at 200k, lines clearing MIN_VISITS.
    expect(THRESHOLD_DEEP).toBeGreaterThan(0.0125);
  });
});

describe("the reference gate scales with the budget", () => {
  it("is exactly MIN_VISITS at the scan budget, so the scan is unchanged", () => {
    // 500 was calibrated at 20k; expressing it as 2.5% must reproduce it there
    // rather than quietly re-tune the pass whose thresholds are measured.
    expect(referenceMinVisitsFor(SCAN_NODES)).toBe(MIN_VISITS);
  });

  it("tightens at the deep budget instead of weakening", () => {
    // Left absolute, 500 is 0.25% of a 200k search -- the reference would be
    // held to a tenth of the standard the scan applies.
    expect(referenceMinVisitsFor(DEEP_NODES)).toBe(5_000);
  });

  it("never falls below MIN_VISITS however small the budget", () => {
    expect(referenceMinVisitsFor(1_000)).toBe(MIN_VISITS);
    expect(referenceMinVisitsFor(0)).toBe(MIN_VISITS);
  });

  it("leaves the reviewed game's findings standing", async () => {
    // Ply 24's cached 200k search: the one finding in the game resting on a
    // thin reference (1,664 visits, 1.7% of the top line). Measured 2026-07-23
    // via scripts/phase3-reference-gate.ts -- raising the gate to 10,000 moves
    // its loss by 0.0004, well inside the 0.0125 noise floor, because a
    // well-visited line sits at nearly the same q behind it.
    const positions = [position("c2c4", 24)];
    const deep = [
      line({ move: "B@c4", q: 0.0862, visits: 98_858, multipv: 1 }),
      line({ move: "B@h5", q: 0.0866, visits: 1_664, multipv: 6 }),
      line({ move: "c2c4", q: -0.0296, visits: 266, multipv: 11 }),
    ];

    const report = await reviewGame(positions, async () => deep, {
      scanNodes: SCAN_NODES,
      deepNodes: DEEP_NODES,
    });

    const graded = gradedMistakesFrom(report);
    expect(graded).toHaveLength(1);
    // The 5,000-visit gate rejects B@h5, so B@c4 -- 98,858 visits at almost
    // the same q -- sets the bar, and the finding survives 0.0004 smaller.
    expect(graded[0].entry.verdict.kind).toBe("mistake");
    if (graded[0].entry.verdict.kind !== "mistake") throw new Error("unreachable");
    expect(graded[0].entry.verdict.reference.move).toBe("B@c4");
    expect(graded[0].loss).toBeCloseTo(0.1158, 4);
  });
});
