import { describe, expect, test } from "bun:test";
import {
  loadPetWidgetVisible,
  PET_WIDGET_VISIBLE_STORAGE_KEY,
  savePetWidgetVisible,
} from "./petWidgetPrefs";

describe("pet widget preference", () => {
  test("defaults visible and persists an explicit toggle in the existing local preference store", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(loadPetWidgetVisible(storage)).toBe(true);
    savePetWidgetVisible(false, storage);
    expect(values.get(PET_WIDGET_VISIBLE_STORAGE_KEY)).toBe("0");
    expect(loadPetWidgetVisible(storage)).toBe(false);
  });
});
