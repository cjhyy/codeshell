import { test, expect } from "bun:test";
import { asyncAgentRegistry } from "../../src/tool-system/builtin/agent-registry.js";

function reset() {
  asyncAgentRegistry.reset();
}

test("appendToTranscript on running agent populates view source", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.appendToTranscript("a1", {
    id: "t1",
    type: "assistant_text",
    text: "hello from background agent",
  } as any);
  const snap = asyncAgentRegistry.getSnapshot();
  const a = snap.find((x) => x.agentId === "a1");
  expect(a?.transcript?.length).toBe(1);
  expect((a?.transcript?.[0] as any)?.text).toContain("hello from background");
});

test("getSnapshot identity changes when transcript appended", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "a1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  const before = asyncAgentRegistry.getSnapshot();
  asyncAgentRegistry.appendToTranscript("a1", { id: "t1", type: "user" } as any);
  const after = asyncAgentRegistry.getSnapshot();
  expect(before).not.toBe(after);
});

test("markCompleted sets finishedFadeAt to finishedAt + 30000", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "f1",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.markCompleted("f1", "result");
  const a = asyncAgentRegistry.getSnapshot().find((x) => x.agentId === "f1");
  expect(a?.finishedAt).toBeDefined();
  expect(a?.finishedFadeAt).toBe((a?.finishedAt ?? 0) + 30_000);
});

test("markFailed sets finishedFadeAt", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "f2",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.markFailed("f2", "boom");
  const a = asyncAgentRegistry.getSnapshot().find((x) => x.agentId === "f2");
  expect(a?.finishedFadeAt).toBe((a?.finishedAt ?? 0) + 30_000);
});

test("cancel sets finishedFadeAt", () => {
  reset();
  asyncAgentRegistry.register({
    agentId: "f3",
    description: "x",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
  });
  asyncAgentRegistry.cancel("f3");
  const a = asyncAgentRegistry.getSnapshot().find((x) => x.agentId === "f3");
  expect(a?.finishedFadeAt).toBe((a?.finishedAt ?? 0) + 30_000);
});
