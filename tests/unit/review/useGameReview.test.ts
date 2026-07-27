import { readFileSync } from "fs";
import { join } from "path";

import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChessGame } from "@/app/actions";
import type { BughouseBoardId, BughouseSide } from "@/app/types/analysis";
import type { BughouseClocksSnapshotByBoard } from "@/app/types/bughouse";
import { processGameData } from "@/app/utils/board/moveOrdering";
import { analyzePosition } from "@/app/utils/engine/engineClient";
import { useGameReview } from "@/app/hooks/useGameReview";

type Scope = { board: BughouseBoardId; side: BughouseSide };

// The hook's `analyze` goes through engineClient.analyzePosition; stub it so the
// review runs without a server. Empty lines make every position "unexplored"
// (harmless here) -- the point of these tests is the run's *lifecycle*, not its
// findings, which are covered against real engine output elsewhere.
vi.mock("@/app/utils/engine/engineClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/utils/engine/engineClient")>();
  return {
    ...actual,
    analyzePosition: vi.fn(async () => ({
      lines: [],
      bestMoveA: null,
      bestMoveB: null,
      analysisBoard: "A" as const,
      depth: null,
      nodes: null,
      timeMs: null,
    })),
  };
});

function readGame(id: string): ChessGame {
  return JSON.parse(
    readFileSync(join(process.cwd(), `tests/fixtures/chesscom/${id}.json`), "utf8"),
  ) as ChessGame;
}

function combinedMovesFor(id: string) {
  const game = readGame(id);
  return processGameData(game, readGame(String(game.game.partnerGameId))).combinedMoves;
}

const GAME = "160842422747";

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("useGameReview", () => {
  it("completes even when the caller passes a fresh scope object every render", async () => {
    // The real component builds `{ board, side }` inline, so its identity
    // changes each render. If the hook keyed on that identity, `built` would be
    // rebuilt every render -- the run token would never match (stuck idle) and
    // the abort effect would kill the search on the next render. This is the
    // exact regression that shipped in slice 1.
    const combinedMoves = combinedMovesFor(GAME);

    const { result, rerender } = renderHook(
      ({ scope }: { scope: Scope }) =>
        useGameReview({ endpoint: "/api/engine", combinedMoves, scope }),
      { initialProps: { scope: { board: "A", side: "white" } } as { scope: Scope } },
    );

    expect(result.current.status).toBe("idle");
    expect(result.current.positionCount).toBeGreaterThan(0);

    act(() => {
      result.current.start();
    });

    // Re-render with new scope object identities, mimicking the parent.
    rerender({ scope: { board: "A", side: "white" } });
    rerender({ scope: { board: "A", side: "white" } });

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.report).not.toBeNull();
  });

  it("resets to idle when the scope changes to another player", async () => {
    const combinedMoves = combinedMovesFor(GAME);

    const { result, rerender } = renderHook(
      ({ scope }: { scope: Scope }) =>
        useGameReview({ endpoint: "/api/engine", combinedMoves, scope }),
      { initialProps: { scope: { board: "A", side: "white" } } as { scope: Scope } },
    );

    act(() => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.status).toBe("done"));

    // A different player is a different question; the finished report must not
    // carry over. This is the derive-not-reset behaviour the token provides.
    rerender({ scope: { board: "B", side: "white" } });
    expect(result.current.status).toBe("idle");
    expect(result.current.report).toBeNull();

    // And back again shows the still-current run as idle too -- a fresh start is
    // required, rather than the old A-white report reappearing.
    rerender({ scope: { board: "A", side: "white" } });
    expect(result.current.status).toBe("idle");
  });

  it("stays idle with no scope", () => {
    const combinedMoves = combinedMovesFor(GAME);
    const { result } = renderHook(() =>
      useGameReview({ endpoint: "/api/engine", combinedMoves, scope: null }),
    );
    expect(result.current.status).toBe("idle");
    expect(result.current.positionCount).toBe(0);
  });

  it("re-hydrates a finished review on remount, without re-searching", async () => {
    const combinedMoves = combinedMovesFor(GAME);
    const props = {
      endpoint: "/api/engine",
      combinedMoves,
      scope: { board: "A", side: "white" } as Scope,
      gameId: "game-under-test",
    };

    const first = renderHook(() => useGameReview(props));
    act(() => first.result.current.start());
    await waitFor(() => expect(first.result.current.status).toBe("done"));
    first.unmount();

    const searchesAfterRun = vi.mocked(analyzePosition).mock.calls.length;
    expect(searchesAfterRun).toBeGreaterThan(0);

    // A fresh mount for the same game and scope should show the stored report
    // straight away -- no start, and crucially no further searches.
    const second = renderHook(() => useGameReview(props));
    await waitFor(() => expect(second.result.current.status).toBe("done"));
    expect(second.result.current.report).not.toBeNull();
    expect(vi.mocked(analyzePosition).mock.calls.length).toBe(searchesAfterRun);
  });

  it("with a gameId, returning to a completed scope re-hydrates rather than resetting to idle", async () => {
    const combinedMoves = combinedMovesFor(GAME);

    const { result, rerender } = renderHook(
      ({ scope }: { scope: Scope }) =>
        useGameReview({
          endpoint: "/api/engine",
          combinedMoves,
          scope,
          gameId: "game-under-test",
        }),
      { initialProps: { scope: { board: "A", side: "white" } } as { scope: Scope } },
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe("done"));

    // Away to another player: still a different question, still idle.
    rerender({ scope: { board: "B", side: "white" } });
    expect(result.current.status).toBe("idle");

    // Back to the reviewed player: unlike the no-gameId case, the stored report
    // returns instead of an empty idle state.
    rerender({ scope: { board: "A", side: "white" } });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.report).not.toBeNull();
  });

  it("derives each searched position's mode from the clock timeline", async () => {
    const combinedMoves = combinedMovesFor(GAME);
    // A timeline where team AWhite_BBlack is far ahead at every ply. The A-white
    // scope is that team, so every position it searches should be sat.
    const lead: BughouseClocksSnapshotByBoard = {
      A: { white: 1600, black: 600 },
      B: { white: 600, black: 600 },
    };
    const clockTimeline: BughouseClocksSnapshotByBoard[] = Array.from(
      { length: combinedMoves.length + 1 },
      () => lead,
    );

    const { result } = renderHook(() =>
      useGameReview({
        endpoint: "/api/engine",
        combinedMoves,
        clockTimeline,
        scope: { board: "A", side: "white" } as Scope,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe("done"));

    const calls = vi.mocked(analyzePosition).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Not the old blanket "go": the team is up, so every request sits.
    expect(calls.every(([, req]) => req.mode === "sit")).toBe(true);
  });

  it("falls back to go when no clock timeline is supplied", async () => {
    const combinedMoves = combinedMovesFor(GAME);
    const { result } = renderHook(() =>
      useGameReview({
        endpoint: "/api/engine",
        combinedMoves,
        scope: { board: "A", side: "white" } as Scope,
      }),
    );

    act(() => result.current.start());
    await waitFor(() => expect(result.current.status).toBe("done"));

    const calls = vi.mocked(analyzePosition).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, req]) => req.mode === "go")).toBe(true);
  });
});
