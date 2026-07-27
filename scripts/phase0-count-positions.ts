#!/usr/bin/env tsx
/**
 * Phase 0 measurement: how many analysis positions does a real game contain?
 *
 * Post-game analysis prices itself per *position sent to the engine*, and in
 * bughouse that count is not the move number: the two boards interleave in real
 * time, so a review walks `combinedMoves` -- one snapshot per half-move on
 * either board -- not a per-board move list.
 *
 * This script reports, over every recorded fixture pair:
 *   - total review positions (both boards) vs one board only
 *   - the A/B split
 *   - how many adjacent pairs share a timestamp, because those are the ones
 *     whose ordering `createCombinedMoveList` resolves by preferring board A.
 *     A tie is a position whose partner-board state is a guess, and the engine
 *     reads both boards, so ties bound how exact any q value can be.
 *   - how often chess.com's timestamps regress (non-monotonic), which the
 *     replay path clamps but which signals the same ordering uncertainty.
 *
 * Usage:  npx tsx scripts/phase0-count-positions.ts
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { processGameData } from "../app/utils/board/moveOrdering";
import type { ChessGame } from "../app/actions";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/chesscom");

interface GameReport {
  gameId: number;
  partnerGameId: number;
  positions: number;
  boardA: number;
  boardB: number;
  /** Same-timestamp neighbours on *different* boards: genuinely reorderable. */
  tiedCrossBoard: number;
  /** Same-timestamp neighbours on the same board: order is fixed regardless. */
  tiedSameBoard: number;
  timestampRegressions: number;
  /** Half-moves by the player at (board, side) -- one review's worth per player. */
  perPlayer: Record<string, number>;
}

function loadFixtures(): Map<number, ChessGame> {
  const byId = new Map<number, ChessGame>();
  for (const file of readdirSync(FIXTURE_DIR)) {
    if (!file.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
    // `recordMatchFixtures.ts` writes match-discovery payloads into the same
    // directory; those have no `game` and are not a board.
    if (!parsed || typeof parsed !== "object" || !("game" in parsed)) continue;
    const game = parsed as ChessGame;
    byId.set(game.game.id, game);
  }
  return byId;
}

/**
 * Pair each game with its partner, keeping only one direction so a match is not
 * counted twice. The lower id is treated as board A, arbitrarily but stably.
 */
function pairGames(byId: Map<number, ChessGame>): Array<[ChessGame, ChessGame]> {
  const pairs: Array<[ChessGame, ChessGame]> = [];
  for (const game of byId.values()) {
    const partnerId = game.game.partnerGameId;
    if (partnerId === undefined) continue;
    if (game.game.id > partnerId) continue; // the partner side handles this pair
    const partner = byId.get(partnerId);
    if (!partner) continue; // partner fixture not recorded
    pairs.push([game, partner]);
  }
  return pairs;
}

function analyse(original: ChessGame, partner: ChessGame): GameReport {
  const processed = processGameData(original, partner);
  const moves = processed.combinedMoves;

  let boardA = 0;
  let tiedCrossBoard = 0;
  let tiedSameBoard = 0;
  let timestampRegressions = 0;
  const perPlayer: Record<string, number> = {
    Awhite: 0, Ablack: 0, Bwhite: 0, Bblack: 0,
  };

  for (let i = 0; i < moves.length; i++) {
    if (moves[i].board === "A") boardA += 1;
    perPlayer[`${moves[i].board}${moves[i].side}`] += 1;
    if (i === 0) continue;
    if (moves[i].timestamp === moves[i - 1].timestamp) {
      // Only a cross-board tie is ambiguous. Two moves on the same board have a
      // fixed order no matter what the clock says, so a tie there costs nothing.
      if (moves[i].board === moves[i - 1].board) tiedSameBoard += 1;
      else tiedCrossBoard += 1;
    }
    if (moves[i].timestamp < moves[i - 1].timestamp) timestampRegressions += 1;
  }

  return {
    gameId: original.game.id,
    partnerGameId: partner.game.id,
    positions: moves.length,
    boardA,
    boardB: moves.length - boardA,
    tiedCrossBoard,
    tiedSameBoard,
    timestampRegressions,
    perPlayer,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function main(): void {
  const byId = loadFixtures();
  const pairs = pairGames(byId);
  if (pairs.length === 0) {
    console.error(`no partnered fixture pairs found in ${FIXTURE_DIR}`);
    process.exit(1);
  }

  const reports = pairs.map(([a, b]) => analyse(a, b));
  reports.sort((x, y) => x.positions - y.positions);

  console.log(`fixture pairs analysed: ${reports.length}\n`);

  const positions = reports.map((r) => r.positions);
  const total = positions.reduce((s, n) => s + n, 0);
  const crossTies = reports.reduce((s, r) => s + r.tiedCrossBoard, 0);
  const sameTies = reports.reduce((s, r) => s + r.tiedSameBoard, 0);
  const regressions = reports.reduce((s, r) => s + r.timestampRegressions, 0);

  const stat = (label: string, values: number[]) =>
    console.log(
      `${label.padEnd(26)} min ${String(Math.min(...values)).padStart(3)}  ` +
        `median ${String(median(values)).padStart(5)}  ` +
        `mean ${(values.reduce((s, n) => s + n, 0) / values.length)
          .toFixed(1).padStart(5)}  ` +
        `max ${String(Math.max(...values)).padStart(3)}`,
    );

  console.log("--- review size, by scope (positions sent to the engine) ---");
  stat("all four players", positions);
  stat("one board (A)", reports.map((r) => r.boardA));
  stat("one team (A-w + B-b)",
    reports.map((r) => r.perPlayer.Awhite + r.perPlayer.Bblack));
  stat("one player (A white)", reports.map((r) => r.perPlayer.Awhite));

  console.log("\n--- ordering ambiguity ---");
  console.log(
    `cross-board timestamp ties: ${crossTies} of ${total} positions ` +
      `(${((crossTies / total) * 100).toFixed(1)}%) -- order resolved by ` +
      `preferring board A`,
  );
  console.log(
    `same-board ties: ${sameTies} (harmless; order is fixed by the board)`,
  );
  console.log(`timestamp regressions: ${regressions}`);
  const crossPerGame = reports.map((r) => r.tiedCrossBoard);
  stat("cross-board ties/game", crossPerGame);
}

main();
