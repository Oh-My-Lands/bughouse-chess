import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useEngineAnalysis } from "@/app/hooks/useEngineAnalysis";
import type { BughousePositionSnapshot } from "@/app/types/analysis";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function position(fenA = START): BughousePositionSnapshot {
  return {
    fenA,
    fenB: START,
    reserves: { A: { white: {}, black: {} }, B: { white: {}, black: {} } },
    promotedSquares: { A: [], B: [] },
    captureMaterial: {} as BughousePositionSnapshot["captureMaterial"],
  };
}

const RESPONSE = {
  output: {
    moveA: "d2d4",
    moveB: null,
    depth: 12,
    nodes: 50016,
    lines: [
      {
        multipv: 1, move: "d2d4", partnerMove: null,
        q: -0.017, visits: 21841, prior: 0.33,
        score: { kind: "cp", value: -4 }, pv: [{ a: "d2d4", b: null }],
      },
    ],
  },
};

/** Resolves fetch on demand so in-flight state can be inspected. */
function deferredFetch() {
  const calls: Array<{ resolve: () => void; aborted: () => boolean }> = [];
  const spy = vi.fn((_url: string, init: RequestInit) => {
    return new Promise((resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
      calls.push({
        resolve: () =>
          resolve({ ok: true, status: 200, json: async () => RESPONSE } as Response),
        aborted: () => signal?.aborted ?? false,
      });
    });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

const baseOptions = {
  endpoint: "http://engine.test",
  board: "A" as const,
  side: "white" as const,
  mode: "go" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useEngineAnalysis", () => {
  it("requests nothing on mount when analysis is off", async () => {
    const { spy } = deferredFetch();
    renderHook(() =>
      useEngineAnalysis({ ...baseOptions, position: position(), enabled: false }),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(spy).not.toHaveBeenCalled();
  });

  it("refresh() runs a search and delivers the result while off", async () => {
    // The regression this file exists for. refresh() used to bump a state
    // counter that fed the auto-analysis effect's dependency key; that effect
    // then re-ran, saw enabled === false, and aborted the request refresh() had
    // just started. The engine ran the full search and the result was thrown
    // away on arrival — the button appeared to do nothing while still costing
    // GPU time.
    const { spy, calls } = deferredFetch();
    const { result } = renderHook(() =>
      useEngineAnalysis({ ...baseOptions, position: position(), enabled: false }),
    );

    act(() => result.current.refresh());
    expect(spy).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].aborted()).toBe(false); // must survive long enough to answer

    await act(async () => {
      calls[0].resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.analysis).not.toBeNull());
    expect(result.current.analysis?.lines[0].move).toBe("d2d4");
    expect(result.current.isAnalyzing).toBe(false);
  });

  it("refresh() also works while auto analysis is on", async () => {
    const { spy, calls } = deferredFetch();
    const { result } = renderHook(() =>
      useEngineAnalysis({ ...baseOptions, position: position(), enabled: true }),
    );

    // Let the automatic search fire and settle first.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await act(async () => {
      calls[0].resolve();
      await Promise.resolve();
    });
    const afterAuto = spy.mock.calls.length;

    act(() => result.current.refresh());
    expect(spy.mock.calls.length).toBe(afterAuto + 1);
  });

  it("auto analysis fires once the position settles", async () => {
    const { spy } = deferredFetch();
    renderHook(() =>
      useEngineAnalysis({
        ...baseOptions, position: position(), enabled: true, debounceMs: 10,
      }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it("aborts an in-flight search when auto is switched off", async () => {
    const { calls } = deferredFetch();
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useEngineAnalysis({
          ...baseOptions, position: position(), enabled: props.enabled, debounceMs: 10,
        }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(calls).toHaveLength(1));
    rerender({ enabled: false });

    await waitFor(() => expect(calls[0].aborted()).toBe(true));
    // The abort listener must clear the spinner, or it sticks forever.
    await waitFor(() => expect(result.current.isAnalyzing).toBe(false));
  });

  it("reports a bad position without contacting the engine", async () => {
    const { spy } = deferredFetch();
    const { result } = renderHook(() =>
      useEngineAnalysis({
        ...baseOptions, position: position("not-a-fen"), enabled: false,
      }),
    );

    act(() => result.current.refresh());
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/could not encode/i);
  });
});
