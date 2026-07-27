#!/usr/bin/env tsx
/**
 * Phase 3, defect 2: what should the *reference* gate be at 200k?
 *
 * `MIN_VISITS = 500` was calibrated at 20k, where it is 2.5% of the search. At
 * 200k the same constant is 0.25%, so the deep pass admits relatively flimsier
 * lines as the baseline than the cheap pass does -- and the baseline is the one
 * role where a bad line does real damage, because it invents a loss rather than
 * merely reporting an imprecise one.
 *
 * Costs nothing to answer: every deep search of the reviewed game is in the
 * cache, so this re-grades stored rankings under candidate gates rather than
 * re-searching. No dev server, no RunPod, no GPU time.
 *
 *   ANALYSIS_CACHE_PATH=~/.local/share/bug-analyser/review-cache.sqlite \
 *     npx tsx scripts/phase3-reference-gate.ts
 *
 * One structural fact frames the whole sweep: raising the reference gate is
 * monotone. It can only remove candidates, which can only lower the reference
 * `q`, which can only shrink `loss`. So a higher gate never manufactures a
 * finding -- it can only shrink one, drop it below the inaccuracy floor, or (if
 * nothing survives) turn the position into `no-reference`. The question is
 * therefore not "which gate is safe" but "which findings are resting on a line
 * the search barely looked at".
 */

import { readFileSync } from "fs";
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
import { MIN_VISITS, detectMistake } from "../app/utils/review/detectMistake";
import {
  DEEP_NODES,
  DEEP_PLAYED_MIN_VISITS,
  REVIEW_MULTIPV,
  THRESHOLD_DEEP,
} from "../app/utils/review/reviewGame";
import { classifySeverity } from "../app/utils/review/severity";
import { readCachedAnalysis } from "../app/server/analysisCache";

const FIXTURES = join(process.cwd(), "tests/fixtures/chesscom");

const gameId = process.argv[2] ?? "160842422747";
const board = (process.argv[3] as BughouseBoardId) ?? "A";
const side = (process.argv[4] as BughouseSide) ?? "white";

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

/** The stored 200k ranking for a position, or null if it was never promoted. */
function cachedDeepLines(position: ReviewPosition): EngineLine[] | null {
  const output = readCachedAnalysis({
    fen: toEngineFen(position.position),
    analysisBoard: position.board === "A" ? 1 : 2,
    team: engineTeamColour(position.board, position.side),
    mode: "go",
    nodes: DEEP_NODES,
    multipv: REVIEW_MULTIPV,
  }) as { lines?: RawLine[] } | null;

  return output?.lines ? output.lines.map(normalise) : null;
}

/**
 * A candidate gate, as a function of the search that produced the lines.
 *
 * Expressed this way because the three families are indistinguishable on a
 * single budget -- 2,000 visits *is* 1% of 200k -- and differ only in how they
 * generalise. Picking between them from this data alone is not possible; what
 * this sweep can settle is which *level* is right at 200k, which then names the
 * constant whichever family is chosen.
 */
interface GatePolicy {
  label: string;
  gate: (lines: readonly EngineLine[], nodes: number) => number;
}

const POLICIES: GatePolicy[] = [
  { label: "absolute 500 (current)", gate: () => MIN_VISITS },
  { label: "absolute 1,000", gate: () => 1_000 },
  { label: "absolute 2,000  = 1% of nodes", gate: () => 2_000 },
  { label: "absolute 5,000  = 2.5% of nodes", gate: () => 5_000 },
  { label: "absolute 10,000 = 5% of nodes", gate: () => 10_000 },
  {
    // A different family: scales with how concentrated *this* search was, not
    // with the budget. A position where everything is forced puts 95% of visits
    // on one move, and 2.5% of nodes is then a much weaker bar than it looks.
    label: "5% of the most-visited line",
    gate: (lines) => 0.05 * Math.max(0, ...lines.map((l) => l.visits)),
  },
  {
    label: "10% of the most-visited line",
    gate: (lines) => 0.1 * Math.max(0, ...lines.map((l) => l.visits)),
  },
];

