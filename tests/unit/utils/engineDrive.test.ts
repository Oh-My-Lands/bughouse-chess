import { describe, expect, it } from "vitest";

import { analyzePosition } from "@/app/utils/engine/engineClient";
import { engineMoveToAttempted } from "@/app/utils/engine/engineMove";
import { deriveEngineMode } from "@/app/utils/engine/engineMode";
import type { BughousePositionSnapshot } from "@/app/types/analysis";
import type { BughouseClocksSnapshotByBoard } from "@/app/types/bughouse";

/**
 * End-to-end drive against a live engine, on positions with a known answer.
 *
 * The other suites check that each layer is self-consistent. This checks that
 * the assembled stack produces sensible chess: it only passes if the FEN
 * adapter, the grouping, the drop handling and the move converter are all
 * right at once.
 *
 *   ENGINE_ENDPOINT=http://localhost:8080 npx vitest run engineDrive
 */
const ENDPOINT = process.env.ENGINE_ENDPOINT;
const describeLive = ENDPOINT ? describe : describe.skip;

const IDLE = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";

function position(over: Partial<BughousePositionSnapshot> = {}): BughousePositionSnapshot {
  return {
    fenA: IDLE,
    fenB: IDLE,
    reserves: { A: { white: {}, black: {} }, B: { white: {}, black: {} } },
    promotedSquares: { A: [], B: [] },
    captureMaterial: {} as BughousePositionSnapshot["captureMaterial"],
    ...over,
  };
}

describeLive("live engine drive", () => {
  it("finds a mate by dropping a fed piece", async () => {
    /*
     * Board A, white to move, holding a queen in hand:
     *
     *   black king g8, boxed in by its own pawns on f7/g7/h7
     *
     * Q@e8 is mate: e8 covers the back rank, and the king's only escape
     * squares are occupied by its own pawns. This is the bughouse-specific
     * pattern -- there is no mate on the board, only one the reserve creates.
     */
    const got = await analyzePosition(ENDPOINT!, {
      position: position({
        fenA: "6k1/5ppp/8/8/8/8/8/6K1 w - - 0 1",
        reserves: {
          A: { white: { q: 1 }, black: {} },
          B: { white: {}, black: {} },
        },
      }),
      board: "A",
      side: "white",
      multipv: 3,
      mode: "go",
      nodes: 40_000,
    });

    const best = got.lines[0];
    expect(best.move).toBe("Q@e8");
    // Either a proven mate or a value pinned near a win.
    if (best.mateIn === null) {
      expect(best.q).toBeGreaterThan(0.9);
    } else {
      expect(best.mateIn).toBeGreaterThan(0);
    }

    // The drop must survive the trip back into the app's move shape, or the
    // panel could show it but not play it.
    const attempted = engineMoveToAttempted(best.move, "A", position());
    expect(attempted).toEqual({
      kind: "drop",
      board: "A",
      side: "white",
      piece: "q",
      to: "e8",
    });
  }, 180_000);

  /*
   * Positions below are deliberately ordinary -- a real opening array with one
   * piece removed.
   *
   * An earlier version of these tests used bare kings, which looked like a
   * clean way to isolate material. It is not: the value head never saw such a
   * position in training, and returns noise for it. A dead-drawn bare-kings
   * position evaluated to -0.376 rather than 0, while the same network scores
   * the real starting position at -0.019. Test positions have to stay inside
   * the distribution the network was trained on.
   */
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const BLACK_NO_QUEEN = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const WHITE_NO_QUEEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1";

  it("scores a material edge in favour of the side holding it", async () => {
    const got = await analyzePosition(ENDPOINT!, {
      position: position({ fenA: BLACK_NO_QUEEN, fenB: START }),
      board: "A", side: "white",
      multipv: 1, mode: "go", nodes: 20_000,
    });
    expect(got.lines[0].q).toBeGreaterThan(0);
  }, 180_000);

  it("scores the same edge against the side missing the piece", async () => {
    const got = await analyzePosition(ENDPOINT!, {
      position: position({ fenA: WHITE_NO_QUEEN, fenB: START }),
      board: "A", side: "white",
      multipv: 1, mode: "go", nodes: 20_000,
    });
    expect(got.lines[0].q).toBeLessThan(0);
  }, 180_000);

  it("flips sign when the same position is read from the other seat", async () => {
    // The strongest check on the team mapping: one position, two seats. Board A
    // white and board A black are on opposing teams, so their evaluations of an
    // identical position must have opposite signs.
    const shared = position({ fenA: BLACK_NO_QUEEN, fenB: START });

    const asWhite = await analyzePosition(ENDPOINT!, {
      position: shared, board: "A", side: "white",
      multipv: 1, mode: "go", nodes: 20_000,
    });
    const asBlack = await analyzePosition(ENDPOINT!, {
      position: shared, board: "A", side: "black",
      multipv: 1, mode: "go", nodes: 20_000,
    });

    expect(asWhite.lines[0].q).toBeGreaterThan(0);
    expect(asBlack.lines[0].q).toBeLessThan(0);
  }, 180_000);

  it("keeps material advantages modest, as bughouse should", async () => {
    // A whole queen moves the evaluation by about 0.1, not the near-decisive
    // swing it would be in chess -- pieces flow between boards, so material is
    // far less permanent. Worth pinning: if this ever reads like chess values,
    // something is wrong with the model or the plumbing.
    const got = await analyzePosition(ENDPOINT!, {
      position: position({ fenA: BLACK_NO_QUEEN, fenB: START }),
      board: "A", side: "white",
      multipv: 1, mode: "go", nodes: 20_000,
    });
    expect(Math.abs(got.lines[0].q)).toBeLessThan(0.5);
  }, 180_000);

  it("sends the mode that auto derives from the clocks", async () => {
    // A clear time lead for the analysed team resolves to sit, and the engine
    // must accept that combination rather than reject it.
    const clocks = {
      A: { white: 2000, black: 1000 },
      B: { white: 1000, black: 2000 },
    } as BughouseClocksSnapshotByBoard;

    const derived = deriveEngineMode({
      board: "A", side: "white", clocks, setting: "auto",
    });
    expect(derived.mode).toBe("sit");

    const got = await analyzePosition(ENDPOINT!, {
      position: position({ fenA: "4k3/8/8/8/8/8/8/3QK3 w - - 0 1" }),
      board: "A", side: "white",
      multipv: 3, mode: derived.mode, nodes: 20_000,
    });
    expect(got.lines.length).toBeGreaterThan(0);
  }, 180_000);
});
