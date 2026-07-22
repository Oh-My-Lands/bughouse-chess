"use client";

import React from "react";
import { AlertTriangle, Loader2, Play, RefreshCw } from "lucide-react";

import type {
  BughouseBoardId,
  BughousePositionSnapshot,
  BughouseSide,
} from "../../types/analysis";
import {
  NOT_ON_TURN_LABEL,
  candidateToSan,
  pvToSan,
  teamColoursFor,
} from "../../utils/engine/engineSan";
import type { EngineAnalysis, EngineLine } from "../../utils/engine/engineClient";
import { useShowAllPlies } from "../../utils/preferences/useShowAllPlies";
import { setShowAllPlies } from "../../utils/preferences/userPreferencesService";
import type { EngineMode } from "../../utils/engine/engineMode";

interface EngineLinesPanelProps {
  analysis: EngineAnalysis | null;
  isAnalyzing: boolean;
  error: string | null;
  /** Board the user is analysing. */
  board: BughouseBoardId;
  /** Colour being analysed on that board -- the side to move there. */
  side: BughouseSide;
  /**
   * Position the analysis was run on. Used only to render moves as algebraic
   * notation; the underlying moves stay UCI everywhere else.
   */
  position: BughousePositionSnapshot | null;
  /** Engine time model. */
  mode: EngineMode;
  /** Search budget in nodes. */
  nodes: number;
  /** How many candidate moves to rank. */
  multipv: number;
  onBoardChange: (board: BughouseBoardId) => void;
  onModeChange: (mode: EngineMode) => void;
  onNodesChange: (nodes: number) => void;
  onMultipvChange: (multipv: number) => void;
  /** Runs one search for the current position. */
  onRefresh: () => void;
  /** Plays a candidate into the variation tree. */
  onPlayMove?: (line: EngineLine) => void;
}

/**
 * How many candidate moves to rank.
 *
 * Unlike the node budget, this is free: measured on an RTX 4090, 1 line and 8
 * lines both cost 50,016 nodes and ~3.5s. MultiPV reports more of the tree the
 * search already built rather than searching harder. The catch is confidence,
 * not time -- the search concentrates its visits on the moves it likes, so the
 * lower-ranked lines are backed by very few visits and their evaluations are
 * correspondingly weak. Watch the visit bar, not the rank.
 *
 * Every search asks the engine for the top option here regardless of the
 * selection, so switching between these is a filter over a result already in
 * hand -- no request, no wait. See ENGINE_MULTIPV in useEngineAnalysis.
 */
const MULTIPV_OPTIONS = [1, 2, 3, 4, 5] as const;

/**
 * Search budgets, with the cost of each made visible.
 *
 * The cost worth showing is billed seconds, not search seconds. Every request
 * pays roughly 20s of fixed overhead -- ~5.5s of worker startup plus the 15s
 * `idleTimeout` -- whatever budget it asks for, so nodes are far cheaper
 * against money than against wall clock. That is why the floor is 50k. The old
 * 5k option billed ~21s against 200k's ~48s: 44% of the cost for 2.5% of the
 * analysis, which made it not a cheap choice but a wasteful one.
 *
 * Durations are worst case on the endpoint's RTX 4000 Ada (8,196 nps, measured
 * on a middlegame holding 18 pieces in hand — pocket size, not tactics, is what
 * makes a bughouse position slow). The labels here once read 0.4s/1.4s/3.5s/14s,
 * a flat 14,286 nps from the RTX 4090 dev pod that understated every tier ~2x.
 *
 * Depth is deliberately absent. At a fixed 20k nodes the same search reached
 * depth 11 in the opening and 15 in a pawn endgame: effort is what you buy, and
 * the depth it reaches is a property of the position, not of the budget.
 */
const NODE_OPTIONS = [
  { nodes: 50_000, label: "50k", detail: "~6s · ~27s billed" },
  { nodes: 200_000, label: "200k", detail: "~24s · ~45s billed" },
  { nodes: 500_000, label: "500k", detail: "~61s · ~82s billed" },
] as const;

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

/** "—" is short by design; the meaning lives in the tooltip. */
function titleFor(label: string): string | undefined {
  return label === NOT_ON_TURN_LABEL ? "Not on turn -- no move possible" : undefined;
}

/** Plies shown per candidate line when not showing the full variation. */
const PV_PREVIEW_PLIES = 6;

