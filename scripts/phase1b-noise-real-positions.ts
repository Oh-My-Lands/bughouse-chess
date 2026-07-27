#!/usr/bin/env tsx
/**
 * Corrected 1b measurement: verdict noise on *real review positions*.
 *
 * The earlier measurement used the six benchmark FENs from
 * SERVERLESS_STATUS.md and put the 200k floor at 0.0125. Reviewing one game
 * twice then produced verdict swings up to 0.0553 -- 4x that -- and flipped
 * findings across severity bands. The benchmark set was measured in the wrong
 * regime: every one of those positions holds **board B at startpos** to isolate
 * board A, and most are quiet. Real review positions have both boards live with
 * full pockets, which the engine doc identifies as the slowest and most
 * branching-heavy case.
 *
 * Two differences from the earlier script, both deliberate:
 *
 *   - Positions come from an actual reviewed game, not a benchmark list.
 *   - The quantity measured is `loss` **as the detector computes it** -- via
 *     `detectMistake`, reference line and visits gate included -- rather than a
 *     per-move q spread. Bands are applied to `loss`, so `loss` is what has to
 *     be stable. A per-move spread understates it because the reference and the
 *     played move can move in opposite directions, which is exactly what
 *     happened at ply 99 (0.175 -> 0.225 between runs).
 *
 * Requests go **direct to RunPod, deliberately bypassing the proxy cache**: a
 * noise measurement repeats identical requests, which is precisely what the
 * cache exists to prevent. Routing through the proxy would return one stored
 * row seven times and report a spread of zero.
 *
 * Cost: 6 positions x 7 runs at 200k ~= 18 minutes, ~$0.07.
 *
 * Usage:  npx tsx scripts/phase1b-noise-real-positions.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import type { ChessGame } from "../app/actions";
import type { EngineLine } from "../app/utils/engine/engineClient";
import { toEngineFen } from "../app/utils/engine/bughouseFen";
import { engineTeamColour } from "../app/utils/engine/engineMode";
import { processGameData } from "../app/utils/board/moveOrdering";
import {
  buildReviewPositions,
  type ReviewPosition,
} from "../app/utils/review/buildReviewPositions";
import { detectMistake } from "../app/utils/review/detectMistake";
import { THRESHOLD_DEEP } from "../app/utils/review/reviewGame";
import { classifySeverity } from "../app/utils/review/severity";

const NODES = Number(process.argv[2] ?? 200_000);
const MULTIPV = 20;
const RUNS = 7;
const GAME_ID = "160842422747";

/**
 * Which plies to measure, spread across the game rather than chosen for having
 * already looked unstable.
 *
 * Picking the noisiest observed positions would measure a ceiling and call it a
 * floor. These are evenly spaced through the 29 reviewed positions and include
 * ones that agreed closely between the two review runs (0, 46) as well as ones
 * that moved (88, 99), so the spread of spreads is visible.
 */
const PLIES = [0, 29, 46, 61, 88, 99];

const RAW_OUT = join(
  process.cwd(),
  `scripts/phase1b-noise-real-${NODES / 1000}k.raw.json`,
);

