"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { BughouseBoardId, BughousePositionSnapshot } from "@/app/types/analysis";
import type { BughouseClocksSnapshotByBoard } from "@/app/types/bughouse";
import { EngineError, analyzePosition } from "@/app/utils/engine/engineClient";
import type { EngineAnalysis } from "@/app/utils/engine/engineClient";
import { BughouseFenError, toEngineFen } from "@/app/utils/engine/bughouseFen";
import { deriveEngineMode } from "@/app/utils/engine/engineMode";
import type {
  EngineModeSetting,
  ModeDerivationResult,
} from "@/app/utils/engine/engineMode";

export interface UseEngineAnalysisOptions {
  endpoint: string;
  position: BughousePositionSnapshot | null;
  board: BughouseBoardId;
  side: "white" | "black";
  clocks: BughouseClocksSnapshotByBoard | null;
  modeSetting: EngineModeSetting;
  multipv?: number;
  nodes?: number;
  /** When false, nothing is requested. Analysis costs GPU time. */
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
  /** What Mode resolved to and why; drives the UI's auto/override display. */
  modeInfo: ModeDerivationResult;
  /** Re-run for the current position, ignoring the debounce. */
  refresh: () => void;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MULTIPV = 5;
const DEFAULT_NODES = 200_000;

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
    clocks,
    modeSetting,
    multipv = DEFAULT_MULTIPV,
    nodes = DEFAULT_NODES,
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = options;

  const [analysis, setAnalysis] = useState<EngineAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const abortRef = useRef<AbortController | null>(null);

  const modeInfo = deriveEngineMode({ board, side, clocks, setting: modeSetting });
  const mode = modeInfo.mode;

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
    refreshToken,
  ].join("|");

  useEffect(() => {
    abortRef.current?.abort();

    if (!enabled || !position || !engineFen) {
      setIsAnalyzing(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    const timer = setTimeout(() => {
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
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // requestKey collapses the inputs that matter; the rest are read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, enabled, endpoint, debounceMs]);

  // Results belong to the position that produced them. Clearing on change stops
  // the panel showing another position's numbers while the next search runs.
  useEffect(() => {
    setAnalysis(null);
  }, [engineFen, board, side, mode]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  return {
    analysis,
    isAnalyzing,
    error: fenError ?? error,
    modeInfo,
    refresh,
  };
}
