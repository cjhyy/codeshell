import { describe, expect, test } from "bun:test";
import { shouldCloseOnKey } from "./Lightbox";

describe("shouldCloseOnKey", () => {
  test("Escape closes the lightbox", () => {
    expect(shouldCloseOnKey("Escape")).toBe(true);
  });

  test("other keys do not close", () => {
    expect(shouldCloseOnKey("Enter")).toBe(false);
    expect(shouldCloseOnKey("a")).toBe(false);
    expect(shouldCloseOnKey(" ")).toBe(false);
  });
});
