import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { EngineLinesPanel } from "../../../app/components/engine/EngineLinesPanel";
import type {
  EngineAnalysis,
  EngineLine,
} from "../../../app/utils/engine/engineClient";

function line(over: Partial<EngineLine> = {}): EngineLine {
  return {
    multipv: 1,
    move: "d2d4",
    partnerMove: null,
    q: -0.0168,
    visits: 21841,
    prior: 0.3265,
    scoreCentipawns: -4,
    mateIn: null,
    depth: 12,
    pv: [{ a: "d2d4", b: null }, { a: "d7d5", b: "e2e4" }],
    ...over,
  };
}

function analysis(lines: EngineLine[]): EngineAnalysis {
  return {
    lines,
    bestMoveA: "d2d4",
    bestMoveB: null,
    analysisBoard: "A",
    depth: 12,
    nodes: 48512,
    timeMs: 2990,
  };
}

function renderPanel(over: Partial<Parameters<typeof EngineLinesPanel>[0]> = {}) {
  const props = {
    analysis: analysis([line()]),
    isAnalyzing: false,
    error: null,
    board: "A" as const,
    side: "white" as const,
    position: null,
    mode: "go" as const,
    nodes: 50_000,
    multipv: 3,
    onBoardChange: vi.fn(),
    onModeChange: vi.fn(),
    onNodesChange: vi.fn(),
    onMultipvChange: vi.fn(),
    onRefresh: vi.fn(),
    onPlayMove: vi.fn(),
    ...over,
  };
  return { props, ...render(<EngineLinesPanel {...props} />) };
}

