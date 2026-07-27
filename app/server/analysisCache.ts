import { DatabaseSync } from "node:sqlite";

/**
 * Server-side store for finished analyses.
 *
 * `useEngineAnalysis` already caches results, but in a React `useState` map
 * that dies on reload -- so re-opening a game re-buys every search in it. Each
 * one is real GPU time on a RunPod endpoint billed by the second, and a game
 * review is tens of searches, so the second viewing of a report costs exactly
 * as much as the first.
 *
 * This is the durable half. It sits in the proxy, in front of RunPod, and is
 * keyed by everything that changes the answer.
 *
 * **On serving a stored result rather than re-searching.** The engine is not
 * reproducible: identical requests return different `visits` and can return a
 * different `bestmove`, because parallel MCTS threads race on expansion (see
 * SERVERLESS_STATUS.md). That makes this cache more than a cost measure -- it
 * is what makes a report *stable between viewings*. What is served is what was
 * stored, not a fresh coin toss. There is no canonical answer to recover, so
 * "is the cached value still right?" is not a question this can be wrong about.
 *
 * **Deliberately scope-free.** Rows describe one position at one budget and
 * know nothing about games, players, or reports. A review's scope -- one
 * player, one team, all four -- is a filter applied when generating the report,
 * so widening it later re-uses everything already paid for and needs no
 * migration. Storing a report shape here is the one change that would make the
 * scope decision expensive to reverse; do not.
 */

/**
 * Where the database lives. Unset disables the cache entirely.
 *
 * Off by default because a cache that silently appears on disk during tests or
 * a dev run is worse than one that has to be asked for. In production it is set
 * in the systemd unit, and it must point **outside** `/opt/analysis/app`:
 * `deploy.sh` rsyncs over that directory, which would delete the database on
 * every deploy.
 */
function cachePath(): string | undefined {
  // Read on open rather than at module load: the value is process-wide and
  // never changes in production, but reading it lazily is what lets a test
  // point the cache at a temporary file after importing this module.
  return process.env.ANALYSIS_CACHE_PATH;
}

/**
 * Identifies a search completely.
 *
 * These are the fields of the engine input that change the answer, named as the
 * handler names them rather than as the UI does. `team` and `analysisBoard`
 * together carry what the UI calls board + side; storing the derived pair is
 * what keeps this honest about being an engine-level cache.
 */
export interface AnalysisCacheKey {
  /** The full two-board `fenA|fenB`. Both boards feed the evaluation. */
  fen: string;
  analysisBoard: number;
  team: string;
  mode: string;
  nodes: number;
  multipv: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS analysis (
    fen            TEXT    NOT NULL,
    analysis_board INTEGER NOT NULL,
    team           TEXT    NOT NULL,
    mode           TEXT    NOT NULL,
    nodes          INTEGER NOT NULL,
    multipv        INTEGER NOT NULL,
    output         TEXT    NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (fen, analysis_board, team, mode, nodes, multipv)
  ) WITHOUT ROWID;
`;

type CacheState =
  | { kind: "disabled" }
  | { kind: "ready"; db: DatabaseSync }
  | { kind: "broken" };

let state: CacheState | null = null;

function open(): CacheState {
  const path = cachePath();
  if (!path) return { kind: "disabled" };
  try {
    const db = new DatabaseSync(path);
    // WAL lets reads proceed during a write, which matters because a review
    // fires its searches back to back and each completion writes a row.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(SCHEMA);
    return { kind: "ready", db };
  } catch (err) {
    // A cache is an optimisation; losing it must never take analysis down. The
    // likely causes are a path the service user cannot write (systemd's
    // ProtectSystem=strict) or a Node too old for node:sqlite, and both should
    // be loud in the log and invisible to the user.
    console.error(`analysis cache disabled: could not open ${path}`, err);
    return { kind: "broken" };
  }
}

function database(): DatabaseSync | null {
  state ??= open();
  return state.kind === "ready" ? state.db : null;
}

/**
 * Returns a stored analysis at least as deep and at least as wide as asked for,
 * or null.
 *
 * The inequality is the whole point of the budget being in the key. An entry
 * searched at 200k answers a 20k request -- more search is strictly a better
 * answer to the same question -- while a 20k entry must **not** answer a 200k
 * request, which is what a scope-blind `(fen, board, side, mode)` key would do.
 * That key is correct in `useEngineAnalysis`, where a deeper re-run overwrites
 * in place and the map dies on reload; copying it here would silently serve a
 * triage-grade scan as a final verdict.
 *
 * `multipv` is treated the same way: a result with fewer lines than requested
 * cannot have the missing ones recovered from it after the fact.
 */
export function readCachedAnalysis(key: AnalysisCacheKey): unknown | null {
  const db = database();
  if (!db) return null;

  try {
    const row = db
      .prepare(
        `SELECT output FROM analysis
          WHERE fen = ? AND analysis_board = ? AND team = ? AND mode = ?
            AND nodes >= ? AND multipv >= ?
          ORDER BY nodes DESC, multipv DESC
          LIMIT 1`,
      )
      .get(
        key.fen,
        key.analysisBoard,
        key.team,
        key.mode,
        key.nodes,
        key.multipv,
      ) as { output?: string } | undefined;

    if (!row?.output) return null;
    return JSON.parse(row.output);
  } catch (err) {
    console.error("analysis cache read failed", err);
    return null;
  }
}

/**
 * Stores a finished analysis.
 *
 * Only successful searches are stored: a handler-level error travels inside a
 * COMPLETED job's output, and caching one would make a transient engine failure
 * permanent for that position.
 */
export function writeCachedAnalysis(
  key: AnalysisCacheKey,
  output: unknown,
): void {
  const db = database();
  if (!db) return;

  if (
    !output ||
    typeof output !== "object" ||
    "error" in output ||
    !Array.isArray((output as { lines?: unknown }).lines)
  ) {
    return;
  }

  try {
    db.prepare(
      `INSERT OR REPLACE INTO analysis
         (fen, analysis_board, team, mode, nodes, multipv, output, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      key.fen,
      key.analysisBoard,
      key.team,
      key.mode,
      key.nodes,
      key.multipv,
      JSON.stringify(output),
      Date.now(),
    );
  } catch (err) {
    console.error("analysis cache write failed", err);
  }
}

/** Closes the handle. Exists for tests; the server holds it open for its life. */
export function closeAnalysisCache(): void {
  if (state?.kind === "ready") state.db.close();
  state = null;
}
