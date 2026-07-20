import type { BughouseBoardId, BughousePositionSnapshot } from "@/app/types/analysis";
import { toEngineFen } from "@/app/utils/engine/bughouseFen";
import type { EngineMode } from "@/app/utils/engine/engineMode";
import { engineTeamColour } from "@/app/utils/engine/engineMode";

/**
 * Client for the Hivemind analysis endpoint.
 *
 * The endpoint returns one settled result per request: the caller asks for a
 * search budget and gets back the finished ranking. There is no streaming and
 * no session, so this is a plain fetch and the same code works against the
 * local dev server and the deployed RunPod endpoint -- they speak an identical
 * request/response shape on purpose.
 */

/** One candidate move on the analysed board. */
export interface EngineLine {
  /** 1-based rank; 1 is the engine's choice. */
  multipv: number;
  /**
   * The candidate move on the analysed board, in UCI. Null means "sit" --
   * a first-class action in bughouse, not a missing move.
   */
  move: string | null;
  /** What the partner plays in this line's first ply, if anything. */
  partnerMove: string | null;
  /**
   * Search value in [-1, 1] from the analysed side's perspective.
   *
   * This is the honest evaluation. `scoreCentipawns` is derived from it by a
   * tangent transform that saturates hard (q=0.99 maps to ~6700cp), so it is
   * only useful for ordering.
   */
  q: number;
  /**
   * How many visits back this line's q. A q from 100 visits is barely more
   * than a raw network eval; one from 20000 is a real estimate. Without this,
   * the two look identical.
   */
  visits: number;
  /** The network's prior probability for this move, before search. */
  prior: number;
  scoreCentipawns: number | null;
  /** Moves until mate when the search proved one, else null. */
  mateIn: number | null;
  depth: number;
  /** Continuation as joint actions; `a` is board A, `b` is board B. */
  pv: Array<{ a: string | null; b: string | null }>;
}

export interface EngineAnalysis {
  lines: EngineLine[];
  /** The engine's chosen joint action. */
  bestMoveA: string | null;
  bestMoveB: string | null;
  analysisBoard: BughouseBoardId;
  depth: number | null;
  nodes: number | null;
  timeMs: number | null;
  /**
   * Set when the search returned fewer lines than requested. Progressive
   * widening bounds how many distinct root moves exist, so a short search
   * simply cannot produce many candidates.
   */
  note?: string;
}

export interface AnalyzeRequest {
  position: BughousePositionSnapshot;
  board: BughouseBoardId;
  side: "white" | "black";
  multipv: number;
  mode: EngineMode;
  /** Node budgets are reproducible across machines; move times are not. */
  nodes?: number;
  movetimeMs?: number;
  signal?: AbortSignal;
}

export class EngineError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EngineError";
  }
}

interface RawLine {
  multipv?: number;
  move?: string | null;
  partnerMove?: string | null;
  q?: number;
  visits?: number;
  prior?: number;
  depth?: number;
  score?: { kind?: string; value?: number };
  pv?: Array<{ a: string | null; b: string | null }>;
}

function normaliseLine(raw: RawLine): EngineLine {
  const kind = raw.score?.kind;
  return {
    multipv: raw.multipv ?? 1,
    move: raw.move ?? null,
    partnerMove: raw.partnerMove ?? null,
    q: raw.q ?? 0,
    visits: raw.visits ?? 0,
    prior: raw.prior ?? 0,
    scoreCentipawns: kind === "cp" ? (raw.score?.value ?? null) : null,
    mateIn: kind === "mate" ? (raw.score?.value ?? null) : null,
    depth: raw.depth ?? 0,
    pv: raw.pv ?? [],
  };
}

/**
 * Runs one analysis request.
 *
 * `endpoint` is the base URL of the dev server or the RunPod endpoint; the
 * request is POSTed to `<endpoint>/run`.
 */
export async function analyzePosition(
  endpoint: string,
  request: AnalyzeRequest,
): Promise<EngineAnalysis> {
  const boardIndex = request.board === "A" ? 1 : 2;

  const body = {
    input: {
      fen: toEngineFen(request.position),
      analysisBoard: boardIndex,
      multipv: request.multipv,
      mode: request.mode,
      // The engine takes a colour, not a board, and plays the opposite colour
      // on board B -- so this is not simply `request.side`.
      team: engineTeamColour(request.board, request.side),
      ...(request.nodes ? { nodes: request.nodes } : {}),
      ...(request.movetimeMs ? { movetime: request.movetimeMs } : {}),
    },
  };

  let response: Response;
  try {
    response = await fetch(`${endpoint.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new EngineError(`could not reach the engine at ${endpoint}`, cause);
  }

  if (!response.ok) {
    throw new EngineError(`engine returned HTTP ${response.status}`);
  }

  let payload: { output?: Record<string, unknown>; error?: string };
  try {
    payload = await response.json();
  } catch (cause) {
    throw new EngineError("engine returned a malformed response", cause);
  }

  // RunPod wraps handler output in `output`; the dev server mirrors that.
  const output = (payload.output ?? payload) as Record<string, unknown>;

  if (typeof output.error === "string") {
    throw new EngineError(output.error);
  }

  const rawLines = Array.isArray(output.lines) ? (output.lines as RawLine[]) : [];

  return {
    lines: rawLines.map(normaliseLine).sort((a, b) => a.multipv - b.multipv),
    bestMoveA: (output.moveA as string | null) ?? null,
    bestMoveB: (output.moveB as string | null) ?? null,
    analysisBoard: request.board,
    depth: (output.depth as number | null) ?? null,
    nodes: (output.nodes as number | null) ?? null,
    timeMs: (output.time_ms as number | null) ?? null,
    ...(typeof output.note === "string" ? { note: output.note } : {}),
  };
}
