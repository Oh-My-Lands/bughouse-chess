import { describe, expect, it } from "vitest";

import type { BughousePlayer } from "@/app/types/bughouse";
import {
  reviewScopeChoices,
  reviewScopeId,
} from "@/app/utils/review/reviewScope";

const player = (username: string): BughousePlayer => ({ username, rating: 1500 });

describe("reviewScopeChoices", () => {
  const players = {
    aWhite: player("alice"),
    aBlack: player("bob"),
    bWhite: player("carol"),
    bBlack: player("dave"),
  };

  it("maps the four slots to their board and side", () => {
    expect(reviewScopeChoices(players)).toEqual([
      { board: "A", side: "white", username: "alice" },
      { board: "A", side: "black", username: "bob" },
      { board: "B", side: "white", username: "carol" },
      { board: "B", side: "black", username: "dave" },
    ]);
  });

  it("gives each scope a distinct id", () => {
    const ids = reviewScopeChoices(players).map(reviewScopeId);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("reviewScopeId", () => {
  it("is stable regardless of the extra fields on a choice", () => {
    expect(reviewScopeId({ board: "A", side: "white" })).toBe(
      reviewScopeId({ board: "A", side: "white", username: "x" } as never),
    );
  });

  it("distinguishes board from side", () => {
    expect(reviewScopeId({ board: "A", side: "black" })).not.toBe(
      reviewScopeId({ board: "B", side: "white" }),
    );
  });
});
