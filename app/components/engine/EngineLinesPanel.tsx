"use client";

import React from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import type { BughouseBoardId } from "../../types/analysis";
import type { EngineAnalysis, EngineLine } from "../../utils/engine/engineClient";
import type {
  EngineModeSetting,
  ModeDerivationResult,
} from "../../utils/engine/engineMode";

interface EngineLinesPanelProps {
  analysis: EngineAnalysis | null;
  isAnalyzing: boolean;
  error: string | null;
  modeInfo: ModeDerivationResult;
  /** Board the user is analysing. */
  board: BughouseBoardId;
  modeSetting: EngineModeSetting;
  onBoardChange: (board: BughouseBoardId) => void;
  onModeSettingChange: (setting: EngineModeSetting) => void;
  onRefresh: () => void;
  /** Plays a candidate into the variation tree. */
  onPlayMove?: (line: EngineLine) => void;
}

/**
 * "sit" is a real action in bughouse -- waiting for the partner rather than
 * moving. It has no from/to squares, so it needs a label of its own instead of
 * being rendered as a move or hidden.
 */
const SIT_LABEL = "sit";

function formatMove(move: string | null): string {
  return move ?? SIT_LABEL;
}

/**
 * Formats the evaluation.
 *
 * `q` leads because it is the honest number: it is what the search actually
 * optimises, on a bounded [-1, 1] scale. The centipawn figure is derived from
 * it by a tangent transform that saturates hard -- q=0.99 maps to about
 * 6700cp -- so it is shown as a secondary hint, not the headline.
 */
function formatEval(line: EngineLine): string {
  if (line.mateIn !== null) {
    return `#${line.mateIn > 0 ? "" : "-"}${Math.abs(line.mateIn)}`;
  }
  const sign = line.q > 0 ? "+" : "";
  return `${sign}${line.q.toFixed(3)}`;
}

function formatVisits(visits: number): string {
  if (visits >= 1_000_000) return `${(visits / 1_000_000).toFixed(1)}M`;
  if (visits >= 1_000) return `${(visits / 1_000).toFixed(1)}k`;
  return String(visits);
}

/**
 * How much of the search a line actually got.
 *
 * A q backed by 100 visits is barely more than a raw network evaluation, while
 * one backed by 20000 is a real estimate -- and they render identically as
 * numbers. This gives the difference a visual weight.
 */
