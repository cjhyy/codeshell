import { describe, expect, test } from "bun:test";
import {
  MIMI_COMPANION_DEFAULT_SIZE,
  MIMI_COMPANION_MAX_SIZE,
  MIMI_COMPANION_QUICK_SIZES,
  MIMI_COMPANION_SIZE_NAMES,
  MIMI_COMPANION_SIZE_OPTIONS,
} from "./mimi-companion";

describe("Mimi companion sizes", () => {
  test("the menu's quick sizes are settings sizes under the same names", () => {
    for (const { name, size } of MIMI_COMPANION_QUICK_SIZES) {
      expect(MIMI_COMPANION_SIZE_OPTIONS as readonly number[]).toContain(size);
      expect(MIMI_COMPANION_SIZE_NAMES[size]).toBe(name);
    }
    expect(MIMI_COMPANION_QUICK_SIZES.map(({ size }) => size)).toContain(
      MIMI_COMPANION_DEFAULT_SIZE,
    );
  });

  test("only the real maximum is called the largest", () => {
    const largest = Object.entries(MIMI_COMPANION_SIZE_NAMES)
      .filter(([, name]) => name === "largest")
      .map(([size]) => Number(size));
    expect(largest).toEqual([MIMI_COMPANION_MAX_SIZE]);
    expect(Math.max(...MIMI_COMPANION_SIZE_OPTIONS)).toBe(MIMI_COMPANION_MAX_SIZE);
    for (const size of Object.keys(MIMI_COMPANION_SIZE_NAMES).map(Number))
      expect(MIMI_COMPANION_SIZE_OPTIONS as readonly number[]).toContain(size);
  });
});
