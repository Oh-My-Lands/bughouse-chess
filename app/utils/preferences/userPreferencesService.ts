"use client";

import {
  DEFAULT_PIECE_VALUE_PRESET,
  isPieceValuePreset,
  type PieceValuePreset,
} from "@/app/utils/analysis/captureMaterial";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Default board annotation color (light green).
 * Matches the default value in globals.css.
 */
export const DEFAULT_BOARD_ANNOTATION_COLOR = "rgb(52, 168, 83, 0.95)";

/**
 * LocalStorage key for board annotation color preference.
 */
const LOCAL_STORAGE_KEY = "bh-board-annotation-color";

/**
 * LocalStorage key for auto-advance live replay preference.
 */
const AUTO_ADVANCE_LIVE_REPLAY_KEY = "bh-auto-advance-live-replay";

/**
 * LocalStorage key for the capture-material piece value preset.
 */
const PIECE_VALUE_PRESET_KEY = "bh-piece-value-preset";

/**
 * Same-tab notification used by the game viewer to react to saved preference changes.
 */
const PIECE_VALUE_PRESET_CHANGE_EVENT = "bh-piece-value-preset-change";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface UserPreferences {
  boardAnnotationColor: string;
  autoAdvanceLiveReplay: boolean;
  pieceValuePreset: PieceValuePreset;
}

/* -------------------------------------------------------------------------- */
/* LocalStorage Operations                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Gets the board annotation color from localStorage.
 * Returns the default color if not found or if localStorage is unavailable.
 */
export function getBoardAnnotationColorFromLocalStorage(): string {
  if (typeof window === "undefined") {
    return DEFAULT_BOARD_ANNOTATION_COLOR;
  }

  try {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored) {
      return stored;
    }
  } catch (err) {
    console.warn("[userPreferencesService] Failed to read from localStorage:", err);
  }

  return DEFAULT_BOARD_ANNOTATION_COLOR;
}

/**
 * Saves the board annotation color to localStorage.
 * This is called in real-time as the user selects a color.
 */
export function saveBoardAnnotationColorToLocalStorage(color: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, color);
  } catch (err) {
    console.warn("[userPreferencesService] Failed to write to localStorage:", err);
  }
}

/**
 * Removes the board annotation color from localStorage.
 * Used when reverting to default or canceling changes.
 */
export function removeBoardAnnotationColorFromLocalStorage(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch (err) {
    console.warn("[userPreferencesService] Failed to remove from localStorage:", err);
  }
}

/**
 * Gets the auto-advance live replay preference from localStorage.
 * Returns null when no explicit preference is stored.
 */
export function getAutoAdvanceLiveReplayFromLocalStorage(): boolean | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = localStorage.getItem(AUTO_ADVANCE_LIVE_REPLAY_KEY);
    if (stored === null) {
      return null;
    }
    if (stored === "true") {
      return true;
    }
    if (stored === "false") {
      return false;
    }
  } catch (err) {
    console.warn("[userPreferencesService] Failed to read from localStorage:", err);
  }

  return null;
}

/**
 * Saves the auto-advance live replay preference to localStorage.
 */
export function saveAutoAdvanceLiveReplayToLocalStorage(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(AUTO_ADVANCE_LIVE_REPLAY_KEY, String(enabled));
  } catch (err) {
    console.warn("[userPreferencesService] Failed to write to localStorage:", err);
  }
}

/**
 * Removes the auto-advance live replay preference from localStorage.
 */
export function removeAutoAdvanceLiveReplayFromLocalStorage(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(AUTO_ADVANCE_LIVE_REPLAY_KEY);
  } catch (err) {
    console.warn("[userPreferencesService] Failed to remove from localStorage:", err);
  }
}

/**
 * Gets the piece value preset from localStorage.
 * Returns null when no valid explicit preference is stored.
 */
export function getPieceValuePresetFromLocalStorage(): PieceValuePreset | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = localStorage.getItem(PIECE_VALUE_PRESET_KEY);
    return isPieceValuePreset(stored) ? stored : null;
  } catch (err) {
    console.warn("[userPreferencesService] Failed to read from localStorage:", err);
    return null;
  }
}

/**
 * Saves the piece value preset and notifies same-tab subscribers.
 */
export function savePieceValuePresetToLocalStorage(preset: PieceValuePreset): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(PIECE_VALUE_PRESET_KEY, preset);
    window.dispatchEvent(new Event(PIECE_VALUE_PRESET_CHANGE_EVENT));
  } catch (err) {
    console.warn("[userPreferencesService] Failed to write to localStorage:", err);
  }
}

/**
 * Subscribe to piece-value changes made in this tab or another browser tab.
 */
export function subscribeToPieceValuePresetChanges(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === PIECE_VALUE_PRESET_KEY) {
      onChange();
    }
  };

  window.addEventListener(PIECE_VALUE_PRESET_CHANGE_EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(PIECE_VALUE_PRESET_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

/**
 * Snapshot used by React preference subscribers.
 */
export function getPieceValuePresetSnapshot(): PieceValuePreset {
  return getPieceValuePresetFromLocalStorage() ?? DEFAULT_PIECE_VALUE_PRESET;
}

/* -------------------------------------------------------------------------- */
/* Unified Preference Loading                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Loads the board annotation color from localStorage, falling back to the
 * default. Async so callers that were written against the old localStorage →
 * Firestore path keep working unchanged.
 */
export async function loadBoardAnnotationColor(): Promise<string> {
  return getBoardAnnotationColorFromLocalStorage();
}

/**
 * Loads the auto-advance live replay preference from localStorage, defaulting
 * to `false` when nothing is stored.
 */
export async function loadAutoAdvanceLiveReplayPreference(): Promise<boolean> {
  return getAutoAdvanceLiveReplayFromLocalStorage() ?? false;
}

/**
 * Loads the piece value preset from localStorage, defaulting to the bughouse
 * preset when nothing is stored.
 */
export async function loadPieceValuePresetPreference(): Promise<PieceValuePreset> {
  return getPieceValuePresetFromLocalStorage() ?? DEFAULT_PIECE_VALUE_PRESET;
}
