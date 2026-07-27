import { describe, expect, it } from "vitest";

import { MIN_VISITS, THRESHOLD_SCAN } from "@/app/utils/review/detectMistake";
import {
  SCAN_NOISE_MARGIN,
  SEVERITY_THRESHOLDS,
  classifySeverity,
  scanThresholdFor,
} from "@/app/utils/review/severity";

describe("classifySeverity", () => {
  it.each([
    [0.1985, "blunder"], // ply 95 of the reviewed game
    [0.1694, "blunder"], // ply 99
    [0.1114, "mistake"], // ply 58
    [0.0852, "mistake"], // ply 71
    [0.0713, "inaccuracy"], // ply 74
    [0.0317, "inaccuracy"], // ply 19
  ])("grades a loss of %s as %s", (loss, expected) => {
    expect(classifySeverity(loss)).toBe(expected);
  });

  it("drops a loss below the reporting floor", () => {
    // Every move that is not the top choice loses something. Reporting all of
    // them would bury the ones that matter.
    expect(classifySeverity(0.0140)).toBeNull();
    expect(classifySeverity(0)).toBeNull();
  });

  it("puts a loss exactly on a floor in the higher band", () => {
    expect(classifySeverity(SEVERITY_THRESHOLDS.blunder)).toBe("blunder");
    expect(classifySeverity(SEVERITY_THRESHOLDS.mistake)).toBe("mistake");
    expect(classifySeverity(SEVERITY_THRESHOLDS.inaccuracy)).toBe("inaccuracy");
  });

  it("honours overridden bands", () => {
    const strict = { inaccuracy: 0.1, mistake: 0.2, blunder: 0.3 };

    expect(classifySeverity(0.0852, strict)).toBeNull();
    // The reviewed game's worst move drops two bands under these: 0.1985 sits
    // below the 0.2 mistake floor.
    expect(classifySeverity(0.1985, strict)).toBe("inaccuracy");
    expect(classifySeverity(0.31, strict)).toBe("blunder");
  });

  it("keeps the bands ordered and above the measured 20k noise floor", () => {
    // A band below run-to-run noise would grade the search's own randomness.
    expect(SEVERITY_THRESHOLDS.inaccuracy).toBeGreaterThan(SCAN_NOISE_MARGIN);
    expect(SEVERITY_THRESHOLDS.mistake).toBeGreaterThan(
      SEVERITY_THRESHOLDS.inaccuracy,
    );
    expect(SEVERITY_THRESHOLDS.blunder).toBeGreaterThan(
      SEVERITY_THRESHOLDS.mistake,
    );
  });
});

describe("scanThresholdFor", () => {
  it("sits one scan-noise margin below the lowest reported band", () => {
    // The scan estimates the same loss more cheaply, so it must cut *below*
    // where reporting starts or it filters out positions the deep pass would
    // have graded as inaccuracies.
    expect(scanThresholdFor(0.03)).toBeCloseTo(0.0176, 4);
  });

  it("never returns a negative threshold", () => {
    expect(scanThresholdFor(0.001)).toBe(0);
  });

  it("shows the current scan threshold is more permissive than it needs to be", () => {
    // Documents a live discrepancy rather than asserting the code is right:
    // THRESHOLD_SCAN was set from the noise floor alone, before bands existed,
    // so it promotes positions no band would ever report. Raising it to
    // scanThresholdFor() is what cuts the measured 69% promotion rate.
    expect(THRESHOLD_SCAN).toBeLessThan(scanThresholdFor());
  });

  it("keeps the visits gate independent of any of this", () => {
    // Severity grades how bad a move was; MIN_VISITS decides whether the number
    // is a search result at all. Conflating them would grade network priors.
    expect(MIN_VISITS).toBe(500);
  });
});
