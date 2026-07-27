#!/usr/bin/env tsx
/**
 * Phase 3: the false-negatives check -- the standing evidence gap the plan
 * names as the one open question with real uncertainty.
 *
 * The two-pass review only ever deep-searches positions the 20k scan *promoted*.
 * A position the scan *cleared* (verdict "ok", loss below THRESHOLD_SCAN) is
 * reported as fine on the strength of one cheap search and never looked at
 * again. But the scan is a weak predictor of the deep loss -- Phase 3 measured
 * |scan - deep| reaching 0.1751 on promoted positions -- so a cleared position
 * could hide a real mistake the scan under-estimated. Nothing checks this, and
 * it cannot be answered from the cache: the cleared plies were never deep-
 * searched, so there is no stored 200k result to re-grade. It needs fresh GPU.
 *
 * This script:
 *   1. Runs the normal two-pass review of a game (fills the cache).
 *   2. Collects the positions the scan CLEARED -- the ones a false negative
 *      would hide in.
 *   3. Runs a fresh 200k search on each, and grades it with the *exact* deep
 *      config the report uses (THRESHOLD_DEEP, played-move gate dropped,
 *      reference gate scaled to the budget).
 *   4. Reports any cleared ply that grades inaccuracy-or-worse -- a mistake the
 *      scan let through.
 *
 * The raw deep lines are written to a .raw.json alongside, so the grading can be
 * revisited (different thresholds, different gate) without spending GPU again --
 * the same convention the Phase 1 noise scripts follow.
 *
 * Needs a dev server with the cache on and a live endpoint, same as
 * phase3-review-game.ts:
 *
 *   ANALYSIS_CACHE_PATH=/tmp/review-cache.sqlite npm run dev
 *   npx tsx scripts/phase3-false-negatives.ts
 *
 * Usage:
 *   npx tsx scripts/phase3-false-negatives.ts                       # sample below
 *   npx tsx scripts/phase3-false-negatives.ts 160842423883 A white  # one game
 *   npx tsx scripts/phase3-false-negatives.ts 160842423883:A:white 161527623399:A:white
 *
 * The default sample deliberately excludes game 160842422747, the one the
 * thresholds were tuned on -- measuring false negatives there would be marking
 * your own homework.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import type { ChessGame } from "../app/actions";
import type { BughouseBoardId, BughouseSide } from "../app/types/analysis";
import { toEngineFen } from "../app/utils/engine/bughouseFen";
import { engineTeamColour } from "../app/utils/engine/engineMode";
import type { EngineLine } from "../app/utils/engine/engineClient";
import { processGameData } from "../app/utils/board/moveOrdering";
import {
  buildReviewPositions,
  type ReviewPosition,
} from "../app/utils/review/buildReviewPositions";
import { detectMistake } from "../app/utils/review/detectMistake";
import {
  DEEP_NODES,
  DEEP_PLAYED_MIN_VISITS,
  REVIEW_MULTIPV,
  THRESHOLD_DEEP,
  referenceMinVisitsFor,
  reviewGame,
  type AnalyzePosition,
} from "../app/utils/review/reviewGame";
import { classifySeverity } from "../app/utils/review/severity";

const FIXTURES = join(process.cwd(), "tests/fixtures/chesscom");
const OUT_DIR = join(process.cwd(), "scripts");

/** A spread across both fixture clusters and the rating range; not the tuned game. */
const DEFAULT_SAMPLE = [
  "160842423883:A:white", // xshyne (2318), match cluster
  "161527623399:A:white", // Ellipsoul (2275), partner series
  "161528227057:A:white", // xshyne (2201)
  "161530622681:A:white", // Ellipsoul (2316)
  "161531824439:A:white", // xshyne (2226)
];

interface GameSpec {
  gameId: string;
  board: BughouseBoardId;
  side: BughouseSide;
}

function parseSpecs(argv: string[]): GameSpec[] {
  const specs = argv.length ? argv : DEFAULT_SAMPLE;
  // Support both "id:A:white" and the phase3-style "id A white" positional form.
  if (specs.length === 3 && !specs[0].includes(":") && /^\d+$/.test(specs[0])) {
    return [
      { gameId: specs[0], board: specs[1] as BughouseBoardId, side: specs[2] as BughouseSide },
    ];
  }
  return specs.map((s) => {
    const [gameId, board = "A", side = "white"] = s.split(":");
    return { gameId, board: board as BughouseBoardId, side: side as BughouseSide };
  });
}

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
          mode: "go", // hardcoded, same as the review path; tracked in the plan
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
      throw new Error(`ply ${position.globalPly}: ${body.error ?? `HTTP ${response.status}`}`);
    }
    if (body.output?.error) throw new Error(`engine: ${body.output.error}`);

    return (body.output?.lines ?? []).map(normalise);
  };
}

/** One cleared ply, deep-searched and graded. Serialised to the raw file. */
interface ClearedResult {
  globalPly: number;
  san: string;
  playedMove: string | null;
  orderingAmbiguous: boolean;
  scanLoss: number | null;
  deepKind: string;
  deepLoss: number | null;
  severity: string | null;
  deepLines: EngineLine[];
}

