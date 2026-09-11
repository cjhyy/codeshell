#!/usr/bin/env bun
import React from "react";
import { Box, Text } from "../packages/tui/src/render/index.js";
import { setup, time, printTable, type BenchHarness } from "./harness.js";

async function main() {
  let h: BenchHarness | undefined;
  try {
    const mountTiming = await time("mount-10k", 1, async () => {
      const items = Array.from({ length: 10_000 }, (_, i) => `row-${i}`);
      h = setup(
        React.createElement(
          Box,
          { flexDirection: "column" },
          ...items.map((it) => React.createElement(Text, { key: it }, it)),
        ),
      );
      await h.waitForFrame(1);
    });
    printTable([mountTiming]);
    process.stdout.write(
      `bytes_written=${h!.bytesWritten}\nframe_count=${h!.frameCount}\nwrite_count=${h!.writeCount}\n`,
    );
  } finally {
    h?.unmount();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
