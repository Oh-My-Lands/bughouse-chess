import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { EngineLinesPanel } from "../../../app/components/engine/EngineLinesPanel";
import type {
  EngineAnalysis,
  EngineLine,
} from "../../../app/utils/engine/engineClient";
import type { ModeDerivationResult } from "../../../app/utils/engine/engineMode";

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

const modeInfo: ModeDerivationResult = {
  mode: "go",
  autoMode: "go",
  isOverridden: false,
  autoUnavailable: false,
  diffDeciseconds: 0,
};

function renderPanel(over: Partial<Parameters<typeof EngineLinesPanel>[0]> = {}) {
  const props = {
    analysis: analysis([line()]),
    isAnalyzing: false,
    error: null,
    modeInfo,
    board: "A" as const,
    modeSetting: "auto" as const,
    onBoardChange: vi.fn(),
    onModeSettingChange: vi.fn(),
    onRefresh: vi.fn(),
    onPlayMove: vi.fn(),
    ...over,
  };
  return { props, ...render(<EngineLinesPanel {...props} />) };
}

describe("EngineLinesPanel", () => {
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

  it("shows what auto currently resolves to", () => {
    // Mode changes the evaluation, so the user must be able to tell which rule
    // set produced the numbers.
    renderPanel({ modeInfo: { ...modeInfo, autoMode: "sit" } });
    expect(screen.getByText("auto (sit)")).toBeInTheDocument();
  });

  it("says when auto has no clocks to work from", () => {
    renderPanel({
      modeInfo: { ...modeInfo, autoUnavailable: true, diffDeciseconds: null },
    });
    expect(screen.getByText("auto (no clocks)")).toBeInTheDocument();
  });

  it("lets the mode be overridden", () => {
    const { props } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "sit" }));
    expect(props.onModeSettingChange).toHaveBeenCalledWith("sit");
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
});
