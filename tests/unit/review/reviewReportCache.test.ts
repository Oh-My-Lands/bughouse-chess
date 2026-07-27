import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReviewReport } from "@/app/utils/review/reviewGame";
import {
  MAX_ENTRIES,
  loadReviewReport,
  saveReviewReport,
} from "@/app/utils/review/reviewReportCache";

/**
 * A report is plain data apart from `playedRankHistogram`, so a minimal one with
 * a populated histogram is enough to exercise the parts persistence cares about:
 * the JSON round-trip and the Map that `JSON.stringify` would otherwise drop.
 */
function makeReport(scanCount: number): ReviewReport {
  return {
    positions: [],
    promoted: 0,
    searches: { scan: scanCount, deep: 0 },
    playedRankHistogram: new Map<number | null, number>([
      [1, 5],
      [3, 2],
      [null, 1],
    ]),
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("reviewReportCache", () => {
  it("round-trips a report, histogram Map included", () => {
    saveReviewReport("game-1", "Awhite", makeReport(7));

    const loaded = loadReviewReport("game-1", "Awhite");
    expect(loaded).not.toBeNull();
    expect(loaded?.searches.scan).toBe(7);
    // The Map survives -- the reason it is stored as entries rather than left to
    // JSON, which would have flattened it to `{}`.
    expect(loaded?.playedRankHistogram).toBeInstanceOf(Map);
    expect(loaded?.playedRankHistogram.get(1)).toBe(5);
    expect(loaded?.playedRankHistogram.get(null)).toBe(1);
  });

  it("returns null for a game or scope never stored", () => {
    saveReviewReport("game-1", "Awhite", makeReport(7));
    expect(loadReviewReport("game-1", "Ablack")).toBeNull();
    expect(loadReviewReport("game-2", "Awhite")).toBeNull();
  });

  it("keys reports separately by scope", () => {
    saveReviewReport("game-1", "Awhite", makeReport(4));
    saveReviewReport("game-1", "Ablack", makeReport(9));
    expect(loadReviewReport("game-1", "Awhite")?.searches.scan).toBe(4);
    expect(loadReviewReport("game-1", "Ablack")?.searches.scan).toBe(9);
  });

  it("rejects and clears an entry written by another cache version", () => {
    saveReviewReport("game-1", "Awhite", makeReport(7));

    // Bump the stored version in place, without depending on the key format.
    const [key, rawValue] = onlyStoredEntry();
    const bumped = JSON.parse(rawValue);
    bumped.version += 1;
    localStorage.setItem(key, JSON.stringify(bumped));

    expect(loadReviewReport("game-1", "Awhite")).toBeNull();
    // A stale read also evicts, so the bad row does not linger.
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("treats a corrupt entry as a miss and clears it", () => {
    saveReviewReport("game-1", "Awhite", makeReport(7));
    const [key] = onlyStoredEntry();
    localStorage.setItem(key, "{not valid json");

    expect(loadReviewReport("game-1", "Awhite")).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("evicts the oldest once past the cap, keeping the newest", () => {
    // Deterministic write times so "oldest" is well-defined; real writes can land
    // in the same millisecond, but eviction order only has to be right when they
    // do not.
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1_000));

    const total = MAX_ENTRIES + 3;
    for (let i = 0; i < total; i += 1) {
      saveReviewReport("game-1", `scope-${i}`, makeReport(i));
    }

    // The cap holds.
    expect(storedKeyCount()).toBe(MAX_ENTRIES);
    // The three oldest are gone.
    expect(loadReviewReport("game-1", "scope-0")).toBeNull();
    expect(loadReviewReport("game-1", "scope-2")).toBeNull();
    // The newest survive.
    expect(loadReviewReport("game-1", `scope-${total - 1}`)).not.toBeNull();
    expect(loadReviewReport("game-1", "scope-3")).not.toBeNull();
  });
});

/** The single cache row, as [key, rawValue]. Fails loudly if there is not exactly one. */
function onlyStoredEntry(): [string, string] {
  const keys = storedKeys();
  expect(keys).toHaveLength(1);
  const key = keys[0];
  return [key, localStorage.getItem(key) as string];
}

function storedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith("relay:reviewReport:")) keys.push(key);
  }
  return keys;
}

function storedKeyCount(): number {
  return storedKeys().length;
}
