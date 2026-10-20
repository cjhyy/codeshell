import { describe, expect, test } from "bun:test";
import React from "react";
import { flush, mount, plainText } from "../../../../../tests/render-fixtures.js";
import {
  __renderMarkdownForTest,
  __resetMarkdownRenderCacheForTest,
  calculateMarkdownTableColumnWidths,
  MessageContent,
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

async function renderMessage(text: string): Promise<string> {
  const harness = mount(React.createElement(MessageContent, { text }), { columns: 80, rows: 30 });
  try {
    await flush();
    await flush();
    return plainText(harness);
  } finally {
    harness.unmount();
  }
}

describe("MessageContent tables", () => {
  test("keeps a table inside a code fence as literal source", async () => {
    const output = await renderMessage(
      "Example:\n\n```md\n```js\n| field | value |\n| --- | --- |\n| key | sample |\n```",
    );
    expect(output).toContain("| field | value |");
    expect(output).toContain("| --- | --- |");
    expect(output).toContain("```js");
  });

  test("still renders a real table after a fenced block", async () => {
    const output = await renderMessage(
      "```txt\nleft | right\n```\n\n| field | value |\n| --- | --- |\n| key | sample |",
    );
    expect(output).toContain("left | right");
    expect(output).toContain("sample");
    expect(output).not.toContain("| --- | --- |");
  });

  test("an escaped pipe stays inside its cell", async () => {
    const output = await renderMessage(
      "| expression | result |\n| --- | --- |\n| left \\| right | expected-tail |",
    );
    expect(output).toContain("left | right");
    expect(output).toContain("expected-tail");
  });
});
