#!/usr/bin/env tsx
/**
 * Phase 1b measurement: the run-to-run noise floor at `nodes: 20000`.
 *
 * Post-game analysis flags a mistake when the played move's `q` falls short of
 * the best line's `q` by more than some threshold. That threshold is only
 * meaningful above the search's own nondeterminism, and the figure recorded in
 * SERVERLESS_STATUS.md (~0.005 q between equal moves) was measured at 50,000
 * nodes. Pass 1 of the triage runs at 20,000, where the spread is wider and
 * unmeasured.
 *
 * What is measured, and why it is not simply "spread of q":
 *
 *   The detector reads a *difference* between two numbers from the SAME search
 *   (best line vs played move). Errors in those two may correlate, so the
 *   spread of the difference is the quantity that bounds a threshold -- not the
 *   spread of either term alone. Both are reported; `loss` is the one to size
 *   against.
 *
 * Also measured: whether `visits` predicts stability, which is what sets the
 * MIN_VISITS gate below which a q is not worth reading.
 *
 * Runs are round-robin over positions rather than 7-in-a-row per position, so
 * no measurement sees a tree retained from the identical previous search.
 *
 * Cost: 6 positions x 7 runs x 20k nodes, ~2.4s each worst case, pipelined at a
 * warm worker -- roughly 120s of billed time (~$0.01).
 *
 * Usage:  npx tsx scripts/phase1-noise-20k.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Raw results are written here as well as summarised to stdout. Re-deriving a
 * threshold from a different statistic then costs nothing instead of another
 * 42 searches, and the numbers behind any decision stay auditable.
 */
function rawOutFor(nodes: number): string {
  return join(process.cwd(), `scripts/phase1-noise-${nodes / 1000}k.raw.json`);
}

/**
 * The budget to measure. Pass 1 runs at 20k and pass 2 at 200k, and each needs
 * its own floor -- a threshold applied to 200k results cannot be justified by
 * 20k noise, which is the gap this script exists to close.
 */
const NODES = Number(process.argv[2] ?? 20_000);
const MULTIPV = 20;
const RUNS = 7;

const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1";

/**
 * The benchmark set from SERVERLESS_STATUS.md. Board B is startpos throughout,
 * to isolate board A. `team` must match the side to move or the search returns
 * an empty `lines` array rather than an error.
 */
const POSITIONS: Array<{ name: string; fenA: string; team: "white" | "black" }> = [
  { name: "opening", fenA: STARTPOS, team: "white" },
  {
    name: "italian",
    fenA: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R[] w KQkq - 0 1",
    team: "white",
  },
  {
    name: "tactical",
    fenA: "r1bq1b1N/pppbkNpp/4pn2/1B2p3/1b2P3/2N5/PPP2PPP/R1BQK2R[BPqrnnpppp] b KQ - 0 16",
    team: "black",
  },
  {
    name: "midgame",
    fenA: "r6r/pppk1Ppp/2n1q3/2Nn4/8/2P5/P1P1NPPP/R1B1K2R[QBNPPPPrbbbnnppppp] b KQ - 0 1",
    team: "black",
  },
  {
    name: "tactical2",
    fenA: "6rk/p5pp/2Q2p2/3p1n2/3P1P2/2N4P/PPP2P1P/6RK[RBr] b - - 0 31",
    team: "black",
  },
  { name: "pawnend", fenA: "4k3/pp3ppp/8/8/8/8/PP3PPP/4K3[] w - - 0 1", team: "white" },
];

interface EngineLine {
  move: string | null;
  q?: number;
  visits?: number;
  depth?: number;
  multipv?: number;
}

interface RunResult {
  lines: EngineLine[];
  nodes?: number;
  executionTime?: number;
}

function loadEnv(): { endpointId: string; apiKey: string } {
  const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  const get = (key: string): string => {
    const line = raw.split("\n").find((l) => l.startsWith(`${key}=`));
    if (!line) throw new Error(`${key} missing from .env.local`);
    return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  };
  return { endpointId: get("RUNPOD_ENDPOINT_ID"), apiKey: get("RUNPOD_API_KEY") };
}

/**
 * Submits with /run and polls, mirroring `app/api/engine/run/route.ts`.
 *
 * /runsync would be shorter, but it hands back no job id, so a run that hangs
 * cannot be cancelled and simply bills until the endpoint's own timeout.
 */
