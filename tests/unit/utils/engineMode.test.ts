import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEADBAND_DECISECONDS,
  deriveEngineMode,
  engineTeamColour,
  teamFor,
} from "@/app/utils/engine/engineMode";
import type { BughouseClocksSnapshotByBoard } from "@/app/types/bughouse";

/** Clocks in deciseconds; only the relative totals matter. */
function clocks(
  aWhite: number,
  aBlack: number,
  bWhite: number,
  bBlack: number,
): BughouseClocksSnapshotByBoard {
  return {
    A: { white: aWhite, black: aBlack },
    B: { white: bWhite, black: bBlack },
  } as BughouseClocksSnapshotByBoard;
}

describe("teamFor", () => {
  it("pairs teams diagonally across the boards", () => {
    // A-White partners B-Black; the naive "white is team 1" is wrong on board B.
    expect(teamFor("A", "white")).toBe("AWhite_BBlack");
    expect(teamFor("B", "black")).toBe("AWhite_BBlack");
    expect(teamFor("A", "black")).toBe("ABlack_BWhite");
    expect(teamFor("B", "white")).toBe("ABlack_BWhite");
  });
});

describe("engineTeamColour", () => {
  it("passes board A colours through", () => {
    expect(engineTeamColour("A", "white")).toBe("white");
    expect(engineTeamColour("A", "black")).toBe("black");
  });

  it("inverts board B colours", () => {
    // The engine plays teamSide on board A and its opposite on board B, so a
    // user sitting at board B as white is team black in the engine's terms.
    expect(engineTeamColour("B", "white")).toBe("black");
    expect(engineTeamColour("B", "black")).toBe("white");
  });
});

describe("deriveEngineMode", () => {
  const base = { board: "A", side: "white", setting: "auto" } as const;

  it("says sit when the user's team is clearly ahead", () => {
    // Team1 (A-White + B-Black) leads by 10s.
    const got = deriveEngineMode({ ...base, clocks: clocks(1000, 900, 900, 1000) });
    expect(got.mode).toBe("sit");
    expect(got.autoMode).toBe("sit");
    expect(got.isOverridden).toBe(false);
  });

  it("says go when the user's team is behind", () => {
    expect(
      deriveEngineMode({ ...base, clocks: clocks(900, 1000, 1000, 900) }).mode,
    ).toBe("go");
  });

  it("reads the same clocks oppositely for the other team", () => {
    // Identical clocks, opposite seat: exactly one side may sit.
    const c = clocks(1000, 900, 900, 1000);
    expect(deriveEngineMode({ ...base, clocks: c }).mode).toBe("sit");
    expect(
      deriveEngineMode({ ...base, side: "black", clocks: c }).mode,
    ).toBe("go");
  });

  it("treats board B black as the same team as board A white", () => {
    const c = clocks(1000, 900, 900, 1000);
    expect(deriveEngineMode({ ...base, board: "B", side: "black", clocks: c }).mode)
      .toBe("sit");
    expect(deriveEngineMode({ ...base, board: "B", side: "white", clocks: c }).mode)
      .toBe("go");
  });

  describe("deadband", () => {
    it("falls back to go for a lead inside the deadband", () => {
      // A 1s lead is noise; flipping mode on it would invalidate the tree every
      // ply while stepping through a game.
      const lead = DEFAULT_DEADBAND_DECISECONDS - 5;
      const got = deriveEngineMode({
        ...base,
        clocks: clocks(1000 + lead, 1000, 1000, 1000),
      });
      expect(got.mode).toBe("go");
    });

    it("says sit once the lead clears the deadband", () => {
      const lead = DEFAULT_DEADBAND_DECISECONDS + 5;
      expect(
        deriveEngineMode({
          ...base,
          clocks: clocks(1000 + lead, 1000, 1000, 1000),
        }).mode,
      ).toBe("sit");
    });

    it("treats exactly level clocks as go", () => {
      expect(
        deriveEngineMode({ ...base, clocks: clocks(1000, 1000, 1000, 1000) }).mode,
      ).toBe("go");
    });

    it("honours a custom deadband", () => {
      const c = clocks(1050, 1000, 1000, 1000); // 5s lead
      expect(deriveEngineMode({ ...base, clocks: c, deadbandDeciseconds: 100 }).mode)
        .toBe("go");
      expect(deriveEngineMode({ ...base, clocks: c, deadbandDeciseconds: 10 }).mode)
        .toBe("sit");
    });
  });

  describe("manual override", () => {
    it("wins over auto and still reports what auto would have said", () => {
      const got = deriveEngineMode({
        ...base,
        setting: "sit",
        clocks: clocks(900, 1000, 1000, 900), // auto would say go
      });
      expect(got.mode).toBe("sit");
      expect(got.autoMode).toBe("go");
      expect(got.isOverridden).toBe(true);
    });

    it("can force go against a winning clock", () => {
      const got = deriveEngineMode({
        ...base,
        setting: "go",
        clocks: clocks(2000, 1000, 1000, 2000),
      });
      expect(got.mode).toBe("go");
      expect(got.autoMode).toBe("sit");
    });
  });

  describe("without clocks", () => {
    it("falls back to go and flags auto as unavailable", () => {
      // A position entered by hand has no clocks; auto has nothing to track.
      const got = deriveEngineMode({ ...base, clocks: null });
      expect(got.mode).toBe("go");
      expect(got.autoUnavailable).toBe(true);
      expect(got.diffDeciseconds).toBeNull();
    });

    it("still honours an override", () => {
      const got = deriveEngineMode({ ...base, clocks: null, setting: "sit" });
      expect(got.mode).toBe("sit");
      expect(got.autoUnavailable).toBe(true);
    });
  });
});
