import { describe, expect, it } from "vitest";

import {
  BughouseFenError,
  fromEngineBoardFen,
  fromEngineFen,
  toEngineBoardFen,
  toEngineFen,
  toEngineMove,
} from "@/app/utils/engine/bughouseFen";
import type { BughousePositionSnapshot } from "@/app/types/analysis";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const emptyReserves = () => ({ white: {}, black: {} });

function snapshot(
  over: Partial<BughousePositionSnapshot> = {},
): BughousePositionSnapshot {
  return {
    fenA: START,
    fenB: START,
    reserves: {
      A: emptyReserves(),
      B: emptyReserves(),
    },
    promotedSquares: { A: [], B: [] },
    captureMaterial: {} as BughousePositionSnapshot["captureMaterial"],
    ...over,
  };
}

describe("toEngineBoardFen", () => {
  it("appends an empty bracket when the reserve is empty", () => {
    expect(toEngineBoardFen(START, emptyReserves())).toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1",
    );
  });

  it("writes white's reserve uppercase and black's lowercase", () => {
    const out = toEngineBoardFen(START, {
      white: { p: 2 },
      black: { n: 2 },
    });
    expect(out).toContain("[PPnn]");
  });

  it("orders the pocket white-then-black, descending by piece value", () => {
    // Matches the engine's canonical ordering, verified by round tripping
    // "qrbnpQRBNP" through the built engine and getting back "QRBNPqrbnp".
    const out = toEngineBoardFen(START, {
      white: { p: 1, n: 1, b: 1, r: 1, q: 1 },
      black: { p: 1, n: 1, b: 1, r: 1, q: 1 },
    });
    expect(out).toContain("[QRBNPqrbnp]");
  });

  it("marks promoted squares with ~", () => {
    const fen = "4k3/8/8/8/8/8/8/4K2Q w - - 0 1";
    expect(toEngineBoardFen(fen, emptyReserves(), ["h1"])).toBe(
      "4k3/8/8/8/8/8/8/4K2Q~[] w - - 0 1",
    );
  });

  it("marks several promoted squares without corrupting later indices", () => {
    // a8 and h1 sit either side of digit runs, so a naive forward splice would
    // shift the second insertion point.
    const fen = "q3k3/8/8/8/8/8/8/4K2Q w - - 0 1";
    expect(toEngineBoardFen(fen, emptyReserves(), ["a8", "h1"])).toBe(
      "q~3k3/8/8/8/8/8/8/4K2Q~[] w - - 0 1",
    );
  });

  it("combines promoted markers and a pocket", () => {
    const fen = "4k3/8/8/8/8/8/8/4K2Q w - - 0 1";
    expect(
      toEngineBoardFen(fen, { white: { p: 1 }, black: { p: 1 } }, ["h1"]),
    ).toBe("4k3/8/8/8/8/8/8/4K2Q~[Pp] w - - 0 1");
  });

  it("rejects a promoted square that holds no piece", () => {
    expect(() =>
      toEngineBoardFen(START, emptyReserves(), ["e4"]),
    ).toThrow(BughouseFenError);
  });

  it("rejects a FEN that already carries engine markup", () => {
    expect(() =>
      toEngineBoardFen(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1",
        emptyReserves(),
      ),
    ).toThrow(BughouseFenError);
  });

  it("rejects a short FEN rather than emitting a partial one", () => {
    // The engine does not error on malformed input -- it silently builds a
    // nonsense position -- so validation has to happen here.
    expect(() =>
      toEngineBoardFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w", emptyReserves()),
    ).toThrow(BughouseFenError);
  });

  it("rejects a placement with a malformed rank", () => {
    expect(() =>
      toEngineBoardFen("rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", emptyReserves(), ["a8"]),
    ).toThrow(BughouseFenError);
  });
});

