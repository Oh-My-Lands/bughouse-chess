"use client";

import React, { useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

import {
  gradedMistakesFrom,
  type GradedMistake,
  type ReviewReport,
} from "@/app/utils/review/reviewGame";
import type { MistakeSeverity } from "@/app/utils/review/severity";
import {
  reviewScopeId,
  type ReviewScopeChoice,
} from "@/app/utils/review/reviewScope";
import type {
  ReviewProgress,
  ReviewStatus,
} from "@/app/hooks/useGameReview";

/**
 * The review's controls and its findings, worst first.
 *
 * Presentational only: every piece of state is owned by `useGameReview` in the
 * parent and passed down, matching `EngineLinesPanel`. That keeps the one place
 * that spends GPU time -- the hook -- separate from the many ways of drawing it.
 *
 * Slice 1 shows the finding list and jumps the board to a finding on click.
 * Anchoring severity marks onto the moves themselves (slice 2) and the
 * per-finding detail with board diagram and methodology caveats (slice 3) build
 * on this without changing it.
 */

interface GameReviewPanelProps {
  scopes: ReviewScopeChoice[];
  selectedScope: { board: "A" | "B"; side: "white" | "black" } | null;
  onSelectScope: (scope: ReviewScopeChoice) => void;
  status: ReviewStatus;
  progress: ReviewProgress | null;
  report: ReviewReport | null;
  positionCount: number;
  replayError: string | null;
  error: string | null;
  onStart: () => void;
  onCancel: () => void;
  /** Jump the board to the flagged move. */
  onJump: (globalPly: number) => void;
}

/**
 * The three severity bands as summary rows, ordered gentlest first to match the
 * card readers know from other review tools. Each row is a button that cycles
 * the board through the moves of its band; the colour is the only cue to which
 * band it is, so it carries the same meaning the old per-finding chips did.
 */
const SUMMARY_ROWS: {
  severity: MistakeSeverity;
  singular: string;
  plural: string;
  text: string;
}[] = [
  { severity: "inaccuracy", singular: "Inaccuracy", plural: "Inaccuracies", text: "text-blue-400" },
  { severity: "mistake", singular: "Mistake", plural: "Mistakes", text: "text-yellow-400" },
  { severity: "blunder", singular: "Blunder", plural: "Blunders", text: "text-red-400" },
];

export function GameReviewPanel(props: GameReviewPanelProps): React.ReactElement {
  const {
    scopes,
    selectedScope,
    onSelectScope,
    status,
    progress,
    report,
    positionCount,
    replayError,
    error,
    onStart,
    onCancel,
    onJump,
  } = props;

  const graded = useMemo(
    () => (report ? gradedMistakesFrom(report) : []),
    [report],
  );

  // The findings split by band and put back into game order. `gradedMistakesFrom`
  // sorts worst-first, which is right for a list but wrong for stepping through
  // a game -- cycling should walk the board forward, not by loss.
  const byCategory = useMemo(() => {
    const map: Record<MistakeSeverity, GradedMistake[]> = {
      blunder: [],
      mistake: [],
      inaccuracy: [],
    };
    for (const g of graded) map[g.severity].push(g);
    for (const list of Object.values(map)) {
      list.sort(
        (a, b) => a.entry.position.globalPly - b.entry.position.globalPly,
      );
    }
    return map;
  }, [graded]);

  // Where each band's cycle is parked. Clicking a band jumps to its next move;
  // clicking a different band restarts that band from its first.
  const [cycle, setCycle] = useState<{
    severity: MistakeSeverity;
    index: number;
  } | null>(null);

  const running = status === "running";
  const selectedId = selectedScope ? reviewScopeId(selectedScope) : null;

  const handleCategoryClick = (severity: MistakeSeverity) => {
    const list = byCategory[severity];
    if (list.length === 0) return;
    const index =
      cycle && cycle.severity === severity
        ? (cycle.index + 1) % list.length
        : 0;
    setCycle({ severity, index });
    onJump(list[index].entry.position.globalPly);
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-gray-700 bg-gray-800/60 p-3 text-sm text-gray-200">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-gray-100">Game review</span>
      </div>

      {/* Scope picker: one player at a time. */}
      <div className="flex flex-wrap gap-1.5">
        {scopes.map((scope) => {
          const id = reviewScopeId(scope);
          const active = id === selectedId;
          return (
            <button
              key={id}
              type="button"
              disabled={running}
              onClick={() => onSelectScope(scope)}
              className={[
                "rounded border px-2 py-1 text-xs transition-colors",
                active
                  ? "border-mariner-400 bg-mariner-600/30 text-white"
                  : "border-gray-600 bg-gray-900/50 text-gray-300 hover:border-gray-500",
                running ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              ].join(" ")}
              title={`Board ${scope.board}, ${scope.side}`}
            >
              {scope.username}
            </button>
          );
        })}
      </div>

      {/* Action row. */}
      {running ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs text-gray-300">
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {progress
                ? `${progress.phase === "scan" ? "Scanning" : "Deep search"} ${progress.done}/${progress.total}`
                : "Starting…"}
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded border border-gray-600 px-2 py-0.5 text-gray-300 hover:border-gray-500 hover:text-white"
            >
              <X className="h-3 w-3" aria-hidden />
              Cancel
            </button>
          </div>
          {progress ? (
            <div className="h-1.5 w-full overflow-hidden rounded bg-gray-700">
              <div
                className="h-full bg-mariner-500 transition-[width]"
                style={{
                  width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
          ) : null}
        </div>
      ) : status === "done" ? null : (
        // Only shown before a run. Once a review is done, the report is already
        // on screen and its inputs cannot change without leaving this state:
        // picking another scope re-derives the positions and drops back to
        // "idle", so the button reappears as "Review this player" on its own.
        // A "review again" here would only replay the server cache -- an
        // identical report at no GPU cost -- so it is deliberately absent.
        <button
          type="button"
          disabled={!selectedScope || positionCount === 0}
          onClick={onStart}
          className={[
            "inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors",
            "bg-mariner-600 text-white hover:bg-mariner-400",
            "disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500",
          ].join(" ")}
        >
          <Search className="h-4 w-4" aria-hidden />
          Review this player
          {selectedScope && positionCount > 0 ? (
            <span className="text-xs opacity-80">({positionCount} moves)</span>
          ) : null}
        </button>
      )}

      {replayError ? (
        <p className="text-xs text-yellow-300/80">
          The game only replayed partially, so this reviews the moves up to that
          point. {replayError}
        </p>
      ) : null}
      {error ? <p className="text-xs text-red-300">{error}</p> : null}

      {/* Summary. Three counts; each cycles the board through its band's moves. */}
      {status === "done" ? (
        graded.length === 0 ? (
          <p className="text-xs text-gray-400">
            No mistakes worth flagging for this player.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {SUMMARY_ROWS.map((row) => {
              const count = byCategory[row.severity].length;
              const empty = count === 0;
              const active = cycle?.severity === row.severity;
              return (
                <button
                  key={row.severity}
                  type="button"
                  disabled={empty}
                  onClick={() => handleCategoryClick(row.severity)}
                  title={empty ? undefined : `Cycle through ${row.plural.toLowerCase()}`}
                  className={[
                    "flex items-baseline gap-2 rounded px-1.5 py-0.5 text-left transition-colors",
                    empty
                      ? "cursor-default opacity-40"
                      : "cursor-pointer hover:bg-gray-900/50",
                    active && !empty ? "bg-gray-900/40" : "",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "w-4 shrink-0 text-right font-semibold tabular-nums",
                      row.text,
                    ].join(" ")}
                  >
                    {count}
                  </span>
                  <span className="text-gray-200">
                    {count === 1 ? row.singular : row.plural}
                  </span>
                  {active && count > 1 ? (
                    <span className="text-[10px] text-gray-500">
                      {cycle.index + 1}/{count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )
      ) : null}

    </div>
  );
}
