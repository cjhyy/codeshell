import { describe, test, expect } from "bun:test";
import { stripAnsi, foldProgressLines, cleanOutput } from "./output-clean.js";

describe("stripAnsi", () => {
  test("removes color escapes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
  });
  test("removes cursor/erase escapes", () => {
    expect(stripAnsi("a\x1b[2Kb\x1b[1Gc")).toBe("abc");
  });
  test("leaves plain text untouched", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

describe("foldProgressLines", () => {
  test("collapses \\r progress frames to the last frame", () => {
    const input = "downloading 10%\rdownloading 50%\rdownloading 100%\ndone";
    expect(foldProgressLines(input)).toBe("downloading 100%\ndone");
  });
  test("keeps normal newlines", () => {
    expect(foldProgressLines("a\nb\nc")).toBe("a\nb\nc");
  });
  test("handles trailing \\r without newline", () => {
    expect(foldProgressLines("x 1%\rx 2%")).toBe("x 2%");
  });
});

describe("cleanOutput", () => {
  test("strips ANSI and folds progress in one pass", () => {
    const raw = "\x1b[32m▕███░ 45%\r\x1b[32m▕████ 100%\nServer ready\x1b[0m";
    expect(cleanOutput(raw)).toBe("▕████ 100%\nServer ready");
  });
});
