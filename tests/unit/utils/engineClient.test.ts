import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineError, analyzePosition } from "@/app/utils/engine/engineClient";
import type { BughousePositionSnapshot } from "@/app/types/analysis";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function snapshot(): BughousePositionSnapshot {
  return {
    fenA: START,
    fenB: START,
    reserves: { A: { white: {}, black: {} }, B: { white: {}, black: {} } },
    promotedSquares: { A: [], B: [] },
    captureMaterial: {} as BughousePositionSnapshot["captureMaterial"],
  };
}

/**
 * A response captured from the dev server, trimmed to two lines. Keeping the
 * real shape matters: the client is the only thing standing between the
 * endpoint's wire format and the UI.
 */
const REAL_RESPONSE = {
  output: {
    bestmove: "(d2d4,pass)",
    moveA: "d2d4",
    moveB: null,
    analysisBoard: 1,
    depth: 12,
    nodes: 48512,
    time_ms: 2990,
    lines: [
      {
        multipv: 1,
        move: "d2d4",
        partnerMove: null,
        depth: 12,
        score: { kind: "cp", value: -4 },
        q: -0.0168,
        prior: 0.3265,
        visits: 21841,
        pv: [{ a: "d2d4", b: null }, { a: "d7d5", b: null }],
      },
      {
        multipv: 2,
        move: "e2e4",
        partnerMove: null,
        depth: 12,
        score: { kind: "cp", value: -6 },
        q: -0.0219,
        prior: 0.4569,
        visits: 21682,
        pv: [{ a: "e2e4", b: null }],
      },
    ],
  },
  status: "COMPLETED",
};

function mockFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const request = {
  position: snapshot(),
  board: "A" as const,
  side: "white" as const,
  multipv: 5,
  mode: "go" as const,
  nodes: 200_000,
};

describe("analyzePosition", () => {
  it("posts an engine-dialect FEN to /run", async () => {
    const spy = mockFetch(REAL_RESPONSE);
    await analyzePosition("http://localhost:8080", request);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("http://localhost:8080/run");

    const body = JSON.parse(init.body);
    // Reserves inline in brackets, both boards joined -- not the app's own FENs.
    expect(body.input.fen).toContain("[]");
    expect(body.input.fen.split("|")).toHaveLength(2);
    expect(body.input.analysisBoard).toBe(1);
    expect(body.input.nodes).toBe(200_000);
  });

  it("tolerates a trailing slash on the endpoint", async () => {
    const spy = mockFetch(REAL_RESPONSE);
    await analyzePosition("http://localhost:8080/", request);
    expect(spy.mock.calls[0][0]).toBe("http://localhost:8080/run");
  });

  it("sends board B as index 2 and inverts the team colour", async () => {
    const spy = mockFetch(REAL_RESPONSE);
    await analyzePosition("http://x", { ...request, board: "B", side: "white" });

    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.input.analysisBoard).toBe(2);
    // The engine plays the opposite colour on board B.
    expect(body.input.team).toBe("black");
  });

  it("normalises lines into what the UI needs", async () => {
    mockFetch(REAL_RESPONSE);
    const got = await analyzePosition("http://x", request);

    expect(got.lines).toHaveLength(2);
    expect(got.lines[0]).toMatchObject({
      multipv: 1,
      move: "d2d4",
      q: -0.0168,
      visits: 21841,
      scoreCentipawns: -4,
      mateIn: null,
    });
    expect(got.bestMoveA).toBe("d2d4");
    expect(got.bestMoveB).toBeNull();
    expect(got.nodes).toBe(48512);
  });

  it("separates mate scores from centipawn scores", async () => {
    mockFetch({
      output: {
        moveA: "h5f7", moveB: null, lines: [{
          multipv: 1, move: "h5f7", q: 0.99, visits: 500, prior: 0.4,
          score: { kind: "mate", value: 3 }, pv: [],
        }],
      },
    });
    const got = await analyzePosition("http://x", request);
    expect(got.lines[0].mateIn).toBe(3);
    expect(got.lines[0].scoreCentipawns).toBeNull();
  });

  it("keeps a sit candidate as null rather than dropping the line", async () => {
    mockFetch({
      output: {
        moveA: null, moveB: "d7d5", lines: [{
          multipv: 1, move: null, partnerMove: "d7d5",
          q: 0.1, visits: 10, prior: 0.2, pv: [{ a: null, b: "d7d5" }],
        }],
      },
    });
    const got = await analyzePosition("http://x", request);
    expect(got.lines).toHaveLength(1);
    expect(got.lines[0].move).toBeNull();
  });

  it("surfaces the note when fewer lines came back than asked for", async () => {
    mockFetch({ output: { ...REAL_RESPONSE.output, note: "requested 5, got 2" } });
    expect((await analyzePosition("http://x", request)).note).toBe(
      "requested 5, got 2",
    );
  });

  it("raises the engine's own error message", async () => {
    mockFetch({ output: { error: "analysisBoard must be 1 or 2" } });
    await expect(analyzePosition("http://x", request)).rejects.toThrow(
      "analysisBoard must be 1 or 2",
    );
  });

  it("raises on an HTTP failure", async () => {
    mockFetch({}, { ok: false, status: 502 });
    await expect(analyzePosition("http://x", request)).rejects.toThrow(EngineError);
  });

  it("raises a reachability error when fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(analyzePosition("http://x", request)).rejects.toThrow(
      /could not reach the engine/,
    );
  });

  it("lets an abort propagate rather than reporting it as an engine fault", async () => {
    // The hook aborts on every position change; those are not errors to show.
    const abort = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(analyzePosition("http://x", request)).rejects.toBe(abort);
  });

  it("returns no lines rather than throwing when the field is missing", async () => {
    mockFetch({ output: { moveA: "d2d4", moveB: null } });
    expect((await analyzePosition("http://x", request)).lines).toEqual([]);
  });
});
