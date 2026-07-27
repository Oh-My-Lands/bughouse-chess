#!/usr/bin/env tsx
/**
 * Phase 3: run a two-pass review of one real game and print the report.
 *
 * This is also where Phase 1's exit criterion is settled -- the detector's
 * verdicts have to agree with a human reading of where the game turned, and
 * that cannot be established from synthetic rankings.
 *
 * Requests go through the app's own proxy (`/api/engine/run`) rather than
 * straight to RunPod. That costs a running dev server and buys three things:
 * the Phase 2 cache, so a second run of the same review is free; the proxy's
 * polling and cancellation, rather than a second copy of it here that would
 * drift; and coverage of the path the app actually uses.
 *
 * The dev server needs the cache switched on, which is off by default:
 *
 *   ANALYSIS_CACHE_PATH=/tmp/review-cache.sqlite npm run dev
 *   npx tsx scripts/phase3-review-game.ts
 *
 * Searches are issued strictly back to back. RunPod bills worker uptime, so a
 * pause between positions turns one shared startup into many.
 *
 * Usage:
 *   npx tsx scripts/phase3-review-game.ts                     # default game
 *   npx tsx scripts/phase3-review-game.ts 160842422747 A white
 *   ENGINE_ENDPOINT=http://127.0.0.1:3100/api/engine npx tsx scripts/...
 */

import { readFileSync } from "fs";
import { join } from "path";

import type { ChessGame } from "../app/actions";
import type { BughouseBoardId, BughouseSide } from "../app/types/analysis";
import { toEngineFen } from "../app/utils/engine/bughouseFen";
import { engineTeamColour } from "../app/utils/engine/engineMode";
import type { EngineLine } from "../app/utils/engine/engineClient";
import { processGameData } from "../app/utils/board/moveOrdering";
import { buildReviewPositions } from "../app/utils/review/buildReviewPositions";
import { THRESHOLD_SCAN, methodologyCaveats } from "../app/utils/review/detectMistake";
import {
  gradedMistakesFrom,
  reviewGame,
  severityCounts,
  type AnalyzePosition,
} from "../app/utils/review/reviewGame";
import { scanThresholdFor } from "../app/utils/review/severity";

const FIXTURES = join(process.cwd(), "tests/fixtures/chesscom");

const gameId = process.argv[2] ?? "160842422747";
const board = (process.argv[3] as BughouseBoardId) ?? "A";
const side = (process.argv[4] as BughouseSide) ?? "white";

/**
 * Base URL of the app's engine proxy. `/run` is appended, matching what
 * `engineClient.analyzePosition` does, so this exercises the same route the
 * browser hits. No RunPod credentials are read here -- they stay server-side,
 * which is the reason the proxy exists.
 */
const ENDPOINT = process.env.ENGINE_ENDPOINT ?? "http://127.0.0.1:3100/api/engine";

function readGame(id: string): ChessGame {
  return JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), "utf8")) as ChessGame;
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

function normalise(raw: RawLine): EngineLine {
  return {
    multipv: raw.multipv ?? 1,
    move: raw.move ?? null,
    partnerMove: raw.partnerMove ?? null,
    q: raw.q ?? 0,
    visits: raw.visits ?? 0,
    prior: raw.prior ?? 0,
    scoreCentipawns: raw.score?.kind === "cp" ? (raw.score.value ?? null) : null,
    mateIn: raw.score?.kind === "mate" ? (raw.score.value ?? null) : null,
    depth: raw.depth ?? 0,
    pv: raw.pv ?? [],
  };
}

