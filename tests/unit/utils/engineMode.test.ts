import { describe, expect, it } from "vitest";

import type { BughouseClocksSnapshotByBoard } from "@/app/types/bughouse";
import {
  MODE_SIT_THRESHOLD_DCS,
  deriveEngineMode,
  engineTeamColour,
  teamFor,
} from "@/app/utils/engine/engineMode";

/**
 * Clocks (deciseconds) where team AWhite_BBlack is `up` deciseconds ahead of
 * team ABlack_BWhite, split evenly so no single board carries the whole lead --
 * uptime is the *diagonal* sum, not one board's difference.
 */
function clocksWithTeamOneLead(up: number): BughouseClocksSnapshotByBoard {
  return {
    A: { white: 600 + up, black: 600 },
    B: { white: 600, black: 600 },
  };
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
  it("sits once the analysed team is at least the threshold ahead", () => {
    const snapshot = clocksWithTeamOneLead(MODE_SIT_THRESHOLD_DCS);
    // AWhite_BBlack is exactly at threshold -> sit. Read from either of its
    // diagonal seats.
    expect(deriveEngineMode(snapshot, "A", "white")).toBe("sit");
    expect(deriveEngineMode(snapshot, "B", "black")).toBe("sit");
  });

  it("goes for the team that is down on the clock, from the same snapshot", () => {
    const snapshot = clocksWithTeamOneLead(MODE_SIT_THRESHOLD_DCS);
    // The other team (ABlack_BWhite) is behind by the same amount -> go. This is
    // the diagonal sign flip via teamFor, not a board-local comparison.
    expect(deriveEngineMode(snapshot, "A", "black")).toBe("go");
    expect(deriveEngineMode(snapshot, "B", "white")).toBe("go");
  });

  it("goes just under the threshold (a floor, not a rounded band)", () => {
    const snapshot = clocksWithTeamOneLead(MODE_SIT_THRESHOLD_DCS - 1);
    expect(deriveEngineMode(snapshot, "A", "white")).toBe("go");
  });

  it("goes when the clocks are even", () => {
    const snapshot = clocksWithTeamOneLead(0);
    expect(deriveEngineMode(snapshot, "A", "white")).toBe("go");
    expect(deriveEngineMode(snapshot, "A", "black")).toBe("go");
  });

  it("reads uptime from the diagonal sum, not a single board", () => {
    // AWhite_BBlack is up 20 on board A but down 20 on board B: net even -> both
    // teams go. A board-local rule would wrongly sit board A's white.
    const snapshot: BughouseClocksSnapshotByBoard = {
      A: { white: 620, black: 600 },
      B: { white: 620, black: 600 },
    };
    expect(deriveEngineMode(snapshot, "A", "white")).toBe("go");
    expect(deriveEngineMode(snapshot, "B", "white")).toBe("go");
  });
});
