/**
 * Smoke test for <Static> — append-only output component (M5 §1-3).
 *
 * Verifies:
 * 1. New items are flushed to stdout as ANSI (written before the main frame).
 * 2. Previously-emitted items are NOT re-emitted on subsequent renders.
 * 3. Mixed use: a normal Box/Text below <Static> still renders via diff loop.
 */
import { test, expect } from "bun:test";
import React, { useState } from "react";
import { Box, Text, Static } from "../src/render/index.js";
import { mount, flush } from "./render-fixtures.js";

function flushRender(): Promise<void> {
  return new Promise((r) => setTimeout(r, 40));
}

// Simple harness: a <Static> above a normal Text.
// External trigger lets us add items to the array.
let addItem!: (label: string) => void;

function StaticDemo(): React.ReactElement {
  const [items, setItems] = useState<string[]>(["first"]);
  addItem = (label) => setItems((prev) => [...prev, label]);

  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Static<string>,
      {
        items,
        children: (item: string, idx: number) =>
          React.createElement(Text, { key: idx }, `static:${item}`),
      },
    ),
    React.createElement(Text, null, "active-region"),
  );
}

test("Static: initial item is flushed on first render", async () => {
  const h = mount(React.createElement(StaticDemo), { columns: 40, rows: 10 });
  await flushRender();

  const allOutput = h.frames.join("");
  // The static item "first" should appear somewhere in the output.
  expect(allOutput).toContain("static:first");
  // The active region should also be rendered.
  expect(allOutput).toContain("active-region");

  h.unmount();
});

test("Static: adding an item emits only the NEW item, not old ones", async () => {
  const h = mount(React.createElement(StaticDemo), { columns: 40, rows: 10 });
  await flushRender();

  // Capture frame count after first render.
  const framesBefore = h.frames.length;
  const outputBefore = h.frames.join("");

  // Add a second item.
  addItem("second");
  await flushRender();

  // New output (frames after the initial render)
  const newOutput = h.frames.slice(framesBefore).join("");

  // "second" should appear in new output.
  expect(newOutput).toContain("static:second");

  // "first" should NOT be repeated in new output (already committed).
  expect(newOutput).not.toContain("static:first");

  h.unmount();
});

test("Static: active region still renders via diff after static flush", async () => {
  const h = mount(React.createElement(StaticDemo), { columns: 40, rows: 10 });
  await flushRender();

  // The active-region text should appear in main frame output.
  const allOutput = h.frames.join("");
  expect(allOutput).toContain("active-region");

  h.unmount();
});
