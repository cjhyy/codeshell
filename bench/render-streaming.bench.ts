#!/usr/bin/env bun
import React, { useState, useEffect } from "react";
import { Box, Text } from "../src/render/index.js";
import { setup, flush, time, printTable } from "./harness.js";

function App({ initial }: { initial: number }) {
  const [delta, setDelta] = useState("");
  useEffect(() => {
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled || i > 200) return;
      setDelta((d) => d + ".");
      i++;
      setImmediate(tick);
    };
    tick();
    return () => { cancelled = true; };
  }, []);
  const history = Array.from({ length: initial }, (_, i) => `row-${i}`);
  return React.createElement(Box, { flexDirection: "column" },
    ...history.map((it) => React.createElement(Text, { key: it }, it)),
    React.createElement(Text, { key: "stream" }, `assistant: ${delta}`),
  );
}

async function main() {
  const h = setup(React.createElement(App, { initial: 5000 }), { columns: 120, rows: 40 });
  await flush();
  // Let the streaming useEffect run to completion.
  await new Promise((r) => setTimeout(r, 600));
  const t = await time("streaming-200-deltas", 1, async () => {});
  printTable([t]);
  process.stdout.write(`bytes_written=${h.bytesWritten}\nframe_count=${h.frameCount}\n`);
  h.unmount();
}

main().catch((e) => { console.error(e); process.exit(1); });
