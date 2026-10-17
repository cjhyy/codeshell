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
  for (const [name, input, expected] of [
    ["one completed CRLF line", "ready\r\n", "ready\n"],
    ["two completed CRLF lines", "ready\r\nnext\r\n", "ready\nnext\n"],
    ["mixed LF and CRLF", "first\nsecond\r\nlast", "first\nsecond\nlast"],
    ["progress completed by CRLF", "10%\r100%\r\nready\r\n", "100%\nready\n"],
  ]) {
    test(`preserves visible text in ${name}`, () => {
      expect(foldProgressLines(input)).toBe(expected);
      expect(cleanOutput(input)).toBe(expected);
    });
  }
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
  test("keeps empty lines, whitespace and indentation across newline forms", () => {
    expect(foldProgressLines("\r\n ready \r\n\n\tdone\r\n\r\n")).toBe("\n ready \n\n\tdone\n\n");
    expect(foldProgressLines("")).toBe("");
  });
  test("folds each progress line independently and consumes only the CRLF delimiter", () => {
    expect(foldProgressLines("old\rnew\r\nx\ry\r\n")).toBe("new\ny\n");
    expect(foldProgressLines("old\r\r\nready")).toBe("\nready");
  });
  test("keeps the existing bare CR behavior in incomplete output slices", () => {
    for (const [input, expected] of [
      ["partial", "partial"],
      ["10%\r100", "100"],
      ["10%\r", ""],
      ["tail\r\r", ""],
      ["\r", ""],
    ]) {
      expect(foldProgressLines(input)).toBe(expected);
      expect(cleanOutput(input)).toBe(expected);
    }
  });
  test("cleans a slice with partial first and last lines without inventing content", () => {
    const slice = "prefix\r\nready\r\nlast".slice(3, -2);
    expect(foldProgressLines(slice)).toBe("fix\nready\nla");
    expect(cleanOutput(slice)).toBe("fix\nready\nla");
  });
});

describe("cleanOutput", () => {
  test("strips ANSI and folds progress in one pass", () => {
    const raw = "\x1b[32m▕███░ 45%\r\x1b[32m▕████ 100%\nServer ready\x1b[0m";
    expect(cleanOutput(raw)).toBe("▕████ 100%\nServer ready");
  });
  test("preserves completed CRLF text after ANSI cleanup and Unicode progress folding", () => {
    const raw = "\x1b[32m工作 10%\r\x1b[32m完成😀\x1b[0m\r\n\x1b[2Kready\r\n";
    expect(cleanOutput(raw)).toBe("完成😀\nready\n");
  });
});