async function search(
  env: { endpointId: string; apiKey: string },
  position: { fenA: string; team: "white" | "black" },
): Promise<RunResult> {
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
        fen: `${position.fenA}|${STARTPOS}`,
        analysisBoard: 1,
        mode: "go",
        team: position.team,
        multipv: MULTIPV,
        nodes: NODES,
      },
    }),
  });
  const job = (await submitted.json()) as { id?: string; error?: string };
  if (!job.id) throw new Error(`submit failed: ${JSON.stringify(job)}`);

  const deadline = Date.now() + 180_000;
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
    ).json()) as {
      status?: string;
      output?: { lines?: EngineLine[]; nodes?: number; error?: string };
      executionTime?: number;
    };

    if (status.status === "COMPLETED") {
      if (status.output?.error) throw new Error(`engine: ${status.output.error}`);
      return {
        lines: status.output?.lines ?? [],
        nodes: status.output?.nodes,
        executionTime: status.executionTime,
      };
    }
    if (status.status && !["IN_QUEUE", "IN_PROGRESS"].includes(status.status)) {
      throw new Error(`job ${job.id} ended ${status.status}`);
    }
  }
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function main(): void {
  const env = loadEnv();
  const results = new Map<string, RunResult[]>(
    POSITIONS.map((p) => [p.name, [] as RunResult[]]),
  );

  void (async () => {
    const started = Date.now();
    // Round-robin: run r of every position before run r+1 of any, so the same
    // position is never searched twice in a row.
    for (let run = 0; run < RUNS; run++) {
      for (const position of POSITIONS) {
        const result = await search(env, position);
        results.get(position.name)!.push(result);
        process.stdout.write(
          `run ${run + 1}/${RUNS} ${position.name.padEnd(10)} ` +
            `lines=${String(result.lines.length).padStart(2)} ` +
            `nodes=${result.nodes} exec=${result.executionTime}ms\n`,
        );
      }
    }
    console.log(`\nall searches done in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    writeFileSync(
      rawOutFor(NODES),
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          nodes: NODES,
          multipv: MULTIPV,
          runs: RUNS,
          positions: POSITIONS,
          results: Object.fromEntries(results),
        },
        null,
        2,
      ),
    );
    console.log(`raw results written to ${rawOutFor(NODES)}\n`);
    report(results);
  })().catch((err) => {
    console.error(`\nmeasurement aborted: ${err.message}`);
    process.exit(1);
  });
}

function report(results: Map<string, RunResult[]>): void {
  console.log("=".repeat(78));
  console.log(`NOISE AT ${NODES} NODES, multipv ${MULTIPV}, ${RUNS} runs`);
  console.log("=".repeat(78));

  // Collected across all positions so the visits/stability relationship has
  // enough samples to bucket.
  const samples: Array<{ minVisits: number; lossSpread: number; qSpread: number }> = [];

  for (const [name, runs] of results) {
    const usable = runs.filter((r) => r.lines.length > 0);
    if (usable.length < 2) {
      console.log(`\n## ${name}: only ${usable.length} usable run(s), skipped`);
      continue;
    }

    // Rank-1 stability: which move the engine put first each run.
    const topMoves = usable.map((r) => r.lines[0].move ?? "?");
    const distinctTop = new Set(topMoves);

    // Moves present in every run are the ones a spread can be computed for.
    const moveRuns = new Map<string, Array<{ q: number; visits: number }>>();
    for (const run of usable) {
      for (const line of run.lines) {
        if (!line.move || line.q === undefined) continue;
        if (!moveRuns.has(line.move)) moveRuns.set(line.move, []);
        moveRuns.get(line.move)!.push({ q: line.q, visits: line.visits ?? 0 });
      }
    }

    console.log(`\n## ${name}`);
    console.log(
      `   lines returned: ${usable.map((r) => r.lines.length).join(",")}` +
        `   rank-1 move: ${[...distinctTop].join(" / ")}` +
        `${distinctTop.size > 1 ? "  <-- UNSTABLE" : ""}`,
    );

    // `loss` as the detector computes it: best line's q minus this move's q,
    // both from the same run.
    const bestQPerRun = usable.map((r) => r.lines[0].q ?? 0);
    const maxQPerRun = usable.map((r) =>
      Math.max(...r.lines.map((l) => l.q ?? -Infinity)),
    );
    const rank1IsMaxQ = bestQPerRun.every((q, i) => q === maxQPerRun[i]);
    if (!rank1IsMaxQ) {
      console.log(
        "   note: rank-1 is not the highest-q line in every run " +
          "(bestmove follows visits, not q)",
      );
    }

    console.log("   move        runs  mean visits   q spread   loss spread");
    const rows = [...moveRuns.entries()]
      .filter(([, obs]) => obs.length === usable.length)
      .map(([move, obs]) => {
        const qs = obs.map((o) => o.q);
        const visits = obs.map((o) => o.visits);
        const losses = usable.map((run, i) => {
          const line = run.lines.find((l) => l.move === move);
          return bestQPerRun[i] - (line?.q ?? 0);
        });
        return {
          move,
          meanVisits: visits.reduce((s, v) => s + v, 0) / visits.length,
          minVisits: Math.min(...visits),
          qSpread: spread(qs),
          lossSpread: spread(losses),
        };
      })
      .sort((a, b) => b.meanVisits - a.meanVisits);

    for (const row of rows) {
      samples.push({
        minVisits: row.minVisits,
        lossSpread: row.lossSpread,
        qSpread: row.qSpread,
      });
      console.log(
        `   ${row.move.padEnd(10)}${String(usable.length).padStart(5)}` +
          `${row.meanVisits.toFixed(0).padStart(13)}` +
          `${row.qSpread.toFixed(4).padStart(11)}` +
          `${row.lossSpread.toFixed(4).padStart(14)}`,
      );
    }
    const dropped = moveRuns.size - rows.length;
    if (dropped > 0) {
      console.log(`   (${dropped} move(s) absent from at least one run, omitted)`);
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log("VISITS vs STABILITY  -- what MIN_VISITS should be");
  console.log("=".repeat(78));
  console.log("min visits across runs   n    max loss spread   p90 loss spread");
  const buckets = [0, 50, 100, 250, 500, 1000, 2500, Infinity];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i];
    const hi = buckets[i + 1];
    const inBucket = samples.filter((s) => s.minVisits >= lo && s.minVisits < hi);
    if (inBucket.length === 0) continue;
    const spreads = inBucket.map((s) => s.lossSpread).sort((a, b) => a - b);
    const p90 = spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * 0.9))];
    console.log(
      `${`${lo} - ${hi === Infinity ? "inf" : hi}`.padEnd(25)}` +
        `${String(inBucket.length).padStart(3)}` +
        `${spreads[spreads.length - 1].toFixed(4).padStart(19)}` +
        `${p90.toFixed(4).padStart(18)}`,
    );
  }

  /**
   * The same relationship in visit *share* rather than absolute visits.
   *
   * This is the question an absolute MIN_VISITS cannot answer: 500 visits is
   * 2.5% of a 20k search and 0.25% of a 200k one, so a fixed gate trusts
   * relatively flimsier lines the deeper the search goes. If the noise tracks
   * share rather than count, the gate belongs in share.
   */
  console.log(`\n${"=".repeat(78)}`);
  console.log("VISIT SHARE vs STABILITY  -- should MIN_VISITS scale with nodes?");
  console.log("=".repeat(78));
  console.log("share of search        n    max loss spread   p90 loss spread");
  const shareBuckets = [0, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 1];
  for (let i = 0; i < shareBuckets.length - 1; i++) {
    const lo = shareBuckets[i];
    const hi = shareBuckets[i + 1];
    const inBucket = samples.filter(
      (s) => s.minVisits / NODES >= lo && s.minVisits / NODES < hi,
    );
    if (inBucket.length === 0) continue;
    const spreads = inBucket.map((s) => s.lossSpread).sort((a, b) => a - b);
    const p90 = spreads[Math.min(spreads.length - 1, Math.floor(spreads.length * 0.9))];
    console.log(
      `${`${(lo * 100).toFixed(2)}% - ${(hi * 100).toFixed(2)}%`.padEnd(23)}` +
        `${String(inBucket.length).padStart(3)}` +
        `${spreads[spreads.length - 1].toFixed(4).padStart(19)}` +
        `${p90.toFixed(4).padStart(18)}`,
    );
  }

  const all = samples.map((s) => s.lossSpread).sort((a, b) => a - b);
  if (all.length > 0) {
    console.log(
      `\noverall: n=${all.length}  median ${all[Math.floor(all.length / 2)].toFixed(4)}` +
        `  p90 ${all[Math.floor(all.length * 0.9)].toFixed(4)}` +
        `  max ${all[all.length - 1].toFixed(4)}`,
    );
    console.log(
      "\nA scan threshold must sit above the p90 for the visits bucket it trusts;\n" +
        "anything below the max in that bucket will report noise as a mistake.",
    );
  }
}

main();
