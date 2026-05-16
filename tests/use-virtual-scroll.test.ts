/**
 * Tests for useVirtualScroll — viewport-windowed mount range + scroll update.
 *
 * Harness mirrors VirtualMessageList: outer Box with fixed height contains a
 * flexGrow ScrollBox with topSpacer (+ spacerRef), items slice, bottomSpacer.
 * The spacerRef attachment is required for listOrigin to settle; without it the
 * hook always falls back to the cold-start path (range = [n-COLD, n]).
 */
import { test, expect } from "bun:test";
import React, { useRef } from "react";
import { Box, Text, ScrollBox, type ScrollBoxHandle } from "../src/render/index.js";
import { useVirtualScroll } from "../src/ui/hooks/useVirtualScroll.js";
import { mount } from "./render-fixtures.js";

// ─── Constants (must match the hook's internals) ─────────────────────────────
const MAX_MOUNTED_ITEMS = 300;
const COLD_START_COUNT = 30;

// The render loop uses a 16ms throttle; 50ms reliably lets two frame-cycles fire
// so height measurements + range recalculations settle.
function flushRender(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

// ─── Harness ──────────────────────────────────────────────────────────────────
/**
 * Minimal component that wraps useVirtualScroll and exposes `range` via an
 * `onRange` callback on every render.
 */
function VirtualList({
  itemKeys,
  columns,
  scrollHandleRef,
  onRange,
}: {
  itemKeys: readonly string[];
  columns: number;
  scrollHandleRef: React.MutableRefObject<ScrollBoxHandle | null>;
  onRange: (range: readonly [number, number]) => void;
}) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);

  // Forward the handle to the caller so tests can call scrollTo/scrollBy.
  React.useLayoutEffect(() => {
    scrollHandleRef.current = scrollRef.current;
  });

  const { range, topSpacer, bottomSpacer, measureRef, spacerRef } =
    useVirtualScroll(scrollRef, itemKeys, columns);

  // Report range to the test on every render.
  onRange(range);

  const [start, end] = range;

  return React.createElement(
    ScrollBox,
    {
      ref: scrollRef,
      flexGrow: 1 as unknown as undefined,
      flexDirection: "column" as const,
      stickyScroll: false,
    } as Parameters<typeof ScrollBox>[0],
    // topSpacer — spacerRef MUST be attached here so listOrigin reads correctly.
    React.createElement(Box, { ref: spacerRef, height: topSpacer, flexShrink: 0 }),
    // Rendered slice.
    ...itemKeys.slice(start, end).map((key) =>
      React.createElement(
        Box,
        { key, ref: measureRef(key), flexShrink: 0 },
        React.createElement(Text, null, key),
      ),
    ),
    // bottomSpacer.
    React.createElement(Box, { height: bottomSpacer, flexShrink: 0 }),
  );
}

/**
 * Build a root element: outer Box (fixed height = viewportRows) → VirtualList.
 */
function makeRoot(opts: {
  itemKeys: readonly string[];
  columns: number;
  viewportRows: number;
  scrollHandleRef: React.MutableRefObject<ScrollBoxHandle | null>;
  onRange: (range: readonly [number, number]) => void;
}): React.ReactElement {
  return React.createElement(
    Box,
    { height: opts.viewportRows, flexDirection: "column" },
    React.createElement(VirtualList, {
      itemKeys: opts.itemKeys,
      columns: opts.columns,
      scrollHandleRef: opts.scrollHandleRef,
      onRange: opts.onRange,
    }),
  );
}

// ─── Test 1: viewport windowing ───────────────────────────────────────────────

test("only mounts items inside the viewport window (+overscan)", async () => {
  const ITEM_COUNT = 10_000;
  const itemKeys = Array.from({ length: ITEM_COUNT }, (_, i) => `item-${i}`);

  let latestRange: readonly [number, number] = [0, 0];
  const scrollHandleRef: React.MutableRefObject<ScrollBoxHandle | null> = { current: null };

  const h = mount(
    makeRoot({
      itemKeys,
      columns: 80,
      viewportRows: 20,
      scrollHandleRef,
      onRange: (r) => { latestRange = r; },
    }),
    { columns: 80, rows: 24 },
  );

  // Give the renderer time to lay out and let the hook settle past cold-start.
  await flushRender();

  const [start, end] = latestRange;
  const mountedCount = end - start;

  // Cold-start path: range = [n - COLD_START_COUNT, n] → 30 items. That's
  // already way below 10 000. The real-layout path (once spacerRef settles)
  // targets viewport + 2×OVERSCAN ≈ 200, also well below the 10 000 guard.
  expect(mountedCount).toBeGreaterThan(0);
  expect(mountedCount).toBeLessThanOrEqual(MAX_MOUNTED_ITEMS);

  // The range must stay within valid bounds.
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeLessThanOrEqual(ITEM_COUNT);

  h.unmount();
});

// ─── Test 2: scrolling shifts the visible window ──────────────────────────────

test("scrolling updates the visible window", async () => {
  const ITEM_COUNT = 1_000;
  const itemKeys = Array.from({ length: ITEM_COUNT }, (_, i) => `item-${i}`);

  let latestRange: readonly [number, number] = [0, 0];
  const scrollHandleRef: React.MutableRefObject<ScrollBoxHandle | null> = { current: null };

  const h = mount(
    makeRoot({
      itemKeys,
      columns: 80,
      viewportRows: 20,
      scrollHandleRef,
      onRange: (r) => { latestRange = r; },
    }),
    { columns: 80, rows: 24 },
  );

  // Wait for initial layout.
  await flushRender();

  // Cold-start lands the range near the tail (isSticky=true default before
  // layout). Scroll to ~50% of the list to exercise the non-sticky path.
  const handle = scrollHandleRef.current;
  expect(handle).not.toBeNull();

  // Each item renders as one Text row; scrollTop ≈ item index.
  // Scroll to roughly the middle of the list.
  const targetScrollTop = Math.floor(ITEM_COUNT / 2);
  handle!.scrollTo(targetScrollTop);

  // Wait for the hook to react to the quantized scroll snapshot and re-render.
  await flushRender();

  const [start, end] = latestRange;

  // After scrolling to the middle the range should have shifted away from tail.
  // Specifically, `start` must be greater than 0 (we're no longer at the very
  // top or only in the cold-start tail window).
  expect(start).toBeGreaterThan(0);

  // The window must still be bounded.
  expect(end - start).toBeLessThanOrEqual(MAX_MOUNTED_ITEMS);
  expect(end).toBeLessThanOrEqual(ITEM_COUNT);

  // The mounted window should be loosely near the scroll target.
  // With OVERSCAN_ROWS=80 the window spans ~200 rows; start should be within
  // ~200 rows of where we scrolled (generous tolerance for estimate drift).
  const TOLERANCE = 300;
  expect(start).toBeLessThan(targetScrollTop + TOLERANCE);

  h.unmount();
});
