import type { ReviewReport } from "@/app/utils/review/reviewGame";

/**
 * Browser-local store for finished review reports.
 *
 * The server-side `analysisCache` already makes a repeat review *cheap* -- every
 * underlying search is a cache hit -- but not *free* and not *instant*:
 * `reviewGame` still issues one request per position back to back, so reopening
 * a game re-pays tens of sequential round-trips and, before any of that, a click.
 * This keeps the assembled report on the client so a review already run in this
 * browser comes back with neither.
 *
 * **Why the report and not the raw lines.** The review pipeline discards its
 * scan lines by design (it keeps only the verdict); the report is the thing the
 * hook actually holds. So this persists the report and hydrates it directly,
 * rather than re-deriving grading from lines that were never kept.
 *
 * **Why a version tag.** A report bakes in provisional grading -- the severity
 * bands and REVIEW_MULTIPV are explicitly not yet calibrated. Persisting the
 * derived verdicts means a stored report can disagree with current logic the
 * moment any of that changes. `CACHE_VERSION` is the whole invalidation story:
 * bump it and every stale entry fails the read and is swept on the next save.
 * There is no migration because there are no users to coordinate -- this is one
 * browser's convenience, not a shared source of truth. Cross-device or
 * shareable reports are a server concern and a separate decision.
 *
 * **Why localStorage.** It is the storage the app already standardises on (see
 * `userPreferencesService`); IndexedDB exists nowhere in the codebase and a
 * single game's report is ~100-200 KB, so an LRU cap keeps the whole thing well
 * inside the 5 MB budget. Reach for IndexedDB only if bulk-reviewing whole
 * archives ever makes that ceiling bite.
 */

const KEY_PREFIX = "relay:reviewReport:";

/**
 * Bump when the *meaning* of a stored report changes and old ones must not be
 * shown: the severity thresholds, the mistake detector, REVIEW_MULTIPV, the scan
 * or deep node budgets, or this file's serialized shape.
 */
export const CACHE_VERSION = 1;

/**
 * How many game/scope reports to keep. Each is ~100-200 KB, so this bounds the
 * store to ~1-2 MB -- room to spare under localStorage's ~5 MB, and enough that
 * moving between the players of a game and back never evicts a live one.
 */
export const MAX_ENTRIES = 8;

/**
 * `ReviewReport` is plain data except `playedRankHistogram`, a `Map` that
 * `JSON.stringify` would silently flatten to `{}`. Store it as entries.
 */
interface StoredReport {
  version: number;
  /** Epoch ms of the write, for least-recently-*written* eviction. */
  savedAt: number;
  report: Omit<ReviewReport, "playedRankHistogram"> & {
    playedRankHistogram: [number | null, number][];
  };
}

function keyFor(gameId: string, scopeId: string): string {
  return `${KEY_PREFIX}${gameId}:${scopeId}`;
}

/**
 * The store, or null when it cannot be used -- SSR (no `window`), privacy mode,
 * or a browser that denies access. Every caller degrades to "no cache" on null,
 * so a review still runs; it just is not remembered.
 */
function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Reads a stored report for this game and scope, or null on miss/stale/error. */
export function loadReviewReport(
  gameId: string,
  scopeId: string,
): ReviewReport | null {
  const store = storage();
  if (!store) return null;
  const key = keyFor(gameId, scopeId);
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredReport;
    if (parsed.version !== CACHE_VERSION) {
      // A stale entry is worse than no entry -- it would show verdicts current
      // grading no longer stands behind. Drop it and report a miss.
      store.removeItem(key);
      return null;
    }
    return {
      ...parsed.report,
      playedRankHistogram: new Map(parsed.report.playedRankHistogram),
    };
  } catch {
    // Corrupt JSON or a shape from an older build: treat as a miss and clear it.
    try {
      store.removeItem(key);
    } catch {
      /* nothing more to do */
    }
    return null;
  }
}

/**
 * Persists a report for this game and scope, then enforces the LRU cap. A
 * failure here is silent by design: the review already succeeded, and not being
 * able to remember it must never surface as an error over a working result.
 */
export function saveReviewReport(
  gameId: string,
  scopeId: string,
  report: ReviewReport,
): void {
  const store = storage();
  if (!store) return;
  const payload: StoredReport = {
    version: CACHE_VERSION,
    savedAt: Date.now(),
    report: {
      ...report,
      playedRankHistogram: Array.from(report.playedRankHistogram.entries()),
    },
  };
  try {
    store.setItem(keyFor(gameId, scopeId), JSON.stringify(payload));
  } catch {
    // Most likely a quota rejection. Free space and try once more before giving
    // up -- a single oversized store should not lose a fresh report to an old one.
    evictToCap(store, MAX_ENTRIES - 1);
    try {
      store.setItem(keyFor(gameId, scopeId), JSON.stringify(payload));
    } catch {
      return;
    }
  }
  evictToCap(store, MAX_ENTRIES);
}

/**
 * Drops the oldest entries until at most `keep` remain, and sweeps any left by a
 * previous `CACHE_VERSION`. Oldest by write time, read from each entry rather
 * than a separate index so there is no second thing to keep in sync.
 */
function evictToCap(store: Storage, keep: number): void {
  try {
    // Collect keys before removing anything: removeItem renumbers the store, so
    // deleting mid-`store.key(i)` walk would skip entries.
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(KEY_PREFIX)) keys.push(key);
    }
    const entries: { key: string; savedAt: number }[] = [];
    for (const key of keys) {
      try {
        const parsed = JSON.parse(store.getItem(key) ?? "") as StoredReport;
        if (parsed.version !== CACHE_VERSION) {
          store.removeItem(key);
          continue;
        }
        entries.push({ key, savedAt: parsed.savedAt ?? 0 });
      } catch {
        store.removeItem(key);
      }
    }
    if (entries.length <= keep) return;
    entries.sort((a, b) => a.savedAt - b.savedAt);
    for (const { key } of entries.slice(0, entries.length - keep)) {
      store.removeItem(key);
    }
  } catch {
    /* eviction is best-effort; a full store is not worth throwing over */
  }
}
