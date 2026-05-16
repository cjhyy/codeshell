#!/usr/bin/env bun
import React, { useRef, useEffect } from "react";
import { Box, Text, ScrollBox, type ScrollBoxHandle } from "../src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

function App({ count, onReady }: { count: number; onReady: (h: ScrollBoxHandle) => void }) {
  const ref = useRef<ScrollBoxHandle | null>(null);
  useEffect(() => { if (ref.current) onReady(ref.current); }, [onReady]);
  // Match the working ScrollBox pattern from tests: outer Box with explicit
  // height, inner ScrollBox with flexGrow:1.
  return React.createElement(Box, { height: 40, flexDirection: "column" },
    React.createElement(ScrollBox, { ref, flexGrow: 1, stickyScroll: false },
      ...Array.from({ length: count }, (_, i) =>
        React.createElement(Text, { key: i }, `row-${i}`),
      ),
    ),
  );
}

async function main() {
  let handle: ScrollBoxHandle | null = null;
  const h = setup(
    React.createElement(App, { count: 10000, onReady: (r) => (handle = r) }),
    { columns: 120, rows: 40 },
  );
  await flush();
  // Give the ScrollBox layout one extra tick to settle.
  await new Promise((r) => setTimeout(r, 30));
  if (!handle) throw new Error("ScrollBox handle never resolved");
  const STEPS = 100;
  const t = await time("wheel-100-steps", STEPS, async () => {
    handle!.scrollBy(20);
    await flush();
  });
  printTable([t]);
  process.stdout.write(`bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\n`);
  h.unmount();
}

main().catch((e) => { console.error(e); process.exit(1); });
