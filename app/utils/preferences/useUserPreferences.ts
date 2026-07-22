"use client";

import { useEffect } from "react";
import {
  loadBoardAnnotationColor,
  DEFAULT_BOARD_ANNOTATION_COLOR,
  loadAutoAdvanceLiveReplayPreference,
  loadPieceValuePresetPreference,
} from "@/app/utils/preferences/userPreferencesService";

/**
 * Hook that loads user preferences on app initialization and updates the CSS variable.
 * This should be called once at the app root level.
 *
 * Preferences are stored in localStorage only.
 */
export function useUserPreferences() {
  useEffect(() => {
    /**
     * Loads the board annotation color and updates the CSS variable.
     */
    async function loadPreferences() {
      try {
        const [color] = await Promise.all([
          loadBoardAnnotationColor(),
          loadAutoAdvanceLiveReplayPreference(),
          loadPieceValuePresetPreference(),
        ]);
        const root = document.documentElement;
        root.style.setProperty("--bh-board-annotation-color", color);
      } catch (err) {
        console.error("[useUserPreferences] Failed to load preferences:", err);
        // Fall back to default on error
        const root = document.documentElement;
        root.style.setProperty("--bh-board-annotation-color", DEFAULT_BOARD_ANNOTATION_COLOR);
      }
    }

    void loadPreferences();
  }, []);
}
