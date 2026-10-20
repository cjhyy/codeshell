import { test, expect } from "bun:test";
import React from "react";
import { mount, flush, plainText } from "../../../tests/render-fixtures.ts";

// No network is used by these isolated component fixtures, including imports.
globalThis.fetch = (() => {
  throw new Error("audit fixture forbids network");
}) as typeof fetch;
const { MessageContent } = await import("../../../packages/tui/src/ui/components/MessageContent.tsx");

async function render(text: string) {
  const h = mount(React.createElement(MessageContent, { text }), { columns: 80, rows: 30 });
  try {
    await flush();
    await flush();
    return plainText(h);
  } finally {
    h.unmount();
  }
}

test("R2-06 fenced markdown table is extracted as a rendered table and loses literal syntax", async () => {
  const input = "```md\n| field | value |\n| --- | --- |\n| key | sample |\n```";
  const output = await render(input);
  console.log(JSON.stringify({ case: "fenced-table", input, output }));
  expect(output).toContain("field");
  expect(output).toContain("sample");
  expect(output).not.toContain("| field | value |");
  expect(output).not.toContain("| --- | --- |");
});

test("R2-06 plain fenced code keeps its literal pipe and normal tables render", async () => {
  const code = await render("```txt\nleft | right\n```" );
  expect(code).toContain("left | right");
  const table = await render("| field | value |\n| --- | --- |\n| key | sample |");
  expect(table).toContain("sample");
  expect(table).not.toContain("| --- | --- |");
});

test("R2-07 escaped pipe splits a table cell into two and discards last-column content", async () => {
  const input = "| expression | result |\n| --- | --- |\n| left \\| right | expected-tail |";
  const output = await render(input);
  console.log(JSON.stringify({ case: "escaped-pipe", input, output }));
  expect(output).toContain("left");
  expect(output).toContain("right");
  expect(output).not.toContain("expected-tail");
});
