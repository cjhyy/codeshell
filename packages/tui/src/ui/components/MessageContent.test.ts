import { describe, expect, test } from "bun:test";
import { calculateMarkdownTableColumnWidths, type TableData } from "./MessageContent.js";

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
