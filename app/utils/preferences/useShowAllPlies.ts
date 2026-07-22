"use client";

import { useSyncExternalStore } from "react";
import {
  getShowAllPliesSnapshot,
  subscribeToShowAllPliesChanges,
} from "@/app/utils/preferences/userPreferencesService";

/**
 * Reactive view of the "show all plies" engine-panel preference.
 *
 * Stored in localStorage; the service emits a same-tab event on change and
 * listens for cross-tab storage events, so toggling it updates the panel
 * without a reload. Server snapshot is `false` so SSR and first client render
 * agree (the truncated preview).
 */
export function useShowAllPlies(): boolean {
  return useSyncExternalStore(
    subscribeToShowAllPliesChanges,
    getShowAllPliesSnapshot,
    () => false,
  );
}
