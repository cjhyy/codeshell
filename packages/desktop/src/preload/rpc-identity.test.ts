import { expect, test } from "bun:test";
import { WebConfigurationGate } from "../main/web-configuration-gate.js";
import { createPreloadRpcIdFactory, takePreloadRpcResponse } from "./rpc-identity.js";

test("two windows and a reloaded preload never reuse their first request identity", () => {
  const firstWindow = createPreloadRpcIdFactory();
  const secondWindow = createPreloadRpcIdFactory();
  const reloadedWindow = createPreloadRpcIdFactory();
  const ids = [firstWindow(), firstWindow(), secondWindow(), reloadedWindow()];
  expect(new Set(ids).size).toBe(4);
  for (const id of ids) expect(id).toMatch(/^desktop-rpc-[a-f0-9-]{36}-[1-9][0-9]*$/);
});

test("a broadcast reply resolves only its own window without coercing numeric or unrelated ids", () => {
  const firstId = createPreloadRpcIdFactory()();
  const secondId = createPreloadRpcIdFactory()();
  const first = new Map([[firstId, { value: "first pending run" }]]);
  const second = new Map([[secondId, { value: "second pending query" }]]);
  expect(takePreloadRpcResponse(first, secondId)).toBeUndefined();
  expect(takePreloadRpcResponse(second, secondId)).toEqual({ value: "second pending query" });
  expect(takePreloadRpcResponse(first, 1)).toBeUndefined();
  expect(takePreloadRpcResponse(first, "1")).toBeUndefined();
  expect(takePreloadRpcResponse(first, null)).toBeUndefined();
  expect(first.size).toBe(1);
  expect(second.size).toBe(0);
  expect(takePreloadRpcResponse(first, firstId)).toEqual({ value: "first pending run" });
  expect(first.size).toBe(0);
});

test("another window's first query or completed run cannot release a still-running session's configuration gate", async () => {
  const gate = new WebConfigurationGate();
  const firstId = createPreloadRpcIdFactory()();
  const secondWindow = createPreloadRpcIdFactory();
  const queryId = secondWindow();
  const otherRunId = secondWindow();
  gate.beginRun(firstId, "window-one-session");
  gate.beginRun(otherRunId, "window-two-session");
  gate.observe(JSON.stringify({ id: queryId, result: { models: [] } }));
  gate.observe(JSON.stringify({ id: otherRunId, result: { reason: "completed" } }));
  expect(gate.isRunning("window-one-session")).toBe(true);
  expect(gate.isRunning("window-two-session")).toBe(false);
  let writes = 0;
  await expect(
    gate.mutate(
      async () => ++writes,
      async () => {},
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(writes).toBe(0);
  gate.observe(
    JSON.stringify({
      id: firstId,
      error: { code: -32000, message: "cancelled before acceptance" },
    }),
  );
  await expect(
    gate.mutate(
      async () => ++writes,
      async () => {},
    ),
  ).resolves.toBe(1);
});