function PvPreview({
  line,
  board,
  side,
  position,
  showAllPlies,
}: {
  line: EngineLine;
  board: BughouseBoardId;
  side: BughouseSide;
  position: BughousePositionSnapshot | null;
  showAllPlies: boolean;
}) {
  // PVs are joint actions over both boards. Showing only the user's half would
  // misrepresent the line, since the partner's moves are part of why it scores
  // as it does -- so both are shown, with the user's board emphasised.
  //
  // Converted as a whole rather than per ply: naming a move needs the position
  // it is played in, so the variation has to be replayed from the start.
  // Team colours let the replay tell a chosen wait from a forced one, so a
  // partner who simply is not on turn does not read as a decision to stall.
  const pv = showAllPlies ? line.pv : line.pv.slice(0, PV_PREVIEW_PLIES);
  const plies = pvToSan(pv, position, teamColoursFor(board, side));
  return (
    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-slate-400">
      {plies.map((ply, index) => {
        const mine = board === "A" ? ply.a : ply.b;
        const theirs = board === "A" ? ply.b : ply.a;
        return (
          <span key={index} className="whitespace-nowrap">
            <span className="text-slate-200" title={titleFor(mine)}>
              {mine}
            </span>
            <span className="text-slate-500" title={titleFor(theirs)}>
              /{theirs}
            </span>
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
  board,
  side,
  mode,
  position,
  nodes,
  multipv,
  onBoardChange,
  onModeChange,
  onNodesChange,
  onMultipvChange,
  onRefresh,
  onPlayMove,
}: EngineLinesPanelProps) {
  const lines = analysis?.lines ?? [];
  const totalVisits = lines.reduce((sum, line) => sum + line.visits, 0);
  const showAllPlies = useShowAllPlies();

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">Engine</span>
          <label
            className="flex cursor-pointer items-center gap-1 text-xs text-slate-400 hover:text-slate-300"
            title="Show each candidate's full line instead of the first few moves"
          >
            <input
              type="checkbox"
              checked={showAllPlies}
              onChange={(e) => setShowAllPlies(e.target.checked)}
              className="h-3 w-3 rounded border-slate-600 bg-slate-800 text-mariner-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mariner-400/60"
            />
            All plies
          </label>
          {isAnalyzing && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
          )}
        </div>

        <div className="flex items-center gap-2">
          <BoardSelector board={board} onChange={onBoardChange} />
          <ModeSelector mode={mode} onChange={onModeChange} />
          {/*
            The empty state offers its own labelled button, which is far more
            discoverable than a bare icon. Showing both would be two controls
            doing one thing, so this one defers until there is a result to
            re-run -- or an error to retry.
          */}
          {(lines.length > 0 || error) && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isAnalyzing}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40"
              aria-label="Run analysis"
              title="Analyse this position again"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <MultiPvSelector multipv={multipv} onChange={onMultipvChange} />
        <NodeSelector nodes={nodes} onChange={onNodesChange} />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded bg-rose-950/50 p-2 text-xs text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!error && lines.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-3">
          {isAnalyzing ? (
            <p className="text-xs text-slate-500">Analysing…</p>
          ) : (
            <>
              <p className="text-xs text-slate-500">No analysis yet.</p>
              <button
                type="button"
                onClick={onRefresh}
                className="flex items-center gap-1.5 rounded border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              >
                <Play className="h-3 w-3" />
                Analyse this position
              </button>
            </>
          )}
        </div>
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
                    {candidateToSan(line.move, board, position)}
                  </span>
                  {/*
                    q alone. The centipawn figure the engine also reports is a
                    pure function of q (180*tan(1.56*q)), so showing both put two
                    columns where there is one measurement -- and the pawn unit
                    misleads in bughouse, where material flows between boards: a
                    whole queen moves the evaluation only ~0.1, which reads as
                    "slight edge" to anyone importing chess intuition.
                  */}
                  <span
                    className="ml-auto font-mono text-sm tabular-nums text-slate-100"
                    title="The engine's verdict on this move, from the analysed side's view: +1 winning, 0 even, −1 losing. Mates show as #N."
                  >
                    {formatEval(line)}
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-2">
                  <div
                    className="h-0.5 rounded bg-sky-500/60"
                    style={{ width: confidenceWidth(line, totalVisits) }}
                    aria-hidden
                  />
                  <span className="shrink-0 text-xs tabular-nums text-slate-500">
                    <span title="How much the engine studied this move.">
                      {formatVisits(line.visits)} visits
                    </span>{" "}
                    ·{" "}
                    <span title="The engine's instinct for this move before any calculation.">
                      p={line.prior.toFixed(3)}
                    </span>
                  </span>
                </div>

                <PvPreview
                  line={line}
                  board={board}
                  side={side}
                  position={position}
                  showAllPlies={showAllPlies}
                />
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
          {analysis.nodes !== null && (
            <span>{analysis.nodes.toLocaleString()} nodes</span>
          )}
          {analysis.timeMs !== null && (
            <span>{(analysis.timeMs / 1000).toFixed(1)} s</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * How many candidate moves to rank.
 *
 * Presented next to the node budget on purpose, because the two trade off
 * differently: nodes cost time, lines cost nothing. See MULTIPV_OPTIONS.
 */
function MultiPvSelector({
  multipv,
  onChange,
}: {
  multipv: number;
  onChange: (multipv: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">
        lines
      </span>
      <div className="flex overflow-hidden rounded border border-slate-700 text-xs">
        {MULTIPV_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={multipv === option}
            className={`px-1.5 py-0.5 ${
              multipv === option
                ? "bg-slate-700 text-slate-100"
                : "text-slate-400 hover:bg-slate-800"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Search budget. See NODE_OPTIONS for why the cost is shown alongside. */
function NodeSelector({
  nodes,
  onChange,
}: {
  nodes: number;
  onChange: (nodes: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">
        nodes
      </span>
      <div className="flex overflow-hidden rounded border border-slate-700 text-xs">
        {NODE_OPTIONS.map((option) => (
          <button
            key={option.nodes}
            type="button"
            onClick={() => onChange(option.nodes)}
            aria-pressed={nodes === option.nodes}
            title={option.detail}
            className={`px-1.5 py-0.5 ${
              nodes === option.nodes
                ? "bg-slate-700 text-slate-100"
                : "text-slate-400 hover:bg-slate-800"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
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

/** Hover text per mode, keyed by the option it describes. */
const MODE_TITLES: Record<EngineMode, string> = {
  go: "downtime",
  sit: "uptime (double-sitting allowed)",
};

/**
 * Mode control.
 *
 * Explicit rather than derived from the clocks: Mode is hashed into the
 * position key, so a value that changes on its own silently invalidates the
 * tree and moves the evaluation under whoever is reading it.
 */
function ModeSelector({
  mode,
  onChange,
}: {
  mode: EngineMode;
  onChange: (mode: EngineMode) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-slate-700 text-xs">
      {(["go", "sit"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={mode === option}
          title={MODE_TITLES[option]}
          className={`px-2 py-0.5 ${
            mode === option
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
