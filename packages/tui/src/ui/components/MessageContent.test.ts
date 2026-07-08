import { describe, expect, test } from "bun:test";
import {
  __renderMarkdownForTest,
  __resetMarkdownRenderCacheForTest,
  calculateMarkdownTableColumnWidths,
  type TableData,
} from "./MessageContent.js";

function totalWidth(widths: number[]): number {
  return widths.reduce((total, width) => total + width, 0);
}

describe("calculateMarkdownTableColumnWidths", () => {
  test("keeps preferred widths when the table fits", () => {
    const data: TableData = {
      headers: ["ID", "Description"],
      rows: [["1", "Short"]],
    };

    expect(calculateMarkdownTableColumnWidths(data, 80)).toEqual([4, 13]);
  });

  test("shrinks a wide multi-column table to the available width", () => {
    const data: TableData = {
      headers: ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"],
      rows: [
        [
          "a".repeat(100),
          "b".repeat(100),
          "c".repeat(100),
          "d".repeat(100),
          "e".repeat(100),
          "f".repeat(100),
        ],
      ],
    };

    const widths = calculateMarkdownTableColumnWidths(data, 78);

    expect(totalWidth(widths)).toBe(78);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });

  test("allocates proportionally more space to wider columns", () => {
    const data: TableData = {
      headers: ["Name", "Notes", "Owner"],
      rows: [["api", "This note is intentionally long ".repeat(8), "me"]],
    };

    const widths = calculateMarkdownTableColumnWidths(data, 30);

    expect(totalWidth(widths)).toBe(30);
    expect(widths[1]).toBeGreaterThan(widths[0]!);
    expect(widths[1]).toBeGreaterThan(widths[2]!);
  });

  test("does not exceed tiny available widths", () => {
    const data: TableData = {
      headers: ["A", "B", "C", "D", "E"],
      rows: [],
    };

    const widths = calculateMarkdownTableColumnWidths(data, 3);

    expect(totalWidth(widths)).toBeLessThanOrEqual(3);
  });
});

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

describe("markdown render cache width", () => {
  test("renders the same markdown separately for different terminal widths", () => {
    __resetMarkdownRenderCacheForTest();
    const text =
      "This paragraph has enough ordinary words to wrap differently when the terminal width changes during a session.";

    const wide = stripAnsi(__renderMarkdownForTest(text, 80)).trim();
    const narrow = stripAnsi(__renderMarkdownForTest(text, 24)).trim();

    expect(narrow).not.toBe(wide);
    expect(narrow.split("\n").length).toBeGreaterThan(wide.split("\n").length);
  });
});
