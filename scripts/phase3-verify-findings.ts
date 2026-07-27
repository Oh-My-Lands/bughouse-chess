#!/usr/bin/env tsx
/**
 * Mechanical checks on a review's findings, plus a position dump.
 *
 * Separates two questions that are easy to conflate. "Is this finding good
 * advice?" needs a bughouse player. "Is this finding about the position the
 * game was actually in, describing the move actually played, recommending a
 * move that is actually legal?" does not -- and a failure there explains a bad
 * report without any judgement being involved.
 *
 * Four checks, each aimed at a way the pipeline could be silently wrong:
 *
 *   1. Side to move. The analysed board's side to move must be the player
 *      being reviewed. If it is not, the search answered for the opponent and
 *      every verdict is meaningless.
 *   2. Partner-board parity. After k half-moves on the partner board, that
 *      board's side to move is determined. A mismatch means the interleave put
 *      the position at the wrong point in the partner's timeline -- the exact
 *      failure the 4.7% of tie-break orderings could cause.
 *   3. Played-move round trip. `playedMove` is a UCI string derived from the
 *      recorded SAN; the detector matches it against engine output. If the
 *      conversion is wrong, the detector scores the wrong move, or fails to
 *      find it and reports `unexplored`. Checked by applying both spellings and
 *      comparing the resulting positions, which is format-independent.
 *   4. Suggested-move legality. An illegal recommendation means the engine's
 *      lines are being read against the wrong position.
 *
 * Usage:  npx tsx scripts/phase3-verify-findings.ts
 */

import { readFileSync } from "fs";
import { join } from "path";

import type { ChessGame } from "../app/actions";
import type { BughousePositionSnapshot } from "../app/types/analysis";
import {
  validateAndApplyBughouseHalfMove,
  validateAndApplyMoveFromNotation,
} from "../app/utils/analysis/applyMove";
import { processGameData } from "../app/utils/board/moveOrdering";
import { engineMoveToAttempted, sideToMove } from "../app/utils/engine/engineMove";
import { buildReviewPositions } from "../app/utils/review/buildReviewPositions";

const GAME_ID = "160842422747";
const BOARD = "A" as const;
const SIDE = "white" as const;

/** The findings from the second review run, worst first. */
const FINDINGS: Array<{ ply: number; severity: string; better: string | null }> = [
  { ply: 99, severity: "BLUNDER", better: null }, // sit
  { ply: 95, severity: "MISTAKE", better: "N@g8" },
  { ply: 71, severity: "MISTAKE", better: "R@e8" },
  { ply: 83, severity: "INACCURACY", better: null }, // sit
  { ply: 58, severity: "INACCURACY", better: "R@g8" },
  { ply: 74, severity: "INACCURACY", better: "R@e8" },
  { ply: 88, severity: "INACCURACY", better: "Q@g3" },
  { ply: 61, severity: "INACCURACY", better: "R@e8" },
  { ply: 46, severity: "INACCURACY", better: "P@d5" },
  { ply: 32, severity: "INACCURACY", better: "f1e2" },
];

/**
 * Positions the review could never score.
 *
 * Both came back `low-confidence` at 20k *and* again at 200k: the engine never
 * gave the move actually played 500 visits even with ten times the search. They
 * are not failures to retry -- a tenfold budget already declined to look -- so
 * they are dumped alongside the findings to be reasoned about rather than
 * silently dropped.
 */
const UNSCORED = [24, 91];

function readGame(id: string): ChessGame {
  return JSON.parse(
    readFileSync(join(process.cwd(), `tests/fixtures/chesscom/${id}.json`), "utf8"),
  ) as ChessGame;
}

/** Renders a board FEN as ranks 8..1, for eyeballing without a viewer. */
function ascii(fen: string): string[] {
  const board = fen.split(/\s+/)[0].replace(/\[.*\]/, "");
  return board.split("/").map((rank, i) => {
    let out = "";
    for (const ch of rank) {
      if (/\d/.test(ch)) out += ". ".repeat(Number(ch));
      else out += `${ch} `;
    }
    return `  ${8 - i} | ${out.trimEnd()}`;
  });
}

function reservesLine(snapshot: BughousePositionSnapshot): string {
  const parts: string[] = [];
  for (const board of ["A", "B"] as const) {
    for (const side of ["white", "black"] as const) {
      const held = snapshot.reserves[board][side];
      const pieces = Object.entries(held)
        .filter(([, n]) => (n ?? 0) > 0)
        .map(([piece, n]) => `${piece.toUpperCase()}${n}`)
        .join("");
      if (pieces) parts.push(`${board}-${side[0]}: ${pieces}`);
    }
  }
  return parts.length > 0 ? parts.join("   ") : "(all empty)";
}

function samePosition(
  a: BughousePositionSnapshot,
  b: BughousePositionSnapshot,
): boolean {
  return (
    a.fenA === b.fenA &&
    a.fenB === b.fenB &&
    JSON.stringify(a.reserves) === JSON.stringify(b.reserves)
  );
}