function main(): void {
  if (!process.env.ANALYSIS_CACHE_PATH) {
    console.error(
      "ANALYSIS_CACHE_PATH is unset, so the cache is disabled and there is " +
        "nothing to re-grade.",
    );
    process.exit(1);
  }

  const game = readGame(gameId);
  const processed = processGameData(game, readGame(String(game.game.partnerGameId)));
  const { positions } = buildReviewPositions(processed.combinedMoves, { board, side });

  const deep: Array<{ position: ReviewPosition; lines: EngineLine[] }> = [];
  for (const position of positions) {
    const lines = cachedDeepLines(position);
    if (lines) deep.push({ position, lines });
  }

  console.log(`game ${gameId}, board ${board} ${side}`);
  console.log(
    `${positions.length} reviewed positions, ${deep.length} with a cached ` +
      `${DEEP_NODES.toLocaleString()}-node search\n`,
  );

  if (deep.length === 0) {
    console.error("no deep rows in the cache -- wrong game, scope, or cache file?");
    process.exit(1);
  }

  const grade = (lines: readonly EngineLine[], position: ReviewPosition, gate: number) =>
    detectMistake(lines, position.playedMove, {
      orderingAmbiguous: position.orderingAmbiguous,
      threshold: THRESHOLD_DEEP,
      playedMinVisits: DEEP_PLAYED_MIN_VISITS,
      minVisits: gate,
    });

  // ---- What the current gate is actually resting on -------------------------
  console.log("=".repeat(78));
  console.log("REFERENCE LINES CHOSEN AT THE CURRENT GATE");
  console.log("=".repeat(78));
  console.log("  ply  reference  ref visits   share of  played visits   loss  band");
  console.log("                               top line");

  for (const { position, lines } of deep) {
    const verdict = grade(lines, position, MIN_VISITS);
    if (verdict.kind !== "mistake") continue;
    const top = Math.max(...lines.map((l) => l.visits));
    const share = (verdict.reference.visits / top) * 100;
    const band = classifySeverity(verdict.loss);
    console.log(
      `  ${String(position.globalPly).padStart(3)}  ` +
        `${(verdict.reference.move ?? "sit").padEnd(9)}  ` +
        `${verdict.reference.visits.toLocaleString().padStart(10)}  ` +
        `${`${share.toFixed(1)}%`.padStart(9)}  ` +
        `${verdict.played.visits.toLocaleString().padStart(13)}  ` +
        `${verdict.loss.toFixed(4)}  ` +
        `${band ?? "(below floor)"}`,
    );
  }

  // ---- The sweep ------------------------------------------------------------
  console.log(`\n${"=".repeat(78)}`);
  console.log("FINDINGS UNDER EACH CANDIDATE GATE");
  console.log("=".repeat(78));

  const baseline = new Map<number, number>();
  for (const { position, lines } of deep) {
    const verdict = grade(lines, position, MIN_VISITS);
    if (verdict.kind === "mistake" && classifySeverity(verdict.loss)) {
      baseline.set(position.globalPly, verdict.loss);
    }
  }

  for (const policy of POLICIES) {
    const kept: string[] = [];
    const changed: string[] = [];
    const lost: string[] = [];
    let noReference = 0;

    for (const { position, lines } of deep) {
      const gate = policy.gate(lines, DEEP_NODES);
      const verdict = grade(lines, position, gate);
      const before = baseline.get(position.globalPly);

      if (verdict.kind === "no-reference") noReference += 1;

      const after =
        verdict.kind === "mistake" && classifySeverity(verdict.loss) ? verdict.loss : null;

      if (before === undefined && after === null) continue;
      if (before === undefined && after !== null) {
        // Cannot happen -- raising the gate is monotone. Printed rather than
        // asserted so a violation shows up as evidence instead of a crash.
        changed.push(`ply ${position.globalPly} APPEARED at ${after.toFixed(4)} (!)`);
      } else if (after === null) {
        lost.push(`ply ${position.globalPly} (was ${before!.toFixed(4)}, ${verdict.kind})`);
      } else if (Math.abs(after - before!) > 1e-9) {
        changed.push(
          `ply ${position.globalPly} ${before!.toFixed(4)} -> ${after.toFixed(4)}`,
        );
      } else {
        kept.push(String(position.globalPly));
      }
    }

    console.log(`\n${policy.label}`);
    console.log(
      `  ${kept.length + changed.length} findings ` +
        `(${kept.length} unchanged, ${changed.length} re-scored, ` +
        `${lost.length} dropped, ${noReference} positions with no reference)`,
    );
    for (const line of changed) console.log(`    ~ ${line}`);
    for (const line of lost) console.log(`    - ${line}`);
  }
}

main();
