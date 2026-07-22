import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getBoardAnnotationColorFromLocalStorage,
  saveBoardAnnotationColorToLocalStorage,
  removeBoardAnnotationColorFromLocalStorage,
  getAutoAdvanceLiveReplayFromLocalStorage,
  saveAutoAdvanceLiveReplayToLocalStorage,
  removeAutoAdvanceLiveReplayFromLocalStorage,
  loadBoardAnnotationColor,
  loadAutoAdvanceLiveReplayPreference,
  getPieceValuePresetFromLocalStorage,
  savePieceValuePresetToLocalStorage,
  loadPieceValuePresetPreference,
  DEFAULT_BOARD_ANNOTATION_COLOR,
} from "@/app/utils/preferences/userPreferencesService";

function createStorageMock(initial: Record<string, string> = {}): {
  storage: Storage;
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => void data.clear(),
      key: (index: number) => Array.from(data.keys())[index] ?? null,
      get length() {
        return data.size;
      },
    } as Storage,
  };
}

describe("userPreferencesService - localStorage operations", () => {
  beforeEach(() => {
    // Reset localStorage mocks
    vi.clearAllMocks();
  });

  describe("getBoardAnnotationColorFromLocalStorage", () => {
    it("returns default color when localStorage is empty", () => {
      const { storage } = createStorageMock();
      // Mock window.localStorage
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      const color = getBoardAnnotationColorFromLocalStorage();
      expect(color).toBe(DEFAULT_BOARD_ANNOTATION_COLOR);
    });

    it("returns stored color from localStorage", () => {
      const customColor = "rgb(255, 0, 0, 0.95)";
      const { storage } = createStorageMock({
        "bh-board-annotation-color": customColor,
      });
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      const color = getBoardAnnotationColorFromLocalStorage();
      expect(color).toBe(customColor);
    });

    it("handles localStorage errors gracefully", () => {
      const errorStorage = {
        getItem: () => {
          throw new Error("Storage quota exceeded");
        },
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      } as unknown as Storage;
      Object.defineProperty(window, "localStorage", {
        value: errorStorage,
        writable: true,
      });

      // Should not throw and return default
      const color = getBoardAnnotationColorFromLocalStorage();
      expect(color).toBe(DEFAULT_BOARD_ANNOTATION_COLOR);
    });
  });

  describe("saveBoardAnnotationColorToLocalStorage", () => {
    it("saves color to localStorage", () => {
      const { storage, data } = createStorageMock();
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      const customColor = "rgb(255, 0, 0, 0.95)";
      saveBoardAnnotationColorToLocalStorage(customColor);

      expect(data.get("bh-board-annotation-color")).toBe(customColor);
    });

    it("handles localStorage errors gracefully", () => {
      const errorStorage = {
        getItem: () => null,
        setItem: () => {
          throw new Error("Storage quota exceeded");
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      } as unknown as Storage;
      Object.defineProperty(window, "localStorage", {
        value: errorStorage,
        writable: true,
      });

      // Should not throw
      expect(() => {
        saveBoardAnnotationColorToLocalStorage("rgb(255, 0, 0, 0.95)");
      }).not.toThrow();
    });
  });

  describe("removeBoardAnnotationColorFromLocalStorage", () => {
    it("removes color from localStorage", () => {
      const { storage, data } = createStorageMock({
        "bh-board-annotation-color": "rgb(255, 0, 0, 0.95)",
      });
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      removeBoardAnnotationColorFromLocalStorage();

      expect(data.get("bh-board-annotation-color")).toBeUndefined();
    });

    it("handles localStorage errors gracefully", () => {
      const errorStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {
          throw new Error("Storage error");
        },
        clear: () => {},
        key: () => null,
        length: 0,
      } as unknown as Storage;
      Object.defineProperty(window, "localStorage", {
        value: errorStorage,
        writable: true,
      });

      // Should not throw
      expect(() => {
        removeBoardAnnotationColorFromLocalStorage();
      }).not.toThrow();
    });
  });

  describe("getAutoAdvanceLiveReplayFromLocalStorage", () => {
    it("returns null when localStorage has no preference", () => {
      const { storage } = createStorageMock();
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      const preference = getAutoAdvanceLiveReplayFromLocalStorage();
      expect(preference).toBeNull();
    });

    it("returns true when preference is stored", () => {
      const { storage } = createStorageMock({
        "bh-auto-advance-live-replay": "true",
      });
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      const preference = getAutoAdvanceLiveReplayFromLocalStorage();
      expect(preference).toBe(true);
    });

    it("returns false when preference is stored", () => {
      const { storage } = createStorageMock({
        "bh-auto-advance-live-replay": "false",
      });
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      const preference = getAutoAdvanceLiveReplayFromLocalStorage();
      expect(preference).toBe(false);
    });
  });

  describe("saveAutoAdvanceLiveReplayToLocalStorage", () => {
    it("saves preference to localStorage", () => {
      const { storage, data } = createStorageMock();
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      saveAutoAdvanceLiveReplayToLocalStorage(true);

      expect(data.get("bh-auto-advance-live-replay")).toBe("true");
    });

    it("handles localStorage errors gracefully", () => {
      const errorStorage = {
        getItem: () => null,
        setItem: () => {
          throw new Error("Storage quota exceeded");
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      } as unknown as Storage;
      Object.defineProperty(window, "localStorage", {
        value: errorStorage,
        writable: true,
      });

      expect(() => {
        saveAutoAdvanceLiveReplayToLocalStorage(false);
      }).not.toThrow();
    });
  });

  describe("removeAutoAdvanceLiveReplayFromLocalStorage", () => {
    it("removes preference from localStorage", () => {
      const { storage, data } = createStorageMock({
        "bh-auto-advance-live-replay": "true",
      });
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      removeAutoAdvanceLiveReplayFromLocalStorage();

      expect(data.get("bh-auto-advance-live-replay")).toBeUndefined();
    });
  });

  describe("piece value preset localStorage operations", () => {
    it("returns null for missing or invalid values", () => {
      const { storage } = createStorageMock({
        "bh-piece-value-preset": "unsupported",
      });
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      expect(getPieceValuePresetFromLocalStorage()).toBeNull();
    });

    it("reads and saves a valid preset", () => {
      const { storage, data } = createStorageMock({
        "bh-piece-value-preset": "standard",
      });
      Object.defineProperty(window, "localStorage", {
        value: storage,
        writable: true,
      });

      expect(getPieceValuePresetFromLocalStorage()).toBe("standard");

      savePieceValuePresetToLocalStorage("bughouse");
      expect(data.get("bh-piece-value-preset")).toBe("bughouse");
    });
  });
});

describe("userPreferencesService - unified loading (localStorage only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loadBoardAnnotationColor", () => {
    it("returns the localStorage value when present", async () => {
      const customColor = "rgb(255, 0, 0, 0.95)";
      const { storage } = createStorageMock({
        "bh-board-annotation-color": customColor,
      });
      Object.defineProperty(window, "localStorage", { value: storage, writable: true });

      await expect(loadBoardAnnotationColor()).resolves.toBe(customColor);
    });

    it("returns the default when localStorage is empty", async () => {
      const { storage } = createStorageMock();
      Object.defineProperty(window, "localStorage", { value: storage, writable: true });

      await expect(loadBoardAnnotationColor()).resolves.toBe(DEFAULT_BOARD_ANNOTATION_COLOR);
    });
  });

  describe("loadAutoAdvanceLiveReplayPreference", () => {
    it("returns the stored preference when present", async () => {
      const { storage } = createStorageMock({
        "bh-auto-advance-live-replay": "true",
      });
      Object.defineProperty(window, "localStorage", { value: storage, writable: true });

      await expect(loadAutoAdvanceLiveReplayPreference()).resolves.toBe(true);
    });

    it("returns false by default", async () => {
      const { storage } = createStorageMock();
      Object.defineProperty(window, "localStorage", { value: storage, writable: true });

      await expect(loadAutoAdvanceLiveReplayPreference()).resolves.toBe(false);
    });
  });

  describe("loadPieceValuePresetPreference", () => {
    it("returns the stored preset when present", async () => {
      const { storage } = createStorageMock({
        "bh-piece-value-preset": "standard",
      });
      Object.defineProperty(window, "localStorage", { value: storage, writable: true });

      await expect(loadPieceValuePresetPreference()).resolves.toBe("standard");
    });

    it("uses Bughouse values by default", async () => {
      const { storage } = createStorageMock();
      Object.defineProperty(window, "localStorage", { value: storage, writable: true });

      await expect(loadPieceValuePresetPreference()).resolves.toBe("bughouse");
    });
  });
});