function loadEnv(): { endpointId: string; apiKey: string } {
  const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const get = (key: string): string => {
    const line = raw.split("\n").find((l) => l.startsWith(`${key}=`));
    if (!line) throw new Error(`${key} missing from .env.local`);
    return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  };
  return { endpointId: get("RUNPOD_ENDPOINT_ID"), apiKey: get("RUNPOD_API_KEY") };
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

async function search(
  env: { endpointId: string; apiKey: string },
  position: ReviewPosition,
): Promise<EngineLine[]> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${env.apiKey}`,
  };
  const base = `https://api.runpod.ai/v2/${env.endpointId}`;

  const submitted = await fetch(`${base}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: {
        action: "move",
        fen: toEngineFen(position.position),
        analysisBoard: position.board === "A" ? 1 : 2,
        mode: "go",
        team: engineTeamColour(position.board, position.side),
        multipv: MULTIPV,
        nodes: NODES,
      },
    }),
  });
  const job = (await submitted.json()) as { id?: string };
  if (!job.id) throw new Error(`submit failed for ply ${position.globalPly}`);

  const deadline = Date.now() + 300_000;
  let waitMs = 150;
  for (;;) {
    if (Date.now() > deadline) {
      await fetch(`${base}/cancel/${job.id}`, { method: "POST", headers });
      throw new Error(`job ${job.id} exceeded the local deadline`);
    }
    await new Promise((r) => setTimeout(r, waitMs));
    waitMs = Math.min(Math.round(waitMs * 1.5), 1_000);

    const status = (await (
      await fetch(`${base}/status/${job.id}`, { headers })
    ).json()) as { status?: string; output?: { lines?: RawLine[]; error?: string } };

    if (status.status === "COMPLETED") {
      if (status.output?.error) throw new Error(`engine: ${status.output.error}`);
      return (status.output?.lines ?? []).map(normalise);
    }
    if (status.status && !["IN_QUEUE", "IN_PROGRESS"].includes(status.status)) {
      throw new Error(`job ${job.id} ended ${status.status}`);
    }
  }
}

interface Observation {
  loss: number | null;
  kind: string;
  severity: string | null;
  referenceMove: string | null;
  playedQ: number | null;
  referenceQ: number | null;
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

async function main(): Promise<void> {
  const read = (id: string) =>
    JSON.parse(
      readFileSync(join(process.cwd(), `tests/fixtures/chesscom/${id}.json`), "utf8"),
    ) as ChessGame;
  const game = read(GAME_ID);
  const processed = processGameData(game, read(String(game.game.partnerGameId)));
  const { positions } = buildReviewPositions(processed.combinedMoves, {
    board: "A",
    side: "white",
  });

  const selected = PLIES.map((ply) => {
    const found = positions.find((p) => p.globalPly === ply);
    if (!found) throw new Error(`ply ${ply} is not a reviewed position`);
    return found;
  });

  const env = loadEnv();
  const observations = new Map<number, Observation[]>(
    selected.map((p) => [p.globalPly, []]),
  );

  const started = Date.now();
  // Round-robin, so no measurement reuses the identical previous search's tree.
  for (let run = 0; run < RUNS; run++) {
    for (const position of selected) {
      const lines = await search(env, position);
      const verdict = detectMistake(lines, position.playedMove, {
        threshold: THRESHOLD_DEEP,
        orderingAmbiguous: position.orderingAmbiguous,
      });
      const loss =
        verdict.kind === "mistake" || verdict.kind === "ok" ? verdict.loss : null;
      observations.get(position.globalPly)!.push({
        loss,
        kind: verdict.kind,
        severity: loss === null ? null : classifySeverity(loss),
        referenceMove:
          verdict.kind === "mistake" || verdict.kind === "ok"
            ? verdict.reference.move
            : null,
        playedQ:
          verdict.kind === "mistake" || verdict.kind === "ok"
            ? verdict.played.q
            : null,
        referenceQ:
          verdict.kind === "mistake" || verdict.kind === "ok"
            ? verdict.reference.q
            : null,
      });
      process.stdout.write(
        `\rrun ${run + 1}/${RUNS} ply ${String(position.globalPly).padStart(3)}   `,
      );
    }
  }
  process.stdout.write("\n\n");
  console.log(`all searches done in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  writeFileSync(
    RAW_OUT,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        nodes: NODES,
        multipv: MULTIPV,
        runs: RUNS,
        gameId: GAME_ID,
        plies: PLIES,
        observations: Object.fromEntries(observations),
      },
      null,
      2,
    ),
  );
  console.log(`raw results written to ${RAW_OUT}\n`);

  console.log("=".repeat(78));
  console.log(`VERDICT NOISE ON REAL REVIEW POSITIONS, ${NODES} nodes, ${RUNS} runs`);
  console.log("=".repeat(78));

  const spreads: number[] = [];
  let bandFlips = 0;

  for (const [ply, runs] of observations) {
    const losses = runs.map((r) => r.loss).filter((l): l is number => l !== null);
    const severities = new Set(runs.map((r) => r.severity ?? "none"));
    const references = new Set(runs.map((r) => r.referenceMove ?? "sit"));

    console.log(`\n## ply ${ply}`);
    if (losses.length < 2) {
      console.log(`   only ${losses.length} scoreable run(s): ` +
        `${runs.map((r) => r.kind).join(",")}`);
      continue;
    }

    const s = spread(losses);
    spreads.push(s);
    if (severities.size > 1) bandFlips += 1;

    console.log(`   loss: ${losses.map((l) => l.toFixed(4)).join(" ")}`);
    console.log(
      `   min ${Math.min(...losses).toFixed(4)}  max ${Math.max(...losses).toFixed(4)}` +
        `  spread ${s.toFixed(4)}`,
    );
    console.log(
      `   severity: ${[...severities].join(" / ")}` +
        `${severities.size > 1 ? "   <-- BAND FLIP" : ""}`,
    );
    if (references.size > 1) {
      console.log(`   reference move changed: ${[...references].join(" / ")}`);
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  const sorted = [...spreads].sort((a, b) => a - b);
  console.log(
    `loss spread across ${sorted.length} positions: ` +
      `median ${sorted[Math.floor(sorted.length / 2)].toFixed(4)}  ` +
      `max ${sorted[sorted.length - 1].toFixed(4)}`,
  );
  console.log(`positions whose severity band changed between runs: ${bandFlips}`);
  console.log(
    `\nbenchmark-set estimate was 0.0125. A severity floor must clear the max ` +
      `above,\nnot the benchmark figure, or findings will appear and vanish ` +
      `between runs.`,
  );
}

main().catch((err) => {
  console.error(`\nmeasurement failed: ${err.message}`);
  process.exit(1);
});
