import { afterEach, expect, test } from "bun:test";
import React, { useState } from "react";
import { Text } from "../../render/index.js";
import { flush, mount } from "../../../../../tests/render-fixtures.js";
import { useRunStart } from "./useRunStart.js";

const realNow = Date.now;
let now = 1_000;

afterEach(() => {
  Date.now = realNow;
});

async function rendered() {
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await flush();
}

function fixture() {
  Date.now = () => now;
  let setQuery: (active: boolean) => void;
  let setBackground: (running: boolean) => void;
  let startRef: React.MutableRefObject<number>;
  function Harness() {
    const [queryActive, setQueryActive] = useState(false);
    const [backgroundRunning, setBackgroundRunning] = useState(false);
    setQuery = setQueryActive;
    setBackground = setBackgroundRunning;
    startRef = useRunStart(queryActive, backgroundRunning);
    return <Text>ready</Text>;
  }
  const harness = mount(<Harness />);
  return {
    harness,
    query: async (active: boolean, at: number) => {
      now = at;
      setQuery(active);
      await rendered();
    },
    background: async (running: boolean, at: number) => {
      now = at;
      setBackground(running);
      await rendered();
    },
    start: () => startRef.current,
  };
}

test("a background agent finishing does not restart the running foreground timer", async () => {
  const run = fixture();
  try {
    await rendered();
    await run.background(true, 1_000);
    expect(run.start()).toBe(1_000);
    await run.query(true, 2_000);
    expect(run.start()).toBe(2_000);
    await run.background(false, 5_000);
    expect(run.start()).toBe(2_000);
    await run.background(true, 6_000);
    expect(run.start()).toBe(2_000);
  } finally {
    run.harness.unmount();
  }
});

test("a new foreground query restarts the timer even while background work runs", async () => {
  const run = fixture();
  try {
    await rendered();
    await run.background(true, 1_000);
    await run.query(true, 2_000);
    await run.query(false, 3_000);
    await run.query(true, 4_000);
    expect(run.start()).toBe(4_000);
  } finally {
    run.harness.unmount();
  }
});
