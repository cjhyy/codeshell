#!/usr/bin/env bun
import React, { useRef, useEffect } from "react";
import { Box, Text, ScrollBox, type ScrollBoxHandle } from "../packages/tui/src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

function App({ count, onReady }: { count: number; onReady: (h: ScrollBoxHandle) => void }) {
  const ref = useRef<ScrollBoxHandle | null>(null);
  useEffect(() => {
    if (ref.current) onReady(ref.current);
  }, [onReady]);
  // Match the working ScrollBox pattern from tests: outer Box with explicit
  // height, inner ScrollBox with flexGrow:1.
  return React.createElement(
    Box,
    { height: 40, flexDirection: "column" },
    React.createElement(
      ScrollBox,
      { ref, flexGrow: 1, flexDirection: "column", stickyScroll: false },
      ...Array.from({ length: count }, (_, i) => React.createElement(Text, { key: i }, `row-${i}`)),
    ),
  );
}

async function main() {
  const ready: { handle: ScrollBoxHandle | null } = { handle: null };
  const h = setup(React.createElement(App, { count: 10000, onReady: (r) => (ready.handle = r) }), {
    columns: 120,
    rows: 40,
  });
  try {
    await flush();
    // Give the ScrollBox layout one extra tick to settle.
    await new Promise((r) => setTimeout(r, 30));
    const handle = ready.handle;
    if (!handle) throw new Error("ScrollBox handle never resolved");
    const STEPS = 100;
    const t = await time("wheel-100-steps", STEPS, async () => {
      handle.scrollBy(20);
      // Wait for the 16ms ScrollBox throttle to drain and the renderer to commit.
      await new Promise((r) => setTimeout(r, 20));
    });
    printTable([t]);
    process.stdout.write(
      `bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\nwrite_count=${h.writeCount}\n`,
    );
    // Assert the loop actually drove renders — fail loudly rather than print
    // misleading timings that only measured microtask/macrotask latency.
    if (handle.getScrollTop() <= 0) {
      throw new Error(
        `Bench assertion failed: getScrollTop()=${handle.getScrollTop()} — scroll did not advance`,
      );
    }
    if (h.frameCount <= 50) {
      throw new Error(
        `Bench assertion failed: frame_count=${h.frameCount} — renders did not occur (expected >50)`,
      );
    }
  } finally {
    h.unmount();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
