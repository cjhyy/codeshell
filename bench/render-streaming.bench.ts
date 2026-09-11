#!/usr/bin/env bun
import React from "react";
import { Box, Text } from "../packages/tui/src/render/index.js";
import { runUpdates } from "./harness.js";

function App({ step }: { step: number }) {
  return React.createElement(
    Box,
    { flexDirection: "column" },
    ...Array.from({ length: 5_000 }, (_, i) => React.createElement(Text, { key: i }, `row-${i}`)),
    React.createElement(Text, { key: "streaming" }, `assistant: ${".".repeat(step)}`),
  );
}

runUpdates("streaming-200-deltas", 200, (step) => React.createElement(App, { step })).catch(
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