function confidenceWidth(line: EngineLine, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.max(2, Math.round((line.visits / total) * 100))}%`;
}

function PvPreview({ line, board }: { line: EngineLine; board: BughouseBoardId }) {
  // PVs are joint actions over both boards. Showing only the user's half would
  // misrepresent the line, since the partner's moves are part of why it scores
  // as it does -- so both are shown, with the user's board emphasised.
  const plies = line.pv.slice(0, 6);
  return (
    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-slate-400">
      {plies.map((ply, index) => {
        const mine = board === "A" ? ply.a : ply.b;
        const theirs = board === "A" ? ply.b : ply.a;
        return (
          <span key={index} className="whitespace-nowrap">
            <span className="text-slate-200">{formatMove(mine)}</span>
            <span className="text-slate-500">/{formatMove(theirs)}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Ranked engine candidates for the board the user is analysing.
 *
 * The engine searches joint actions over both boards, so several of its raw
 * lines can share the same move on this board and differ only in what the
 * partner does. These are already grouped by the user's move, and the visit
 * count is summed across every partner pairing.
 */
export function EngineLinesPanel({
  analysis,
  isAnalyzing,
  error,
  modeInfo,
  board,
  modeSetting,
  onBoardChange,
  onModeSettingChange,
  onRefresh,
  onPlayMove,
}: EngineLinesPanelProps) {
  const lines = analysis?.lines ?? [];
  const totalVisits = lines.reduce((sum, line) => sum + line.visits, 0);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">Engine</span>
          {isAnalyzing && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
          )}
        </div>

        <div className="flex items-center gap-2">
          <BoardSelector board={board} onChange={onBoardChange} />
          <ModeSelector
            setting={modeSetting}
            modeInfo={modeInfo}
            onChange={onModeSettingChange}
          />
          <button
            type="button"
            onClick={onRefresh}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Re-run analysis"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded bg-rose-950/50 p-2 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!error && lines.length === 0 && (
        <p className="py-3 text-center text-xs text-slate-500">
          {isAnalyzing ? "Analysing…" : "No analysis yet."}
        </p>
      )}

      {lines.length > 0 && (
        <ol className="flex flex-col gap-1">
          {lines.map((line) => (
            <li key={line.multipv}>
              <button
                type="button"
                data-testid="engine-line-row"
                onClick={() => onPlayMove?.(line)}
                disabled={!onPlayMove || line.move === null}
                className="group w-full rounded px-2 py-1.5 text-left transition hover:bg-slate-800 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <div className="flex items-baseline gap-2">
                  <span className="w-4 shrink-0 text-xs text-slate-500">
                    {line.multipv}
                  </span>
                  <span
                    data-testid="engine-line-move"
                    className={`font-mono text-sm ${
                      line.move === null
                        ? "italic text-amber-300"
                        : "text-slate-100"
                    }`}
                  >
                    {formatMove(line.move)}
                  </span>
                  <span className="ml-auto font-mono text-sm tabular-nums text-slate-100">
                    {formatEval(line)}
                  </span>
                  {line.scoreCentipawns !== null && (
                    <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-slate-500">
                      {line.scoreCentipawns > 0 ? "+" : ""}
                      {(line.scoreCentipawns / 100).toFixed(2)}
                    </span>
                  )}
                </div>

                <div className="mt-1 flex items-center gap-2">
                  <div
                    className="h-0.5 rounded bg-sky-500/60"
                    style={{ width: confidenceWidth(line, totalVisits) }}
                    aria-hidden
                  />
                  <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                    {formatVisits(line.visits)} visits · p={line.prior.toFixed(3)}
                  </span>
                </div>

                <PvPreview line={line} board={board} />
              </button>
            </li>
          ))}
        </ol>
      )}

      {analysis?.note && (
        <p className="text-[10px] text-slate-500">{analysis.note}</p>
      )}

      {analysis && (
        <div className="flex gap-3 text-[10px] tabular-nums text-slate-500">
          {analysis.depth !== null && <span>depth {analysis.depth}</span>}
          {analysis.nodes !== null && (
            <span>{analysis.nodes.toLocaleString()} nodes</span>
          )}
          {analysis.timeMs !== null && <span>{analysis.timeMs} ms</span>}
        </div>
      )}
    </div>
  );
}

function BoardSelector({
  board,
  onChange,
}: {
  board: BughouseBoardId;
  onChange: (board: BughouseBoardId) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-slate-700 text-xs">
      {(["A", "B"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={board === option}
          className={`px-2 py-0.5 ${
            board === option
              ? "bg-slate-700 text-slate-100"
              : "text-slate-400 hover:bg-slate-800"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/**
 * Three-state Mode control.
 *
 * Auto is a real, returnable state rather than the absence of a choice, and it
 * shows what it currently resolves to -- Mode changes the evaluation, so
 * leaving the user to guess which rule set produced the numbers is not an
 * option.
 */
function ModeSelector({
  setting,
  modeInfo,
  onChange,
}: {
  setting: EngineModeSetting;
  modeInfo: ModeDerivationResult;
  onChange: (setting: EngineModeSetting) => void;
}) {
  const autoLabel = modeInfo.autoUnavailable
    ? "auto (no clocks)"
    : `auto (${modeInfo.autoMode})`;

  return (
    <div
      className="flex overflow-hidden rounded border border-slate-700 text-xs"
      title={
        modeInfo.autoUnavailable
          ? "This position has no clocks, so auto cannot track a time advantage. Falling back to go."
          : `Team clock difference: ${((modeInfo.diffDeciseconds ?? 0) / 10).toFixed(1)}s`
      }
    >
      {(["auto", "go", "sit"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={setting === option}
          className={`px-2 py-0.5 ${
            setting === option
              ? "bg-slate-700 text-slate-100"
              : "text-slate-400 hover:bg-slate-800"
          }`}
        >
          {option === "auto" ? autoLabel : option}
        </button>
      ))}
    </div>
  );
}
