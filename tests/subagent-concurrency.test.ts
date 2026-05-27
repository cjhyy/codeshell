import { describe, it, expect, beforeEach } from "bun:test";
import { asyncAgentRegistry, MAX_BACKGROUND_AGENTS } from "../packages/core/src/tool-system/builtin/agent-registry.ts";

describe("background agent concurrency cap", () => {
  beforeEach(() => {
    asyncAgentRegistry.reset();
  });

  it("exposes a positive default cap", () => {
    expect(MAX_BACKGROUND_AGENTS).toBeGreaterThan(0);
  });

  it("runningCount reflects registered running agents", () => {
    expect(asyncAgentRegistry.runningCount()).toBe(0);
    asyncAgentRegistry.register({ agentId: "a1", description: "d", status: "running", startedAt: Date.now(), abort: () => {} });
    asyncAgentRegistry.register({ agentId: "a2", description: "d", status: "running", startedAt: Date.now(), abort: () => {} });
    expect(asyncAgentRegistry.runningCount()).toBe(2);
  });

  it("excludes finished agents from runningCount", () => {
    asyncAgentRegistry.register({ agentId: "a1", description: "d", status: "running", startedAt: Date.now(), abort: () => {} });
    asyncAgentRegistry.markCompleted("a1");
    expect(asyncAgentRegistry.runningCount()).toBe(0);
  });
});
