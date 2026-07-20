"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { BughouseBoardId, BughousePositionSnapshot } from "@/app/types/analysis";
import { EngineError, analyzePosition } from "@/app/utils/engine/engineClient";
import type { EngineAnalysis } from "@/app/utils/engine/engineClient";
import { BughouseFenError, toEngineFen } from "@/app/utils/engine/bughouseFen";
import type { EngineMode } from "@/app/utils/engine/engineMode";

export interface UseEngineAnalysisOptions {
  endpoint: string;
  position: BughousePositionSnapshot | null;
  board: BughouseBoardId;
  side: "white" | "black";
  /** Engine time model. Chosen explicitly; see engineMode. */
  mode: EngineMode;
  multipv?: number;
  nodes?: number;
  /**
   * When false, nothing is requested automatically — `refresh()` still runs a
   * single search on demand. Defaults to false: a search is real GPU time, and
   * the engine completes one even if the client disconnects, so an automatic
   * search per navigation step is paid for whether or not it is ever read.
   */
  enabled?: boolean;
  /**
   * Wait this long after the position settles before searching. Stepping
   * through a game changes the position every ply, and each change would
   * otherwise start and abandon a search.
   */
  debounceMs?: number;
}

export interface UseEngineAnalysisResult {
  analysis: EngineAnalysis | null;
  isAnalyzing: boolean;
  error: string | null;
  /**
   * Run one search now for the current position, regardless of `enabled`
   * and ignoring the debounce.
   */
  refresh: () => void;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MULTIPV = 3;
const DEFAULT_NODES = 50_000;

/**
 * Runs engine analysis for the position currently being viewed.
 *
 * Requests are keyed by everything that changes the answer -- position, board,
 * side, mode, budget. When the key changes the in-flight request is aborted,
 * because its result describes a position the user has already left. Rendering
 * a stale result is worse than rendering none: the numbers look authoritative
 * and belong to a different position.
 */
export function useEngineAnalysis(
  options: UseEngineAnalysisOptions,
): UseEngineAnalysisResult {
  const {
    endpoint,
    position,
    board,
    side,
    mode,
    multipv = DEFAULT_MULTIPV,
    nodes = DEFAULT_NODES,
    enabled = false,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = options;

  const [analysis, setAnalysis] = useState<EngineAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Encoding the position is also the validity check: the engine does not
  // reject a malformed FEN, it silently searches a nonsense position. Failing
  // here keeps that from ever reaching it.
  let engineFen: string | null = null;
  let fenError: string | null = null;
  if (position) {
    try {
      engineFen = toEngineFen(position);
    } catch (cause) {
      fenError =
        cause instanceof BughouseFenError
          ? `Could not encode this position: ${cause.message}`
          : "Could not encode this position for the engine.";
    }
  }

  // One string covering everything that changes the answer. Mode is in here
  // because it feeds an NN plane and is hashed into the position key, so a
  // change makes the previous result describe different rules.
  const requestKey = [
    engineFen ?? "",
    board,
    side,
    mode,
    multipv,
    nodes,
  ].join("|");

  // The request itself, independent of what triggered it.
  const runAnalysis = () => {
    if (!position || !engineFen) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Clearing the loading flag on abort keeps the spinner from sticking when a
    // request is dropped rather than answered — whether that came from a new
    // search, auto being switched off, or unmount. Doing it here rather than at
    // each abort site means every path is covered by construction.
    controller.signal.addEventListener("abort", () => setIsAnalyzing(false));

    setIsAnalyzing(true);
    setError(null);

    analyzePosition(endpoint, {
      position,
      board,
      side,
      multipv,
      mode,
      nodes,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setAnalysis(result);
        setIsAnalyzing(false);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setIsAnalyzing(false);
        setError(
          cause instanceof EngineError
            ? cause.message
            : "Analysis failed unexpectedly.",
        );
      });
  };

  // Latest-ref pattern: `refresh` is called from an event handler that can fire
  // long after the render that created it, so it must not close over stale
  // position/mode/budget values. The ref is updated after every render (in an
  // effect, not during render) and always points at the current closure.
  const runRef = useRef(runAnalysis);
  useEffect(() => {
    runRef.current = runAnalysis;
  });

  // Automatic analysis: only while `enabled`. When it is off nothing is
  // requested, so navigating costs nothing — a search is GPU time, and the
  // engine finishes one even if the client hangs up, so an abandoned request
  // is paid for in full.
  useEffect(() => {
    if (!enabled) {
      // The abort listener above clears the loading flag.
      abortRef.current?.abort();
      return;
    }

    const timer = setTimeout(() => runRef.current(), debounceMs);
    return () => clearTimeout(timer);
    // requestKey collapses the inputs that matter; the rest are read through it.
  }, [requestKey, enabled, endpoint, debounceMs]);

  // Results belong to the position that produced them; showing one position's
  // numbers under another is worse than showing none, because they look
  // authoritative. Reset during render rather than in an effect so the stale
  // analysis is never painted for a frame first.
  const resultKey = [engineFen ?? "", board, side, mode].join("|");
  const [renderedForKey, setRenderedForKey] = useState(resultKey);
  if (renderedForKey !== resultKey) {
    setRenderedForKey(resultKey);
    setAnalysis(null);
  }

  useEffect(() => () => abortRef.current?.abort(), []);

  // Runs one search immediately, whether or not automatic analysis is on. This
  // is what makes "off" usable: park on a position, ask for one search, pay for
  // exactly that.
  //
  // Deliberately does NOT bump a state counter to re-trigger the effect above.
  // Doing so changed requestKey, which re-ran that effect, which saw `enabled`
  // false and aborted the request this function had just started — the engine
  // ran the whole search and the result was discarded on arrival.
  const refresh = useCallback(() => {
    runRef.current();
  }, []);

  return {
    analysis,
    isAnalyzing,
    error: fenError ?? error,
    refresh,
  };
}