describe("toEngineFen", () => {
  it("joins both boards with a pipe", () => {
    const out = toEngineFen(snapshot());
    expect(out.split("|")).toHaveLength(2);
    expect(out).toBe(
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1|" +
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1",
    );
  });

  it("keeps each board's reserve on its own board", () => {
    const out = toEngineFen(
      snapshot({
        reserves: {
          A: { white: { q: 1 }, black: {} },
          B: { white: {}, black: { r: 1 } },
        },
      }),
    );
    const [a, b] = out.split("|");
    expect(a).toContain("[Q]");
    expect(b).toContain("[r]");
  });
});

describe("round trip", () => {
  const cases: Array<[string, BughousePositionSnapshot]> = [
    ["start position", snapshot()],
    [
      "non-empty reserves on both boards",
      snapshot({
        reserves: {
          A: { white: { p: 3, n: 1 }, black: { q: 1 } },
          B: { white: { r: 2 }, black: { b: 1, p: 2 } },
        },
      }),
    ],
    [
      "promoted pieces",
      snapshot({
        fenA: "q3k3/8/8/8/8/8/8/4K2Q w - - 0 1",
        promotedSquares: { A: ["a8", "h1"], B: [] },
      }),
    ],
    [
      "promoted pieces and reserves together",
      snapshot({
        fenA: "q3k3/8/8/8/8/8/8/4K2Q w - - 0 1",
        fenB: "4k3/8/8/8/8/8/8/4K3 b - - 7 42",
        reserves: {
          A: { white: { p: 1 }, black: { n: 2 } },
          B: { white: { q: 1, r: 1 }, black: {} },
        },
        promotedSquares: { A: ["a8", "h1"], B: [] },
      }),
    ],
  ];

  it.each(cases)("survives encode then decode: %s", (_label, snap) => {
    const parsed = fromEngineFen(toEngineFen(snap));

    expect(parsed.A.fen).toBe(snap.fenA);
    expect(parsed.B.fen).toBe(snap.fenB);
    expect(parsed.A.promotedSquares.sort()).toEqual(
      [...snap.promotedSquares.A].sort(),
    );
    expect(parsed.B.promotedSquares.sort()).toEqual(
      [...snap.promotedSquares.B].sort(),
    );

    // Reserves compare by non-zero counts; absent and zero mean the same thing.
    for (const board of ["A", "B"] as const) {
      for (const side of ["white", "black"] as const) {
        const expected = Object.fromEntries(
          Object.entries(snap.reserves[board][side]).filter(([, n]) => n > 0),
        );
        expect(parsed[board].reserves[side]).toEqual(expected);
      }
    }
  });
});

describe("fromEngineBoardFen", () => {
  it("accepts a FEN with no bracket at all", () => {
    // The engine's own startingFen has none, so this form is legal input.
    const parsed = fromEngineBoardFen(START);
    expect(parsed.fen).toBe(START);
    expect(parsed.reserves).toEqual({ white: {}, black: {} });
  });

  it("reports no promoted squares for engine-produced output", () => {
    // Documents a real limitation: the engine parses `~` and feeds it to the
    // network, but its fen() never prints it. Promoted state cannot be
    // recovered from a FEN the engine produced.
    const asEngineWouldPrint = "4k3/8/8/8/8/8/8/4K2Q[] w - - 0 1";
    expect(fromEngineBoardFen(asEngineWouldPrint).promotedSquares).toEqual([]);
  });

  it("rejects an unterminated pocket", () => {
    expect(() =>
      fromEngineBoardFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[Pp w KQkq - 0 1"),
    ).toThrow(BughouseFenError);
  });

  it("rejects a dual FEN with the wrong number of boards", () => {
    expect(() => fromEngineFen(START)).toThrow(BughouseFenError);
  });
});

describe("toEngineMove", () => {
  it("prefixes board A with 1 and board B with 2", () => {
    expect(toEngineMove("A", "e2e4")).toBe("1e2e4");
    expect(toEngineMove("B", "e7e5")).toBe("2e7e5");
  });

  it("prefixes drop moves the same way", () => {
    expect(toEngineMove("A", "P@e4")).toBe("1P@e4");
  });
});
