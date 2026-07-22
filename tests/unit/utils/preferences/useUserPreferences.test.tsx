import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useUserPreferences } from "@/app/utils/preferences/useUserPreferences";
import { DEFAULT_BOARD_ANNOTATION_COLOR } from "@/app/utils/preferences/userPreferencesService";
import * as userPreferencesService from "@/app/utils/preferences/userPreferencesService";

// Mock the userPreferencesService
vi.mock("@/app/utils/preferences/userPreferencesService", () => ({
  loadBoardAnnotationColor: vi.fn(),
  loadAutoAdvanceLiveReplayPreference: vi.fn(),
  loadPieceValuePresetPreference: vi.fn(),
  DEFAULT_BOARD_ANNOTATION_COLOR: "rgb(52, 168, 83, 0.95)",
}));

describe("useUserPreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset document root style
    document.documentElement.style.removeProperty("--bh-board-annotation-color");
    vi.mocked(userPreferencesService.loadAutoAdvanceLiveReplayPreference).mockResolvedValue(false);
    vi.mocked(userPreferencesService.loadPieceValuePresetPreference).mockResolvedValue("bughouse");
  });

  it("loads preferences from localStorage and updates the CSS variable", async () => {
    const customColor = "rgb(255, 0, 0, 0.95)";
    vi.mocked(userPreferencesService.loadBoardAnnotationColor).mockResolvedValue(customColor);

    renderHook(() => useUserPreferences());

    await waitFor(() => {
      expect(userPreferencesService.loadBoardAnnotationColor).toHaveBeenCalledWith();
    });

    await waitFor(() => {
      const cssValue = document.documentElement.style.getPropertyValue("--bh-board-annotation-color");
      expect(cssValue).toBe(customColor);
    });
  });

  it("uses the default color when loading fails", async () => {
    vi.mocked(userPreferencesService.loadBoardAnnotationColor).mockRejectedValue(
      new Error("Load failed"),
    );

    renderHook(() => useUserPreferences());

    await waitFor(() => {
      expect(userPreferencesService.loadBoardAnnotationColor).toHaveBeenCalled();
    });

    await waitFor(() => {
      const cssValue = document.documentElement.style.getPropertyValue("--bh-board-annotation-color");
      expect(cssValue).toBe(DEFAULT_BOARD_ANNOTATION_COLOR);
    });
  });
});
