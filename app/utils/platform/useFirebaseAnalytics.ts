"use client";

/**
 * Analytics shim.
 *
 * Firebase Analytics was removed with the rest of Firebase. The call sites are
 * kept intact and point here so instrumentation can be re-added later against a
 * different backend without touching every component. Until then the hook hands
 * back `null` and logging is a no-op.
 */

/** Opaque handle. Always `null` now; a real analytics client would replace it. */
export type AnalyticsHandle = null;

/** Returns `null`: no analytics client is configured. */
export function useFirebaseAnalytics(): AnalyticsHandle {
  return null;
}

/**
 * No-op. Kept so the ~two dozen existing call sites continue to type-check.
 * Always returns `false` (nothing was logged).
 */
export function logAnalyticsEvent(
  _analytics: AnalyticsHandle,
  _eventName: string,
  _eventParams?: Record<string, string | number | boolean>,
): boolean {
  return false;
}
