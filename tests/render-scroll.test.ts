import { test, expect } from "bun:test";
import React, { useRef, useEffect } from "react";
import { Text, ScrollBox, Box, type ScrollBoxHandle } from "../packages/tui/src/render/index.js";
import { mount } from "./render-fixtures.js";

// ScrollBox needs flexGrow (not a fixed height) inside a constrained parent to
// get a scroll range > 0 from Yoga. With a fixed `height` prop, the inner
// content box (flexGrow:1 in Overflow.Scroll) equals the viewport height so
// maxScroll = 0. Using flexGrow:1 on the ScrollBox within a Box{ height: N }
// parent gives scrollHeight = childrenHeight, viewportHeight = N.
const VIEWPORT_ROWS = 10;
const CONTENT_ROWS = 20; // 20 > VIEWPORT_ROWS → maxScroll = 10

// The render loop uses a 16ms throttle. setImmediate lands within the same
// microtask drain but does NOT wait for the trailing throttle edge. A 30ms
// timeout reliably lets at least one full frame fire.
function flushRender(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

// Builds a vertically-constrained root that houses a flexGrow ScrollBox
// matching production usage (AlternateScreen → flexGrow ScrollBox).
function makeHarness(
  childCount: number,
  stickyScroll?: boolean,
  onHandle?: (h: ScrollBoxHandle) => void,
): React.ReactElement {
  return React.createElement(
    Box,
    { height: VIEWPORT_ROWS, flexDirection: "column" },
    React.createElement(
      ScrollBox,
      {
        ref: (r: ScrollBoxHandle | null) => {
          if (r && onHandle) onHandle(r);
        },
        flexGrow: 1,
        flexDirection: "column",
        stickyScroll: stickyScroll ?? false,
      } as Parameters<typeof ScrollBox>[0],
      ...Array.from({ length: childCount }, (_, i) =>
        React.createElement(Text, { key: i }, `row-${i}`),
      ),
    ),
  );
}

// ─── Test 1: scrollTo clamps scrollTop to [0, contentHeight - viewportHeight] ─

test("scrollTo clamps to max scroll", async () => {
  let handle: ScrollBoxHandle | null = null;
  const h = mount(
    makeHarness(CONTENT_ROWS, false, (r) => (handle = r)),
    { columns: 40, rows: 24 },
  );
  await flushRender();
  expect(handle).not.toBeNull();

  // Normal in-range scroll: value should survive the renderer clamp.
  handle!.scrollTo(3);
  await flushRender();
  expect(handle!.getScrollTop()).toBe(3);

  // Way-past-end scroll: renderer clamps to maxScroll = contentRows - viewportRows.
  handle!.scrollTo(9999);
  await flushRender();
  // maxScroll = CONTENT_ROWS - VIEWPORT_ROWS = 20 - 10 = 10
  expect(handle!.getScrollTop()).toBeLessThanOrEqual(CONTENT_ROWS - VIEWPORT_ROWS);

  h.unmount();
});

// ─── Test 2: stickyScroll keeps view pinned as content grows ──────────────────

test("stickyScroll keeps view pinned as content grows", async () => {
  let handle: ScrollBoxHandle | null = null;

  // Start with fewer rows than the viewport (no scroll range yet).
  const h = mount(
    makeHarness(5, true, (r) => (handle = r)),
    { columns: 40, rows: 24 },
  );
  await flushRender();
  expect(handle).not.toBeNull();
  // stickyScroll attribute is on the DOM node from the start.
  expect(handle!.isSticky()).toBe(true);

  // Grow to CONTENT_ROWS (20). The renderer, seeing stickyScroll=true, pins
  // scrollTop to the new maxScroll = 20 − 10 = 10.
  h.instance.rerender(makeHarness(CONTENT_ROWS, true, (r) => (handle = r)));
  await flushRender();
  expect(handle!.getScrollTop()).toBeGreaterThanOrEqual(CONTENT_ROWS - VIEWPORT_ROWS);

  h.unmount();
});

// ─── Test 3: subscribe fires listener on imperative scroll changes ─────────────

test("subscribe notifies on scroll change", async () => {
  let handle: ScrollBoxHandle | null = null;
  const h = mount(
    makeHarness(CONTENT_ROWS, false, (r) => (handle = r)),
    { columns: 40, rows: 24 },
  );
  await flushRender();
  expect(handle).not.toBeNull();

  const seen: number[] = [];
  // subscribe fires synchronously inside scrollTo (notify() runs before the
  // microtask render), so seen is populated before the first await.
  const unsub = handle!.subscribe(() => seen.push(handle!.getScrollTop()));

  handle!.scrollTo(7);
  // Already populated synchronously — no flush needed for the assertion.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).toContain(7);

  unsub();
  // After unsubscribing, further scrolls should not add entries.
  const lenBefore = seen.length;
  handle!.scrollTo(2);
  await flushRender();
  expect(seen.length).toBe(lenBefore);

  h.unmount();
});