describe("EngineLinesPanel", () => {
  it("renders moves as algebraic notation when a position is available", () => {
    // Display only — the underlying move stays UCI so it can still be played
    // into the variation tree.
    const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    renderPanel({
      analysis: analysis([line({ move: "g1f3", pv: [{ a: "g1f3", b: null }] })]),
      position: {
        fenA: START,
        fenB: START,
        reserves: { A: { white: {}, black: {} }, B: { white: {}, black: {} } },
        promotedSquares: { A: [], B: [] },
        captureMaterial: {} as never,
      },
    });
    expect(screen.getByTestId("engine-line-move")).toHaveTextContent("Nf3");
  });

  it("falls back to raw UCI when there is no position to convert against", () => {
    renderPanel({ position: null });
    expect(screen.getByTestId("engine-line-move")).toHaveTextContent("d2d4");
  });

  it("shows the candidate move and its evaluation", () => {
    renderPanel();
    // Scoped: the move also appears inside the PV preview below it.
    expect(screen.getByTestId("engine-line-move")).toHaveTextContent("d2d4");
    // q leads, because the centipawn figure comes from a transform that
    // saturates hard and is only good for ordering.
    expect(screen.getByText("-0.017")).toBeInTheDocument();
  });

  it("shows visits, so a low-confidence line is distinguishable", () => {
    renderPanel();
    expect(screen.getByText(/21\.8k visits/)).toBeInTheDocument();
  });

  it("renders sit as a labelled action rather than a move", () => {
    // Sit is a real bughouse action with no from/to squares. Hiding it or
    // rendering it as a move would both be wrong.
    renderPanel({ analysis: analysis([line({ move: null })]) });
    expect(screen.getByTestId("engine-line-move")).toHaveTextContent("sit");
  });

  it("does not let a sit line be played into the variation tree", () => {
    renderPanel({ analysis: analysis([line({ move: null })]) });
    expect(screen.getByTestId("engine-line-row")).toBeDisabled();
  });

  it("plays a candidate when its row is clicked", () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByTestId("engine-line-row"));
    expect(props.onPlayMove).toHaveBeenCalledWith(
      expect.objectContaining({ move: "d2d4" }),
    );
  });

  it("shows a mate score instead of a q value", () => {
    renderPanel({
      analysis: analysis([line({ mateIn: 3, scoreCentipawns: null })]),
    });
    expect(screen.getByText("#3")).toBeInTheDocument();
  });

  it("switches the analysed board", () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(props.onBoardChange).toHaveBeenCalledWith("B");
  });

  it("offers go, sit, and auto, with auto pressed while following the clock", () => {
    // Mode follows the clock by default (auto). aria-pressed marks the *pin*, so
    // in auto neither go nor sit is pressed -- the derived value is named by the
    // auto button itself, leaving auto as the only pressed control.
    renderPanel({ mode: "go", isModeAuto: true });
    expect(screen.getByRole("button", { name: "auto(go)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "go" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "sit" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("marks the pinned mode as pressed once the clock is overridden", () => {
    renderPanel({ mode: "sit", isModeAuto: false });
    expect(screen.getByRole("button", { name: "sit" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "auto" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("names the clock-derived mode in the auto label", () => {
    // The label is the only place the derived value shows, so it has to track it.
    const { rerender, props } = renderPanel({ mode: "go", isModeAuto: true });
    expect(screen.getByRole("button", { name: "auto(go)" })).toBeInTheDocument();
    rerender(<EngineLinesPanel {...props} mode="sit" />);
    expect(screen.getByRole("button", { name: "auto(sit)" })).toBeInTheDocument();
  });

  it("reports a mode pin", () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "sit" }));
    expect(props.onModeChange).toHaveBeenCalledWith("sit");
  });

  it("reports a return to auto", () => {
    const { props } = renderPanel({ mode: "sit", isModeAuto: false });
    fireEvent.click(screen.getByRole("button", { name: "auto" }));
    expect(props.onModeAuto).toHaveBeenCalled();
  });

  it("surfaces an error instead of lines", () => {
    renderPanel({ analysis: null, error: "could not reach the engine" });
    expect(screen.getByText("could not reach the engine")).toBeInTheDocument();
  });

  it("explains when fewer lines came back than requested", () => {
    renderPanel({
      analysis: { ...analysis([line()]), note: "requested 5 lines, produced 1" },
    });
    expect(screen.getByText(/requested 5 lines/)).toBeInTheDocument();
  });

  it("shows an empty state while the first search runs", () => {
    renderPanel({ analysis: null, isAnalyzing: true });
    expect(screen.getByText("Analysing…")).toBeInTheDocument();
  });

  describe("cost controls", () => {
    it("always offers a one-shot analyse button when there is nothing to show", () => {
      // Analysis is explicit: the engine is never asked until the user asks.
      const { props } = renderPanel({ analysis: null });
      expect(screen.getByText("No analysis yet.")).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: /analyse this position/i }),
      );
      expect(props.onRefresh).toHaveBeenCalled();
    });

    it("marks the active line count and reports changes", () => {
      const { props } = renderPanel({ multipv: 3 });
      expect(screen.getByRole("button", { name: "3" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      fireEvent.click(screen.getByRole("button", { name: "5" }));
      expect(props.onMultipvChange).toHaveBeenCalledWith(5);
    });

    it("marks the active node budget and reports changes", () => {
      const { props } = renderPanel({ nodes: 50_000 });
      expect(screen.getByRole("button", { name: "50k" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      fireEvent.click(screen.getByRole("button", { name: "200k" }));
      expect(props.onNodesChange).toHaveBeenCalledWith(200_000);
    });

    it("surfaces the billed cost of each budget", () => {
      // The cost worth showing is billed seconds, not search seconds: ~20s of
      // fixed overhead lands on every request whatever budget it asks for.
      // Showing search time alone made the small budgets look far cheaper than
      // they bill, so every option has to carry its billed figure.
      renderPanel();
      for (const label of ["50k", "200k", "500k"]) {
        expect(screen.getByRole("button", { name: label })).toHaveAttribute(
          "title",
          expect.stringContaining("billed"),
        );
      }
      // Concrete figure, not just the word "billed": it goes stale whenever the
      // endpoint's GPU changes, and a stale cost label is worse than none.
      expect(screen.getByRole("button", { name: "200k" })).toHaveAttribute(
        "title",
        expect.stringContaining("~45s billed"),
      );
    });

    it("offers no budget below the 50k floor", () => {
      // 5k billed ~21s against 200k's ~48s -- 44% of the cost for 2.5% of the
      // analysis. Sub-50k tiers are not a cheap option, only a wasteful one,
      // and this is a deliberate removal rather than an oversight.
      renderPanel();
      expect(screen.queryByRole("button", { name: "5k" })).toBeNull();
      expect(screen.queryByRole("button", { name: "20k" })).toBeNull();
    });

    it("blocks a second search while one is running", () => {
      renderPanel({ isAnalyzing: true });
      expect(screen.getByRole("button", { name: "Run analysis" })).toBeDisabled();
    });
  });

  describe("starting a search", () => {
    it("offers exactly one control when there is nothing to re-run", () => {
      // The header icon and the empty state's labelled button both call
      // onRefresh, so showing both would be two controls for one action.
      renderPanel({ analysis: null });
      expect(screen.queryByRole("button", { name: "Run analysis" })).toBeNull();
      expect(
        screen.getByRole("button", { name: /Analyse this position/ }),
      ).toBeInTheDocument();
    });

    it("swaps to the icon once a result exists", () => {
      renderPanel();
      expect(
        screen.getByRole("button", { name: "Run analysis" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Analyse this position/ })).toBeNull();
    });

    it("keeps the icon for retrying after an error", () => {
      // The error state replaces the empty state, so without this the panel
      // would offer no way to try again.
      renderPanel({ analysis: null, error: "engine unreachable" });
      expect(
        screen.getByRole("button", { name: "Run analysis" }),
      ).toBeInTheDocument();
    });
  });

  describe("All plies toggle", () => {
    // Eight plies, so the 7th move only appears once the full line is shown.
    // Position is null in these tests, so pvToSan renders moves as raw UCI --
    // "h2h4" is a stable marker for "the preview was extended".
    const longPv = [
      { a: "d2d4", b: null },
      { a: "d7d5", b: null },
      { a: "g1f3", b: null },
      { a: "g8f6", b: null },
      { a: "c2c4", b: null },
      { a: "e7e6", b: null },
      { a: "h2h4", b: null }, // 7th ply -- beyond the 6-ply preview
      { a: "a7a6", b: null },
    ];

    beforeEach(() => {
      localStorage.clear();
    });

    it("defaults off: truncates each line and leaves the box unchecked", () => {
      renderPanel({ analysis: analysis([line({ pv: longPv })]) });
      expect(screen.getByRole("checkbox", { name: /All plies/ })).not.toBeChecked();
      expect(screen.queryByText("h2h4")).toBeNull();
    });

    it("checking it reveals the full line and persists the choice", () => {
      renderPanel({ analysis: analysis([line({ pv: longPv })]) });
      fireEvent.click(screen.getByRole("checkbox", { name: /All plies/ }));
      expect(screen.getByRole("checkbox", { name: /All plies/ })).toBeChecked();
      expect(screen.getByText("h2h4")).toBeInTheDocument();
      expect(localStorage.getItem("bh-engine-show-all-plies")).toBe("true");
    });

    it("reads the persisted preference on mount", () => {
      localStorage.setItem("bh-engine-show-all-plies", "true");
      renderPanel({ analysis: analysis([line({ pv: longPv })]) });
      expect(screen.getByRole("checkbox", { name: /All plies/ })).toBeChecked();
      expect(screen.getByText("h2h4")).toBeInTheDocument();
    });
  });
});
