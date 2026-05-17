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