function makeAnalyze(): AnalyzePosition {
  return async (position, nodes, multipv) => {
    const response = await fetch(`${ENDPOINT}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: {
          fen: toEngineFen(position.position),
          analysisBoard: position.board === "A" ? 1 : 2,
          // Hardcoded, and known to be wrong for positions where the team was
          // sitting: Mode feeds an NN input plane, so a "go" search evaluates a
          // sit-mode position under different rules. Tracked in the plan.
          mode: "go",
          team: engineTeamColour(position.board, position.side),
          multipv,
          nodes,
        },
      }),
    });

    const body = (await response.json()) as {
      output?: { lines?: RawLine[]; error?: string };
      error?: string;
    };

    if (!response.ok || body.error) {
      throw new Error(
        `ply ${position.globalPly}: ${body.error ?? `HTTP ${response.status}`}`,
      );
    }
    if (body.output?.error) throw new Error(`engine: ${body.output.error}`);

    return (body.output?.lines ?? []).map(normalise);
  };
}

async function main(): Promise<void> {
  const game = readGame(gameId);
  const partnerId = String(game.game.partnerGameId);
  const processed = processGameData(game, readGame(partnerId));

  const { positions, replayError } = buildReviewPositions(
    processed.combinedMoves,
    { board, side },
  );

  if (replayError) console.warn(`WARNING partial replay: ${replayError}\n`);

  const players = processed.players;
  const who =
    board === "A"
      ? side === "white" ? players.aWhite : players.aBlack
      : side === "white" ? players.bWhite : players.bBlack;

  console.log(`game ${gameId} + ${partnerId}`);
  console.log(`reviewing ${who.username} (board ${board}, ${side})`);
  console.log(
    `${processed.combinedMoves.length} plies total, ` +
      `${positions.length} to review\n`,
  );

  const started = Date.now();
  const report = await reviewGame(positions, makeAnalyze(), {
    onProgress: (done, total, phase) =>
      process.stdout.write(`\r${phase} ${done}/${total}   `),
  });
  process.stdout.write("\n\n");

  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `searches: ${report.searches.scan} scan + ${report.searches.deep} deep ` +
      `in ${elapsed.toFixed(0)}s`,
  );
  const promotionRate = (report.promoted / positions.length) * 100;
  console.log(
    `promotion rate: ${report.promoted}/${positions.length} ` +
      `(${promotionRate.toFixed(0)}%) -- the plan assumed 12%\n`,
  );

  console.log("--- played-move rank in the scan (sizes REVIEW_MULTIPV) ---");
  const ranks = [...report.playedRankHistogram.entries()].sort((a, b) => {
    if (a[0] === null) return 1;
    if (b[0] === null) return -1;
    return a[0] - b[0];
  });
  for (const [rank, count] of ranks) {
    console.log(`  rank ${rank === null ? "not reported" : String(rank).padEnd(3)}: ${count}`);
  }

  const lossOf = (verdict: { kind: string; loss?: number }): number | null =>
    verdict.kind === "mistake" || verdict.kind === "ok"
      ? (verdict.loss ?? null)
      : null;
  const show = (loss: number | null) => (loss === null ? "--" : loss.toFixed(4));

  console.log("\n--- verdicts, in game order ---");
  console.log("  ply  move              verdict          scan     deep");
  for (const entry of report.positions) {
    const { verdict, position } = entry;
    console.log(
      `  ply ${String(position.globalPly).padStart(3)}  ` +
        `${position.san.padEnd(8)} ${position.playedMove.padEnd(6)} ` +
        `${verdict.kind.padEnd(15)} ` +
        `${show(lossOf(entry.scanVerdict)).padStart(7)}  ` +
        `${(entry.depth === "deep" ? show(lossOf(verdict)) : "-").padStart(7)}` +
        `${position.orderingAmbiguous ? "  tie-break" : ""}`,
    );
  }

  /**
   * What raising the scan's cut would have saved on this game.
   *
   * THRESHOLD_SCAN was set from the 20k noise floor alone, before severity
   * bands existed. The constraint that actually governs it is the lowest
   * reported band less the scan's own error -- below that it promotes
   * positions no band would ever report, and each one costs a full deep
   * search. Only scan-flagged mistakes are affected: `unexplored` and
   * `low-confidence` promote whatever the threshold is.
   */
  const proposed = scanThresholdFor();
  const wouldNotPromote = report.positions.filter((entry) => {
    const loss = lossOf(entry.scanVerdict);
    return (
      entry.scanVerdict.kind === "mistake" &&
      loss !== null &&
      loss < proposed
    );
  });

  console.log(
    `\n--- scan threshold: ${THRESHOLD_SCAN} now, ${proposed.toFixed(4)} proposed ---`,
  );
  console.log(
    `  ${wouldNotPromote.length} of ${report.promoted} promotions would not ` +
      `happen (~${(wouldNotPromote.length * 25.6).toFixed(0)}s saved)`,
  );
  for (const entry of wouldNotPromote) {
    console.log(
      `    ply ${entry.position.globalPly} scan ${show(lossOf(entry.scanVerdict))} ` +
        `-> deep ${show(lossOf(entry.verdict))} (${entry.verdict.kind})`,
    );
  }

  const graded = gradedMistakesFrom(report);
  const counts = severityCounts(graded);
  console.log(
    `\n--- findings (deep verdicts only): ${counts.blunder} blunders, ` +
      `${counts.mistake} mistakes, ${counts.inaccuracy} inaccuracies ---`,
  );

  for (const { entry, severity, loss } of graded) {
    if (entry.verdict.kind !== "mistake") continue;
    const better = entry.verdict.reference;
    // A sit is a real action, not a missing move; naming it `null` in a report
    // reads as a bug rather than as advice.
    const name = (move: string | null) => move ?? "sit";
    console.log(
      `\n  [${severity.toUpperCase()}] ` +
        `ply ${entry.position.globalPly}: ` +
        `played ${entry.position.san} ` +
        `(q ${entry.verdict.played.q.toFixed(4)}, ${entry.verdict.played.visits} visits)`,
    );
    console.log(
      `    better: ${name(better.move)} ` +
        `(q ${better.q.toFixed(4)}, ${better.visits} visits) ` +
        `-- loses ${loss.toFixed(4)} q`,
    );
    for (const caveat of methodologyCaveats(entry.verdict)) {
      console.log(`    note: ${caveat}`);
    }
  }
}

main().catch((err) => {
  console.error(`\nreview failed: ${err.message}`);
  process.exit(1);
});
