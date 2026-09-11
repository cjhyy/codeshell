#!/usr/bin/env bun
import React from "react";
import { Box, Text } from "../packages/tui/src/render/index.js";
import { runUpdates } from "./harness.js";

function App({ step }: { step: number }) {
  return React.createElement(
    Box,
    { flexDirection: "column" },
    ...Array.from({ length: 5_000 }, (_, i) => React.createElement(Text, { key: i }, `row-${i}`)),
    React.createElement(Text, { key: "spinner" }, `working ${"|/-\\"[step % 4]}`),
  );
}

runUpdates("spinner-60-ticks", 60, (step) => React.createElement(App, { step })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
