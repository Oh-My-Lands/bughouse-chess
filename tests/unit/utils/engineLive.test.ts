import { describe, expect, it } from "vitest";

import { analyzePosition } from "@/app/utils/engine/engineClient";
import type { BughousePositionSnapshot } from "@/app/types/analysis";

/**
 * Live check against a running engine endpoint.
 *
 * Unit tests with a mocked fetch only prove the client is self-consistent. This
 * proves the request it builds is one the engine actually accepts, and that the
 * response shape it expects is the one the engine actually returns.
 *
 *   ENGINE_ENDPOINT=http://localhost:8080 npx vitest run engineLive
 *
 * Skipped when that is unset, so the normal suite stays offline and fast.
 */
const ENDPOINT = process.env.ENGINE_ENDPOINT;
const describeLive = ENDPOINT ? describe : describe.skip;

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function snapshot(
  over: Partial<BughousePositionSnapshot> = {},
): BughousePositionSnapshot {
  return {
    fenA: START,
    fenB: START,
    reserves: { A: { white: {}, black: {} }, B: { white: {}, black: {} } },
    promotedSquares: { A: [], B: [] },
    captureMaterial: {} as BughousePositionSnapshot["captureMaterial"],
    ...over,
  };
}

describeLive("live engine", () => {
  it("returns ranked candidates for board A", async () => {
    const got = await analyzePosition(ENDPOINT!, {
      position: snapshot(),
      board: "A",
      side: "white",
      multipv: 4,
      mode: "go",
      nodes: 30_000,
    });

    expect(got.lines.length).toBeGreaterThan(1);

    // The whole point of grouping: one entry per distinct move on our board.
    const moves = got.lines.map((line) => line.move);
    expect(new Set(moves).size).toBe(moves.length);

    // PV 1 must agree with the engine's chosen move, or the UI contradicts itself.
    expect(got.lines[0].move).toBe(got.bestMoveA);

    for (const line of got.lines) {
      expect(line.q).toBeGreaterThanOrEqual(-1);
      expect(line.q).toBeLessThanOrEqual(1);
      expect(line.visits).toBeGreaterThan(0);
      expect(line.pv.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("accepts a position with reserves and promoted pieces", async () => {
    // The awkward end of the FEN adapter: reserves move inline into brackets and
    // promoted pieces get a `~`, neither of which the app's own FENs carry.
    const got = await analyzePosition(ENDPOINT!, {
      position: snapshot({
        fenA: "q3k3/8/8/8/8/8/8/4K2Q w - - 0 1",
        promotedSquares: { A: ["a8", "h1"], B: [] },
        reserves: {
          A: { white: { p: 2 }, black: { n: 1 } },
          B: { white: { r: 1 }, black: {} },
        },
      }),
      board: "A",
      side: "white",
      multipv: 3,
      mode: "go",
      nodes: 20_000,
    });

    expect(got.lines.length).toBeGreaterThan(0);
    expect(got.bestMoveA).not.toBeNull();
  }, 120_000);

  it("analyses board B from the other seat", async () => {
    const got = await analyzePosition(ENDPOINT!, {
      position: snapshot(),
      board: "B",
      side: "white",
      multipv: 3,
      mode: "go",
      nodes: 20_000,
    });
    expect(got.analysisBoard).toBe("B");
    expect(got.lines.length).toBeGreaterThan(0);
  }, 120_000);

  it("reports an engine-side rejection as an error", async () => {
    await expect(
      analyzePosition(ENDPOINT!, {
        position: snapshot({ fenA: "not-a-fen" }),
        board: "A",
        side: "white",
        multipv: 1,
        mode: "go",
        nodes: 1_000,
      }),
    ).rejects.toThrow();
  }, 60_000);
});
