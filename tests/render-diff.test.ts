import { test, expect } from "bun:test";
import React from "react";
import { Box, Text, AlternateScreen } from "../packages/tui/src/render/index.js";
import { mount, flush } from "./render-fixtures";

test("changing one cell triggers a write smaller than a full repaint", async () => {
  const Hello = ({ name }: { name: string }) =>
    React.createElement(Box, null, React.createElement(Text, null, `hi ${name}`));

  const h = mount(React.createElement(Hello, { name: "a" }));
  await flush();
  const baseline = h.frames.length;
  h.instance.rerender(React.createElement(Hello, { name: "b" }));
  await flush();
  // After the second render at least one new frame chunk was written, and the
  // total bytes are far below "draw the whole screen".
  expect(h.frames.length).toBeGreaterThan(baseline);
  const lastChunk = h.frames[h.frames.length - 1] ?? "";
  expect(lastChunk.length).toBeLessThan(80 * 24); // less than a full screen of cells
  h.unmount();
});

test("alt-screen clamps content to viewport rows", async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `row-${i}`);
  const h = mount(
    React.createElement(AlternateScreen, null,
      React.createElement(Box, { flexDirection: "column" },
        ...lines.map((l) => React.createElement(Text, { key: l }, l)),
      ),
    ),
    { columns: 80, rows: 24 },
  );
  await flush();
  const all = h.frames.join("");
  // AlternateScreen constrains height to 24 rows — the layout clips the
  // overflow, so only ~24 of the 200 rows are painted.  Yoga places the
  // LAST rows in a column that overflows, so the early rows are clipped.
  // row-0 (top of the 200-row list) should be outside the 24-row viewport.
  expect(all).not.toContain("row-0");
  // Something near the end of the list IS visible (within the 24-row window).
  expect(all).toContain("row-199");
  h.unmount();
});

test("resize causes a fresh frame", async () => {
  // Use content that fills the line so a column change produces a visible diff.
  const Wide = ({ cols }: { cols: number }) =>
    React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, null, "x".repeat(cols)),
    );

  const h = mount(React.createElement(Wide, { cols: 80 }), { columns: 80, rows: 24 });
  await flush();
  const baseline = h.frames.length;

  // Simulate a terminal resize: update stdout dimensions, emit resize, then
  // re-render with content sized to the new width so the diff is non-empty.
  (h.stdout as unknown as { columns: number }).columns = 120;
  (h.stdout as unknown as { rows: number }).rows = 40;
  h.stdout.emit("resize");
  h.instance.rerender(React.createElement(Wide, { cols: 120 }));
  await flush();
  expect(h.frames.length).toBeGreaterThan(baseline);
  h.unmount();
});