function main(): void {
  const game = readGame(GAME_ID);
  const processed = processGameData(game, readGame(String(game.game.partnerGameId)));
  const { positions } = buildReviewPositions(processed.combinedMoves, {
    board: BOARD,
    side: SIDE,
  });

  let failures = 0;
  const fail = (ply: number, message: string) => {
    failures += 1;
    console.log(`  FAIL ply ${ply}: ${message}`);
  };

  console.log("=".repeat(78));
  console.log("MECHANICAL CHECKS");
  console.log("=".repeat(78));

  for (const finding of FINDINGS) {
    const position = positions.find((p) => p.globalPly === finding.ply);
    if (!position) {
      fail(finding.ply, "not among the reviewed positions");
      continue;
    }

    // 1. The analysed board must have the reviewed player to move.
    const toMove = sideToMove(position.position, BOARD);
    if (toMove !== SIDE) {
      fail(finding.ply, `board ${BOARD} has ${toMove} to move, expected ${SIDE}`);
    }

    // 2. Partner-board parity: after k half-moves there, white moves iff k is
    //    even. Catches a position taken from the wrong point in the interleave.
    const partnerMoves = processed.combinedMoves
      .slice(0, finding.ply)
      .filter((m) => m.board !== BOARD).length;
    const expectedPartner = partnerMoves % 2 === 0 ? "white" : "black";
    const actualPartner = sideToMove(position.position, BOARD === "A" ? "B" : "A");
    if (actualPartner !== expectedPartner) {
      fail(
        finding.ply,
        `partner board has ${actualPartner} to move after ${partnerMoves} ` +
          `half-moves, expected ${expectedPartner}`,
      );
    }

    // 3. The UCI the detector matches on must mean the same thing as the SAN
    //    the game recorded. Compared by resulting position, not by string.
    const fromSan = validateAndApplyMoveFromNotation(
      position.position,
      { board: BOARD, side: SIDE, move: position.san },
      { bypassCheckmateCheck: true },
    );
    const attempted = engineMoveToAttempted(position.playedMove, BOARD, position.position);
    const fromUci = attempted
      ? validateAndApplyBughouseHalfMove(position.position, attempted, {
          bypassCheckmateCheck: true,
        })
      : null;

    if (fromSan.type !== "ok") {
      fail(finding.ply, `recorded SAN ${position.san} did not apply`);
    } else if (fromUci === null || fromUci.type !== "ok") {
      fail(finding.ply, `UCI ${position.playedMove} did not apply`);
    } else if (!samePosition(fromSan.next, fromUci.next)) {
      fail(
        finding.ply,
        `${position.san} and ${position.playedMove} give different positions`,
      );
    }

    // 4. The recommendation must be legal. A sit always is.
    if (finding.better !== null) {
      const suggestion = engineMoveToAttempted(finding.better, BOARD, position.position);
      if (!suggestion) {
        fail(finding.ply, `suggested ${finding.better} could not be parsed`);
      } else {
        const applied = validateAndApplyBughouseHalfMove(position.position, suggestion, {
          bypassCheckmateCheck: true,
        });
        if (applied.type !== "ok") {
          const why = applied.type === "error" ? applied.message : "needs promotion";
          fail(finding.ply, `suggested ${finding.better} is illegal: ${why}`);
        }
      }
    }
  }

  console.log(
    failures === 0
      ? `  all checks passed for ${FINDINGS.length} findings\n`
      : `\n  ${failures} check(s) failed\n`,
  );

  console.log("=".repeat(78));
  console.log("POSITIONS");
  console.log("=".repeat(78));

  const dumped = [
    ...FINDINGS,
    ...UNSCORED.map((ply) => ({
      ply,
      severity: "UNSCORED",
      better: "(the engine never gave the played move 500 visits)",
    })),
  ];

  for (const finding of dumped) {
    const position = positions.find((p) => p.globalPly === finding.ply);
    if (!position) continue;

    console.log(
      `\n[${finding.severity}] ply ${finding.ply} -- ${SIDE} to move on board ${BOARD}`,
    );
    console.log(
      `  played:    ${position.san}  (${position.playedMove})` +
        `${position.orderingAmbiguous ? "   [ordering tie-break]" : ""}`,
    );
    console.log(`  engine:    ${finding.better ?? "sit (wait for the partner)"}`);
    console.log(`  reserves:  ${reservesLine(position.position)}`);
    console.log(`\n  board A (being reviewed)        board B (partner)`);
    const a = ascii(position.position.fenA);
    const b = ascii(position.position.fenB);
    for (let i = 0; i < 8; i++) {
      console.log(`${a[i].padEnd(34)}${b[i]}`);
    }
    console.log("      +----------------              +----------------");
    console.log("        a b c d e f g h                a b c d e f g h");
    console.log(`\n  FEN A: ${position.position.fenA}`);
    console.log(`  FEN B: ${position.position.fenB}`);
  }
}

main();
