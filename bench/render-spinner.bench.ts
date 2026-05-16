#!/usr/bin/env bun
import React, { useState, useEffect } from "react";
import { Box, Text } from "../src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

function App({ count }: { count: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let i = 0;
    let cancelled = false;
    const next = () => {
      if (cancelled || i >= 60) return;
      setTick((t) => t + 1);
      i++;
      setImmediate(next);
    };
    next();
    return () => { cancelled = true; };
  }, []);
  const spin = "|/-\\"[tick % 4];
  return React.createElement(Box, { flexDirection: "column" },
    ...Array.from({ length: count }, (_, i) =>
      React.createElement(Text, { key: i }, `row-${i}`),
    ),
    React.createElement(Text, { key: "spinner" }, `working ${spin}`),
  );
}

async function main() {
  const h = setup(React.createElement(App, { count: 5000 }), { columns: 120, rows: 40 });
  await flush();
  await new Promise((r) => setTimeout(r, 300));
  const t = await time("spinner-60-ticks", 1, async () => {});
  printTable([t]);
  process.stdout.write(`bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\n`);
  h.unmount();
}

main().catch((e) => { console.error(e); process.exit(1); });
