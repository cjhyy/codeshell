#!/usr/bin/env bun
import React from "react";
import { Box, Text } from "../src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

async function main() {
  const count = 10000;
  const items = Array.from({ length: count }, (_, i) => `row-${i}`);
  const h = setup(
    React.createElement(Box, { flexDirection: "column" },
      ...items.map((it) => React.createElement(Text, { key: it }, it)),
    ),
    { columns: 120, rows: 40 },
  );
  await flush();
  const mountTiming = await time("mount 10k", 1, async () => {});
  printTable([mountTiming]);
  process.stdout.write(`bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\n`);
  h.unmount();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
