import { describe, expect, it } from "vitest";

import { engineTeamColour, teamFor } from "@/app/utils/engine/engineMode";

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