async function checkGame(spec: GameSpec, analyze: AnalyzePosition): Promise<ClearedResult[]> {
  const game = readGame(spec.gameId);
  const partnerId = String(game.game.partnerGameId);
  const processed = processGameData(game, readGame(partnerId));
  const { positions, replayError } = buildReviewPositions(processed.combinedMoves, {
    board: spec.board,
    side: spec.side,
  });
  if (replayError) console.warn(`  WARNING partial replay: ${replayError}`);

  console.log(
    `\n=== game ${spec.gameId} (board ${spec.board} ${spec.side}), ` +
      `${positions.length} review positions ===`,
  );

  // Pass 1 + 2, exactly as the report runs. We only want its scan verdicts, but
  // running the full review leaves the cache warm and matches production.
  const report = await reviewGame(positions, analyze, {
    onProgress: (done, total, phase) => process.stdout.write(`\r  ${phase} ${done}/${total}   `),
  });
  process.stdout.write("\n");

  // Cleared = the scan scored it and let it through. `unexplored`/`low-confidence`/
  // `no-reference`/`mistake` all promote, so they were already deep-searched.
  const cleared = report.positions.filter(
    (entry) => entry.scanVerdict.kind === "ok" && !entry.scanVerdict.promote,
  );
  const scanLossByPly = new Map<number, number>(
    cleared.map((e) => [
      e.position.globalPly,
      e.scanVerdict.kind === "ok" ? e.scanVerdict.loss : Number.NaN,
    ]),
  );
  const clearedPositions: ReviewPosition[] = cleared.map((e) => e.position);

  console.log(
    `  ${clearedPositions.length} cleared by the scan; deep-searching each at ${DEEP_NODES}`,
  );

  const results: ClearedResult[] = [];
  let done = 0;
  for (const position of clearedPositions) {
    const deepLines = await analyze(position, DEEP_NODES, REVIEW_MULTIPV);
    // Grade with the report's deep config, not the scan's.
    const verdict = detectMistake(deepLines, position.playedMove, {
      orderingAmbiguous: position.orderingAmbiguous,
      threshold: THRESHOLD_DEEP,
      playedMinVisits: DEEP_PLAYED_MIN_VISITS,
      minVisits: referenceMinVisitsFor(DEEP_NODES),
    });
    const deepLoss =
      verdict.kind === "mistake" || verdict.kind === "ok" ? verdict.loss : null;
    const severity = deepLoss !== null ? classifySeverity(deepLoss) : null;
    results.push({
      globalPly: position.globalPly,
      san: position.san,
      playedMove: position.playedMove,
      orderingAmbiguous: position.orderingAmbiguous,
      scanLoss: scanLossByPly.get(position.globalPly) ?? null,
      deepKind: verdict.kind,
      deepLoss,
      severity: severity ?? null,
      deepLines,
    });
    process.stdout.write(`\r  deep ${++done}/${clearedPositions.length}   `);
  }
  process.stdout.write("\n");

  const raw = { spec, generatedAt: new Date().toISOString(), deepNodes: DEEP_NODES, results };
  mkdirSync(OUT_DIR, { recursive: true });
  const rawPath = join(OUT_DIR, `phase3-false-negatives.${spec.gameId}.${spec.board}.raw.json`);
  writeFileSync(rawPath, JSON.stringify(raw, null, 2));

  const falseNegatives = results.filter((r) => r.severity !== null);
  const worst = results.reduce(
    (max, r) => (r.deepLoss !== null && r.deepLoss > max ? r.deepLoss : max),
    0,
  );
  console.log(
    `  -> ${falseNegatives.length} false negative(s) of ${results.length} cleared ` +
      `(worst cleared deep loss ${worst.toFixed(4)}); raw -> ${rawPath}`,
  );
  for (const fn of falseNegatives) {
    const name = (m: string | null) => m ?? "sit";
    console.log(
      `     ply ${fn.globalPly} ${name(fn.playedMove)} (${fn.san}): scan ` +
        `${fn.scanLoss?.toFixed(4) ?? "--"} -> deep ${fn.deepLoss?.toFixed(4)} ` +
        `[${fn.severity?.toUpperCase()}]`,
    );
  }
  return falseNegatives;
}

async function main(): Promise<void> {
  const specs = parseSpecs(process.argv.slice(2));
  const analyze = makeAnalyze();
  const started = Date.now();

  const allFalseNegatives: Array<{ spec: GameSpec; fn: ClearedResult }> = [];
  for (const spec of specs) {
    const fns = await checkGame(spec, analyze);
    for (const fn of fns) allFalseNegatives.push({ spec, fn });
  }

  const elapsed = (Date.now() - started) / 1000;
  console.log(`\n=== summary (${specs.length} game(s), ${elapsed.toFixed(0)}s) ===`);
  if (allFalseNegatives.length === 0) {
    console.log("No cleared ply graded inaccuracy-or-worse. The scan hid nothing on this sample.");
  } else {
    console.log(`${allFalseNegatives.length} false negative(s) across the sample:`);
    for (const { spec, fn } of allFalseNegatives) {
      console.log(
        `  ${spec.gameId} ply ${fn.globalPly}: deep loss ${fn.deepLoss?.toFixed(4)} ` +
          `[${fn.severity?.toUpperCase()}] -- scan reported this as fine`,
      );
    }
    console.log(
      "\nThese are the evidence the plan's false-negative gap was waiting for. " +
        "A non-zero count means the scan threshold or the one-search design lets " +
        "real mistakes through, and the report undercounts.",
    );
  }
}

main().catch((err) => {
  console.error(`\nfalse-negatives check failed: ${err.message}`);
  process.exit(1);
});
