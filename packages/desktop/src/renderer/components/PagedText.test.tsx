import { expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PagedText, textPage, needsPagedMarkdown } from "./PagedText";
import { Markdown } from "../Markdown";
import { StreamingMarkdown } from "../messages/StreamingMarkdown";

test("text pages cover every character, including long lines and Unicode boundaries", () => {
  const source = "a".repeat(32767) + "😀" + "\n" + "line\n".repeat(1200) + "tail";
  let offset = 0;
  let restored = "";
  let newlines = 0;
  while (offset < source.length) {
    const page = textPage(source, offset);
    expect(page.value.length).toBeLessThanOrEqual(32768);
    expect(page.newlines).toBeLessThanOrEqual(300);
    expect(page.end).toBeGreaterThan(offset);
    expect(page.value.endsWith("\ud83d")).toBe(false);
    restored += page.value;
    offset = page.end;
    newlines += page.newlines;
  }
  expect(restored).toBe(source);
  expect(newlines).toBe(1201);
});

test("large completed and streaming tables use bounded escaped text instead of a huge table DOM", () => {
  const table = "|a|b|c|\n|-|-|-|\n" + "|1|2|3|\n".repeat(2000) + "<script>bad()</script>";
  expect(needsPagedMarkdown(table)).toBe(true);
  for (const node of [<Markdown text={table} />, <StreamingMarkdown text={table} done={false} />]) {
    const html = renderToStaticMarkup(node);
    expect(html).toContain("data-paged-text");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<script");
    expect(html.length).toBeLessThan(40000);
  }
});

const nodes = (node: any): any[] => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const content = (node: any): string =>
  node.nodeType === 3
    ? (node.nodeValue ?? "")
    : node.childNodes?.length
      ? node.childNodes.map(content).join("")
      : (node.textContent ?? "");

test("paging replaces rows, preserves absolute line numbers and exposes the final line", async () => {
  ensureMiniDom();
  const container = document.createElement("div");
  const root = createRoot(container);
  const lines = Array.from({ length: 605 }, (_, i) => `row-${i + 1}`).join("\n");
  try {
    await act(async () => {
      root.render(
        <PagedText
          text={lines}
          renderLine={(line, number) => <div data-line={number}>{line}</div>}
        />,
      );
      await flushMicrotasks();
    });
    const rows = () =>
      nodes(container).filter(
        (n) =>
          n.getAttribute?.("data-line") !== null && n.getAttribute?.("data-line") !== undefined,
      );
    expect(rows()).toHaveLength(300);
    const next = async () => {
      const button = nodes(container).find(
        (n) =>
          n.tagName?.toLowerCase() === "button" && ["下一页", "Next page"].includes(content(n)),
      );
      const key = Object.keys(button).find((key) => key.startsWith("__reactProps$"))!;
      await act(async () => {
        button[key].onClick();
        await flushMicrotasks();
      });
    };
    await next();
    expect(content(rows()[0])).toBe("row-301");
    expect(rows()).toHaveLength(300);
    await next();
    expect(content(rows().at(-1))).toBe("row-605");
    expect(rows()).toHaveLength(5);
  } finally {
    await act(async () => root.unmount());
  }
});
