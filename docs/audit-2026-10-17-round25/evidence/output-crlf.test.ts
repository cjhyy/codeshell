import { describe, expect, test } from "bun:test";
import {
  cleanOutput,
  foldProgressLines,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/runtime/output-clean.ts";

function characterize(label: string, input: string, expectedCleanText: string, currentText: string) {
  const folded = foldProgressLines(input);
  const observed = cleanOutput(input);
  expect(folded).toBe(currentText);
  expect(observed).toBe(currentText);
  expect(observed).not.toBe(expectedCleanText);
  console.log(JSON.stringify({
    characterization: label,
    input,
    literalExpectedCleanText: expectedCleanText,
    observed,
    boundary: "Owned short ASCII strings; actual leaf only. Passing asserts current wrong behavior, not a fix.",
  }));
}

describe("round25 actual output-clean CRLF characterization and ordinary controls", () => {
  test("a completed CRLF line loses its visible text", () => {
    characterize("one CRLF line", "ready\r\n", "ready\n", "\n");
  });

  test("two completed CRLF lines retain separators while losing both bodies", () => {
    characterize("two CRLF lines", "ready\r\nnext\r\n", "ready\nnext\n", "\n\n");
  });

  test("mixed LF and CRLF loses only the CRLF line body", () => {
    characterize("mixed LF and CRLF", "first\nsecond\r\nlast", "first\nsecond\nlast", "first\n\nlast");
  });

  test("a progress redraw completed by CRLF also loses its final visible frame", () => {
    characterize("progress ending in CRLF", "10%\r100%\r\nready\r\n", "100%\nready\n", "\n\n");
  });

  test("ordinary LF lines keep their visible text", () => {
    const text = "ready\nnext\n";
    expect(foldProgressLines(text)).toBe(text);
    expect(cleanOutput(text)).toBe(text);
  });

  test("bare CR progress still keeps the final frame", () => {
    const input = "10%\r100%\nready";
    const expected = "100%\nready";
    expect(foldProgressLines(input)).toBe(expected);
    expect(cleanOutput(input)).toBe(expected);
  });
});
