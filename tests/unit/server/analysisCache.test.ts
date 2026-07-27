import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeAnalysisCache,
  readCachedAnalysis,
  writeCachedAnalysis,
  type AnalysisCacheKey,
} from "@/app/server/analysisCache";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1";

function key(overrides: Partial<AnalysisCacheKey> = {}): AnalysisCacheKey {
  return {
    fen: `${START}|${START}`,
    analysisBoard: 1,
    team: "white",
    mode: "go",
    nodes: 20_000,
    multipv: 20,
    ...overrides,
  };
}

function output(move = "e2e4") {
  return {
    bestmove: `(${move},pass)`,
    lines: [{ multipv: 1, move, q: 0.12, visits: 9_377 }],
    nodes: 20_016,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "analysis-cache-"));
  process.env.ANALYSIS_CACHE_PATH = join(dir, "cache.sqlite");
  closeAnalysisCache();
});

afterEach(() => {
  closeAnalysisCache();
  delete process.env.ANALYSIS_CACHE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("analysisCache", () => {
  it("returns null for a position never searched", () => {
    expect(readCachedAnalysis(key())).toBeNull();
  });

  it("round-trips a stored analysis", () => {
    writeCachedAnalysis(key(), output());
    expect(readCachedAnalysis(key())).toEqual(output());
  });

  it("survives a reopen, which is the whole point of not being in React state", () => {
    writeCachedAnalysis(key(), output());
    closeAnalysisCache();

    expect(readCachedAnalysis(key())).toEqual(output());
  });

  describe("the search budget in the key", () => {
    it("serves a deeper stored result for a shallower request", () => {
      writeCachedAnalysis(key({ nodes: 200_000 }), output("d2d4"));

      expect(readCachedAnalysis(key({ nodes: 20_000 }))).toEqual(output("d2d4"));
    });

    it("does NOT serve a shallow scan to a deep request", () => {
      // The bug this schema exists to prevent: `useEngineAnalysis` keys without
      // the budget, and copying that here would answer a 200k pass-2 lookup
      // with a 20k triage scan -- silently, and as a final verdict.
      writeCachedAnalysis(key({ nodes: 20_000 }), output());

      expect(readCachedAnalysis(key({ nodes: 200_000 }))).toBeNull();
    });

    it("prefers the deepest entry when several qualify", () => {
      writeCachedAnalysis(key({ nodes: 20_000 }), output("e2e4"));
      writeCachedAnalysis(key({ nodes: 200_000 }), output("d2d4"));

      expect(readCachedAnalysis(key({ nodes: 20_000 }))).toEqual(output("d2d4"));
    });

    it("treats line count the same way", () => {
      // Lines not requested cannot be recovered from a finished search: MultiPV
      // is read before the search starts.
      writeCachedAnalysis(key({ multipv: 5 }), output());

      expect(readCachedAnalysis(key({ multipv: 20 }))).toBeNull();
      expect(readCachedAnalysis(key({ multipv: 5 }))).toEqual(output());
    });
  });

  describe("what counts as a different question", () => {
    it.each([
      ["the partner board", { fen: `${START}|4k3/8/8/8/8/8/8/4K3[] w - - 0 1` }],
      ["the analysed board", { analysisBoard: 2 }],
      ["the team", { team: "black" }],
      ["the mode", { mode: "sit" }],
    ])("misses when %s differs", (_label, overrides) => {
      writeCachedAnalysis(key(), output());

      expect(readCachedAnalysis(key(overrides))).toBeNull();
    });
  });

  describe("what is not stored", () => {
    it("ignores a handler-level error so a transient failure is not permanent", () => {
      writeCachedAnalysis(key(), { error: "engine unavailable: BrokenPipeError" });

      expect(readCachedAnalysis(key())).toBeNull();
    });

    it("ignores an output with no lines", () => {
      writeCachedAnalysis(key(), { bestmove: "(e2e4,pass)" });

      expect(readCachedAnalysis(key())).toBeNull();
    });
  });

  describe("when the cache cannot be used", () => {
    it("is inert when ANALYSIS_CACHE_PATH is unset", () => {
      delete process.env.ANALYSIS_CACHE_PATH;
      closeAnalysisCache();

      writeCachedAnalysis(key(), output());
      expect(readCachedAnalysis(key())).toBeNull();
    });

    it("degrades to a miss rather than throwing when the path is unusable", () => {
      // An optimisation must never be able to take analysis down; the likely
      // real cause is systemd's ProtectSystem=strict making the directory
      // read-only.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.ANALYSIS_CACHE_PATH = join(dir, "no", "such", "dir.sqlite");
      closeAnalysisCache();

      expect(() => writeCachedAnalysis(key(), output())).not.toThrow();
      expect(readCachedAnalysis(key())).toBeNull();
      expect(errors).toHaveBeenCalled();

      errors.mockRestore();
    });
  });
});
