"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BughouseBoardId, BughouseSide } from "@/app/types/analysis";
import type {
  BughouseClocksSnapshotByBoard,
  BughouseMove,
} from "@/app/types/bughouse";
import { EngineError, analyzePosition } from "@/app/utils/engine/engineClient";
import { deriveEngineMode } from "@/app/utils/engine/engineMode";
import { buildReviewPositions } from "@/app/utils/review/buildReviewPositions";
import {
  reviewGame,
  type AnalyzePosition,
  type ReviewReport,
} from "@/app/utils/review/reviewGame";
import { reviewScopeId } from "@/app/utils/review/reviewScope";
import {
  loadReviewReport,
  saveReviewReport,
} from "@/app/utils/review/reviewReportCache";

/**
 * Drives a two-pass game review from the browser.
 *
 * The review itself is `reviewGame`, which is headless and endpoint-agnostic:
 * it takes an `analyze` function and a list of positions and knows nothing about
 * React or fetch. This hook is the thin adapter that supplies both -- positions
 * from the loaded game via `buildReviewPositions`, and an `analyze` that goes
 * through the same `/run` proxy `useEngineAnalysis` uses, so the browser never
 * sees a RunPod credential.
 *
 * **Why a manual start rather than an effect.** A review is minutes of GPU time
 * and the engine finishes every search it starts even if the client hangs up.
 * So it must never begin because a component mounted or a dependency changed --
 * only because the user asked. `useEngineAnalysis` makes the same choice for the
 * same reason.
 *
 * **On cancel.** `reviewGame` returns only on completion, so a cancel aborts the
 * in-flight search and discards the run; the partial findings are not surfaced.
 * Restarting re-searches from the top. That is acceptable while the server-side
 * cache is the thing that makes a restart cheap (Phase 2); surfacing partial
 * results is a later refinement, not a slice-1 concern.
 */

export type ReviewStatus = "idle" | "running" | "done" | "cancelled" | "error";

export interface ReviewProgress {
  done: number;
  total: number;
  phase: "scan" | "deep";
}

export interface UseGameReviewOptions {
  /** Base URL of the engine proxy. Empty disables the review entirely. */
  endpoint: string;
  /** The interleaved timeline from `processGameData`. */
  combinedMoves: readonly BughouseMove[] | undefined;
  /**
   * The global clock timeline from `buildBughouseClockTimeline`, indexed so that
   * `[globalPly]` is the clock state *before* the move at that ply -- the same
   * before-move instant a `ReviewPosition` represents. Used to derive each
   * position's engine Mode from its own clock. Omitted disables derivation and
   * falls back to "go".
   */
  clockTimeline?: readonly BughouseClocksSnapshotByBoard[];
  /** The player being reviewed. */
  scope: { board: BughouseBoardId; side: BughouseSide } | null;
  /**
   * Stable id of the loaded game. When set, a finished report is remembered in
   * the browser under `(gameId, scope)` and re-hydrated on reopen, so a review
   * already run here comes back without a click or a re-search. Null (no id yet)
   * simply disables that -- the review still runs, it just is not remembered.
   */
  gameId?: string | null;
}

export interface UseGameReviewResult {
  status: ReviewStatus;
  progress: ReviewProgress | null;
  report: ReviewReport | null;
  /** How many positions the current scope would search, before starting. */
  positionCount: number;
  /** Set when the game could only be replayed partially; the review is of the rest. */
  replayError: string | null;
  /** Set when the run itself failed. */
  error: string | null;
  start: () => void;
  cancel: () => void;
}

