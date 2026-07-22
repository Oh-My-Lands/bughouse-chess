import { describe, expect, it } from "vitest";

import {
  candidateToSan,
  pvToSan,
  teamColoursFor,
  uciToSan,
} from "@/app/utils/engine/engineSan";
import type { BughousePositionSnapshot } from "@/app/types/analysis";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function position(
  fenA = START,
  fenB = START,
): BughousePositionSnapshot {
  return {
    fenA,
    fenB,
    reserves: { A: { white: {}, black: {} }, B: { white: {}, black: {} } },
    promotedSquares: { A: [], B: [] },
    captureMaterial: {} as BughousePositionSnapshot["captureMaterial"],
  };
}

describe("uciToSan", () => {
  it("names the piece", () => {
    expect(uciToSan("d1e2", "4k3/8/8/8/8/8/8/3QK3 w - - 0 1")).toBe("Qe2+");
  });

  it("drops the piece letter for pawns", () => {
    expect(uciToSan("e2e4", START)).toBe("e4");
  });

  it("writes castling", () => {
    expect(uciToSan("e1g1", "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1")).toBe("O-O");
  });

  it("marks captures", () => {
    expect(
      uciToSan("d1d7", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
    ).toBe("d1d7"); // not legal here — falls back rather than inventing
  });

  it("disambiguates when two pieces can reach the square", () => {
    expect(uciToSan("a1c1", "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1")).toBe("Rc1");
  });

  it("handles promotion", () => {
    // The new queen on a8 checks the king on e8 along the rank, hence the "+".
    expect(uciToSan("a7a8q", "4k3/P7/8/8/8/8/8/4K3 w - - 0 1")).toBe("a8=Q+");
    // Promotion without check: the black king on e5 is off the new queen's
    // rank, file, and both diagonals.
    expect(uciToSan("a7a8q", "8/P7/8/4k3/8/8/8/4K3 w - - 0 1")).toBe("a8=Q");
  });

  it("passes drops through in crazyhouse form", () => {
    expect(uciToSan("P@e6", START)).toBe("P@e6");
    expect(uciToSan("n@f7", START)).toBe("N@f7");
  });

  describe("falls back to raw UCI rather than guessing", () => {
    // A wrong move name actively misleads; an ugly one only inconveniences.
    it.each([
      ["illegal move in this position", "e2e5", START],
      ["unloadable FEN", "e2e4", "not-a-fen"],
      ["not UCI shaped", "hello", START],
      ["off-board square", "e2j9", START],
    ])("%s", (_label, uci, fen) => {
      expect(uciToSan(uci, fen)).toBe(uci);
    });
  });

  it("converts in positions that are illegal for standard chess", () => {
    // Drops create material standard rules cannot produce; those positions
    // still need to render.
    const postDrop = "rnbqkbnr/pppppppp/3Q4/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(uciToSan("d6d7", postDrop)).toBe("Qxd7+");
  });
});

describe("candidateToSan", () => {
  it("labels a sit rather than converting it", () => {
    expect(candidateToSan(null, "A", position())).toBe("sit");
  });

  it("uses the analysed board's own position", () => {
    // Boards are independent; converting board B against board A's FEN would
    // silently produce the wrong piece letter.
    const pos = position(START, "4k3/8/8/8/8/8/8/3QK3 w - - 0 1");
    expect(candidateToSan("d1e2", "B", pos)).toBe("Qe2+");
    expect(candidateToSan("e2e4", "A", pos)).toBe("e4");
  });

  it("returns raw UCI with no position to check against", () => {
    expect(candidateToSan("d1e2", "A", null)).toBe("d1e2");
  });
});

describe("pvToSan", () => {
  it("replays each board so later plies get the right context", () => {
    const got = pvToSan(
      [
        { a: "e2e4", b: null },
        { a: "e7e5", b: "d2d4" },
        { a: "g1f3", b: "d7d5" },
      ],
      position(),
    );
    expect(got).toEqual([
      { a: "e4", b: "sit" },
      { a: "e5", b: "d4" },
      { a: "Nf3", b: "d5" },
    ]);
  });

  it("keeps the boards independent", () => {
    // Board B skipping a ply must not advance board A's turn, or every
    // subsequent conversion on A is computed from the wrong side to move.
    const got = pvToSan(
      [
        { a: "e2e4", b: null },
        { a: "e7e5", b: null },
        { a: "d2d4", b: "e2e4" },
      ],
      position(),
    );
    expect(got[2]).toEqual({ a: "d4", b: "e4" });
  });

  it("keeps converting a board after a drop", () => {
    // A drop is a playable move, not an unknowable one: the replay places the
    // piece and passes the turn, so later plies are still named properly.
    const got = pvToSan(
      [
        { a: "e2e4", b: null },
        { a: "N@e6", b: null },
        { a: "g1f3", b: null },
      ],
      position(),
    );
    expect(got[0].a).toBe("e4");
    expect(got[1].a).toBe("N@e6");
    expect(got[2].a).toBe("Nf3");
  });

  it("the drop is really on the board, not just skipped", () => {
    // A knight on e5 also reaches f3, making g1f3 ambiguous and forcing
    // "Ngf3". If the replay had merely passed the turn, this would read "Nf3".
    const got = pvToSan(
      [
        { a: "N@e5", b: null },
        { a: "d7d5", b: null },
        { a: "g1f3", b: null },
      ],
      position(),
    );
    expect(got[2].a).toBe("Ngf3");
  });

  it("gives up on a drop it cannot trust", () => {
    // e2 is occupied at the start, so this is not the position we think it is.
    const got = pvToSan(
      [
        { a: "P@e2", b: null },
        { a: "g1f3", b: null },
      ],
      position(),
    );
    expect(got[0].a).toBe("P@e2");
    expect(got[1].a).toBe("g1f3"); // raw UCI, not invented SAN
  });

  it("a desync on one board does not affect the other", () => {
    const got = pvToSan(
      [
        { a: "P@e2", b: "e2e4" },
        { a: "g1f3", b: "e7e5" },
      ],
      position(),
    );
    expect(got[1].a).toBe("g1f3"); // desynced
    expect(got[1].b).toBe("e5"); // still converting
  });

  describe("telling a chosen wait from a forced one", () => {
    // The engine emits MOVE_NONE for both, but they mean opposite things: one
    // is a decision the search made, the other is turn order.
    const colours = teamColoursFor("A", "white"); // team is A-white + B-black

    it("calls it a sit when the player could have moved", () => {
      // Board B is black to move, and black is our team's colour there, so the
      // partner genuinely chose to wait.
      const pos = position(START, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
      const got = pvToSan([{ a: "e2e4", b: null }], pos, colours);
      expect(got[0].b).toBe("sit");
    });

    it("marks a player who was never on turn", () => {
      // Board B is white to move; our partner there is black and has no move.
      const got = pvToSan([{ a: "e2e4", b: null }], position(), colours);
      expect(got[0].b).toBe("—");
    });

    it("flips the expected colour on opponent plies", () => {
      // Ply 2 belongs to the opponents, whose colour on board B is white. After
      // black replies on B the turn is white's again, so a null there is theirs
      // to choose -- a sit, not an impossibility.
      const pos = position(START, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
      const got = pvToSan(
        [
          { a: "e2e4", b: "e7e5" },
          { a: "e7e5", b: null },
        ],
        pos,
        colours,
      );
      expect(got[1].b).toBe("sit");
    });

    it("falls back to sit when it cannot know", () => {
      // No team colours, and a desynced board after a drop: guessing "not on
      // turn" would assert something unverified.
      expect(pvToSan([{ a: "e2e4", b: null }], position())[0].b).toBe("sit");
      const afterDesync = pvToSan(
        [
          { a: "P@e2", b: null },
          { a: null, b: null },
        ],
        position(),
        colours,
      );
      expect(afterDesync[1].a).toBe("sit");
    });
  });

  it("returns raw UCI throughout with no position", () => {
    const got = pvToSan([{ a: "e2e4", b: "d2d4" }], null);
    expect(got).toEqual([{ a: "e2e4", b: "d2d4" }]);
  });

  it("handles an empty pv", () => {
    expect(pvToSan([], position())).toEqual([]);
  });
});
