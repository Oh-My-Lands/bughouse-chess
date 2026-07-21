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
 * How many analyses to keep.
 *
 * Each is a handful of lines, so this is small in memory; the cap exists only
 * so that scrubbing through a long game cannot grow the map indefinitely.
 */
const MAX_CACHED_ANALYSES = 200;

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

  // Every analysis already paid for, keyed by the position that produced it.
  //
  // This is the whole display model: the shown analysis is *derived* from it
  // rather than copied into a second piece of state. That is what makes
  // navigation free -- stepping back to an analysed position finds its entry
  // and shows it, stepping to a new one finds nothing and shows the empty
  // state -- with no reset to keep in sync and no way for one position's
  // numbers to be painted under another.
  //
  // It also settles the late-result problem by construction: a slow search
  // files itself under the position it started from, so if the user has moved
  // on it simply is not the entry being read.
  const [cache, setCache] = useState<ReadonlyMap<string, EngineAnalysis>>(
    () => new Map(),
  );
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // Errors are keyed too, so navigating away from a failure clears it without
  // an explicit reset.
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(
    null,
  );

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

  // What a result is filed under. Narrower than requestKey on purpose: the
  // budget changes how good an answer is, not which question it answers, so a
  // re-run at a different budget replaces the entry rather than making a
  // second one the user cannot get back to.
  const resultKey = [engineFen ?? "", board, side, mode].join("|");

  // The request itself, independent of what triggered it.
  const runAnalysis = () => {
    if (!position || !engineFen) return;

    const keyAtRequest = resultKey;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Clearing the loading flag on abort keeps the spinner from sticking when a
    // request is dropped rather than answered — whether that came from a new
    // search, auto being switched off, or unmount. Doing it here rather than at
    // each abort site means every path is covered by construction.
    controller.signal.addEventListener("abort", () => setIsAnalyzing(false));

    setIsAnalyzing(true);
    setFailure(null);

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
        setCache((prev) => {
          const next = new Map(prev);
          next.set(keyAtRequest, result);
          // Oldest-first eviction; entries are small, so the cap only exists to
          // stop a long scrub growing this without bound.
          while (next.size > MAX_CACHED_ANALYSES) {
            next.delete(next.keys().next().value as string);
          }
          return next;
        });
        setIsAnalyzing(false);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setIsAnalyzing(false);
        setFailure({
          key: keyAtRequest,
          message:
            cause instanceof EngineError
              ? cause.message
              : "Analysis failed unexpectedly.",
        });
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
  // Switching automatic analysis off cancels whatever it started. Keyed on
  // `enabled` alone, deliberately: an earlier version also ran on every
  // requestKey change, so merely stepping to the next ply aborted a search the
  // user had explicitly asked for. The engine does not stop when the client
  // hangs up, so that discarded a result already paid for in GPU time.
  useEffect(() => {
    if (!enabled) {
      // The abort listener in runAnalysis clears the loading flag.
      abortRef.current?.abort();
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => runRef.current(), debounceMs);
    return () => clearTimeout(timer);
    // requestKey collapses the inputs that matter; the rest are read through it.
  }, [requestKey, enabled, endpoint, debounceMs]);

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

  // Both derived from the position on screen, so navigation needs no reset:
  // an unanalysed position simply has no entry, and a failure on one position
  // is not reported on another.
  return {
    analysis: cache.get(resultKey) ?? null,
    isAnalyzing,
    error: fenError ?? (failure?.key === resultKey ? failure.message : null),
    refresh,
  };
}