export function useGameReview(
  options: UseGameReviewOptions,
): UseGameReviewResult {
  const { endpoint, combinedMoves, clockTimeline, scope, gameId = null } = options;

  // Positions depend only on the game and the scope, so they are derived rather
  // than searched -- switching scope recomputes them without touching the
  // engine. This object's identity changes exactly when the game or scope does,
  // which is what lets a run be tagged to the inputs it belongs to.
  //
  // Keyed on the scope's *primitives*, not the scope object: callers routinely
  // pass a fresh `{ board, side }` literal every render, and depending on its
  // identity would rebuild `built` each render -- which would both make the
  // run-token comparison never match (UI stuck idle) and fire the abort effect
  // below every render (killing the search the instant it starts).
  const board = scope?.board ?? null;
  const side = scope?.side ?? null;
  const built = useMemo(() => {
    if (!combinedMoves || !board || !side) {
      return { positions: [], replayError: null };
    }
    return buildReviewPositions(combinedMoves, { board, side });
  }, [combinedMoves, board, side]);

  // A run's outcome, tagged with the `built` it was launched for.
  //
  // Tagging is what removes the reset-on-scope-change effect: rather than
  // clearing state when the inputs change, a stale run is simply not the one
  // being read -- the same trick `useEngineAnalysis` uses to key results by
  // position. So `run.token !== built` reads as idle, and a late result for a
  // scope the user has left updates state that nothing displays.
  interface Run {
    token: object;
    status: ReviewStatus;
    progress: ReviewProgress | null;
    report: ReviewReport | null;
    error: string | null;
  }
  const [run, setRun] = useState<Run | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Abort an in-flight review when the inputs change or the component unmounts.
  // Cleanup only -- no setState -- so the display reset comes from the token
  // mismatch below, not from here.
  useEffect(() => () => abortRef.current?.abort(), [built]);

  // Rehydrate a report this browser already produced for these inputs, so
  // reopening a reviewed game shows its findings straight away -- no click, no
  // re-search. This issues no engine requests, so it does not touch the reason
  // `start` is manual (that gate is about GPU spend, and there is none here).
  //
  // Tagged with the current `built` and guarded against clobbering a run already
  // launched for it: a hydrate that landed on top of a running review would wipe
  // its progress.
  useEffect(() => {
    if (!gameId || !board || !side || built.positions.length === 0) return;
    const token = built;
    const cached = loadReviewReport(gameId, reviewScopeId({ board, side }));
    if (!cached) return;
    // Hydrating from localStorage (an external store) on a scope change is the
    // legitimate effect-as-sync case; the functional updater is guarded so it
    // cannot clobber a run already launched for this `built`. The lint rule
    // flags the synchronous shape, not a real cascading-render bug here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRun((prev) =>
      prev && prev.token === token
        ? prev
        : { token, status: "done", progress: null, report: cached, error: null },
    );
  }, [built, gameId, board, side]);

  const start = useCallback(() => {
    if (!endpoint || built.positions.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const token = built;
    const update = (patch: Partial<Run>) => {
      if (controller.signal.aborted) return;
      setRun((prev) =>
        prev && prev.token === token ? { ...prev, ...patch } : prev,
      );
    };

    setRun({
      token,
      status: "running",
      progress: { done: 0, total: built.positions.length, phase: "scan" },
      report: null,
      error: null,
    });

    const analyze: AnalyzePosition = async (position, nodes, multipv) => {
      // Mode is derived per position from that position's own clock: a team
      // that was sitting is searched as "sit", so the NN plane matches how the
      // move was actually played rather than being forced to "go" everywhere.
      // The clock at ply `g` is the state before combinedMoves[g], which is the
      // position being searched. Falls back to "go" if the timeline is absent.
      const snapshot = clockTimeline?.[
        Math.min(Math.max(position.globalPly, 0), clockTimeline.length - 1)
      ];
      const mode = snapshot
        ? deriveEngineMode(snapshot, position.board, position.side)
        : "go";
      const result = await analyzePosition(endpoint, {
        position: position.position,
        board: position.board,
        side: position.side,
        multipv,
        mode,
        nodes,
        signal: controller.signal,
      });
      return result.lines;
    };

    reviewGame(built.positions, analyze, {
      onProgress: (done, total, phase) => update({ progress: { done, total, phase } }),
    })
      .then((result) => {
        update({ status: "done", report: result });
        // Remember it for a free reopen. Guarded on the same abort as `update`:
        // a cancelled run's partial-then-completed result is not shown, so it
        // must not be stored either. Only a real (gameId, scope) is keyable.
        if (!controller.signal.aborted && gameId && board && side) {
          saveReviewReport(gameId, reviewScopeId({ board, side }), result);
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted || isAbort(cause)) {
          // The abort path is handled by cancel(); nothing to report here.
          return;
        }
        update({
          status: "error",
          error:
            cause instanceof EngineError
              ? cause.message
              : "The review failed unexpectedly.",
        });
      });
  }, [endpoint, built, clockTimeline, gameId, board, side]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRun((prev) =>
      prev ? { ...prev, status: "cancelled", progress: null } : prev,
    );
  }, []);

  // Only a run launched for the current inputs is shown; anything else is idle.
  const active = run && run.token === built ? run : null;

  return {
    status: active?.status ?? "idle",
    progress: active?.progress ?? null,
    report: active?.report ?? null,
    positionCount: built.positions.length,
    replayError: built.replayError,
    error: active?.error ?? null,
    start,
    cancel,
  };
}

/** An aborted fetch surfaces as a DOMException; treat it as a cancel, not a failure. */
function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}
