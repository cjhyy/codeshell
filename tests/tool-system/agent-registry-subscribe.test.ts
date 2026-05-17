import { test, expect, mock } from "bun:test";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

function resetRegistry() {
  asyncAgentRegistry.reset();
}

test("subscribe receives notify on register", () => {
  resetRegistry();
  const cb = mock(() => {});
  const unsub = asyncAgentRegistry.subscribe(cb);
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "test agent",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  expect(cb).toHaveBeenCalledTimes(1);
  unsub();
});

test("getSnapshot returns a stable reference between mutations", () => {
  resetRegistry();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const snap1 = asyncAgentRegistry.getSnapshot();
  const snap2 = asyncAgentRegistry.getSnapshot();
  expect(snap1).toBe(snap2); // identity, not value
});

test("getSnapshot returns a NEW reference after notify", () => {
  resetRegistry();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const snap1 = asyncAgentRegistry.getSnapshot();
  asyncAgentRegistry.markCompleted("a1", "done");
  const snap2 = asyncAgentRegistry.getSnapshot();
  expect(snap1).not.toBe(snap2);
});

test("hasRunning reflects active agents", () => {
  resetRegistry();
  expect(asyncAgentRegistry.hasRunning()).toBe(false);
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  expect(asyncAgentRegistry.hasRunning()).toBe(true);
  asyncAgentRegistry.markCompleted("a1", "done");
  expect(asyncAgentRegistry.hasRunning()).toBe(false);
});

test("unsubscribe stops future notifications", () => {
  resetRegistry();
  const cb = mock(() => {});
  const unsub = asyncAgentRegistry.subscribe(cb);
  unsub();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  expect(cb).not.toHaveBeenCalled();
});

test("appendToTranscript stores entries on the agent and notifies", () => {
  asyncAgentRegistry.reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const cb = mock(() => {});
  asyncAgentRegistry.subscribe(cb);
  asyncAgentRegistry.appendToTranscript("a1", {
    id: "t1",
    type: "assistant_text",
    text: "agent thinking",
    streaming: false,
  } as any);
  const e = asyncAgentRegistry.get("a1");
  expect(e?.transcript?.length).toBe(1);
  expect(cb).toHaveBeenCalledTimes(1);
});

test("appendToTranscript on unknown agent is a no-op", () => {
  asyncAgentRegistry.reset();
  expect(() =>
    asyncAgentRegistry.appendToTranscript("ghost", { id: "x" } as any),
  ).not.toThrow();
});
