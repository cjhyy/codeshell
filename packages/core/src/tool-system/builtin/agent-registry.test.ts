import { describe, it, expect, beforeEach } from "bun:test";
import { asyncAgentRegistry, type AsyncAgentEntry } from "./agent-registry.js";

function entry(over: Partial<AsyncAgentEntry>): AsyncAgentEntry {
  return {
    agentId: over.agentId ?? "a1",
    description: "desc",
    status: over.status ?? "running",
    startedAt: 0,
    abort: () => {},
    ...over,
  };
}

describe("asyncAgentRegistry.hasRunningForSession", () => {
  beforeEach(() => asyncAgentRegistry.reset());

  it("is false when no agents exist", () => {
    expect(asyncAgentRegistry.hasRunningForSession("s1")).toBe(false);
  });

  it("is true only for a running agent tagged with that session", () => {
    asyncAgentRegistry.register(entry({ agentId: "a1", sessionId: "s1", status: "running" }));
    expect(asyncAgentRegistry.hasRunningForSession("s1")).toBe(true);
    // Different session → not counted.
    expect(asyncAgentRegistry.hasRunningForSession("s2")).toBe(false);
  });

  it("ignores finished agents (completed / failed / cancelled)", () => {
    asyncAgentRegistry.register(entry({ agentId: "a1", sessionId: "s1", status: "running" }));
    asyncAgentRegistry.markCompleted("a1");
    expect(asyncAgentRegistry.hasRunningForSession("s1")).toBe(false);
  });

  it("isolates concurrent sessions", () => {
    asyncAgentRegistry.register(entry({ agentId: "a1", sessionId: "s1", status: "running" }));
    asyncAgentRegistry.register(entry({ agentId: "a2", sessionId: "s2", status: "running" }));
    asyncAgentRegistry.markCompleted("a1");
    // s1's only agent finished; s2's is still running.
    expect(asyncAgentRegistry.hasRunningForSession("s1")).toBe(false);
    expect(asyncAgentRegistry.hasRunningForSession("s2")).toBe(true);
  });

  it("entries without a sessionId never match a session wait", () => {
    asyncAgentRegistry.register(entry({ agentId: "a1", sessionId: undefined, status: "running" }));
    expect(asyncAgentRegistry.hasRunningForSession("s1")).toBe(false);
    // Global hasRunning still sees it.
    expect(asyncAgentRegistry.hasRunning()).toBe(true);
  });
});

describe("asyncAgentRegistry.listForSession", () => {
  beforeEach(() => asyncAgentRegistry.reset());

  it("returns only entries tagged with that session, regardless of status", () => {
    asyncAgentRegistry.register(entry({ agentId: "a1", sessionId: "s1", status: "running" }));
    asyncAgentRegistry.register(entry({ agentId: "a2", sessionId: "s1", status: "completed" }));
    asyncAgentRegistry.register(entry({ agentId: "a3", sessionId: "s2", status: "running" }));
    const s1 = asyncAgentRegistry.listForSession("s1").map((e) => e.agentId).sort();
    expect(s1).toEqual(["a1", "a2"]);
    expect(asyncAgentRegistry.listForSession("s2").map((e) => e.agentId)).toEqual(["a3"]);
  });

  it("excludes entries with no sessionId", () => {
    asyncAgentRegistry.register(entry({ agentId: "a1", sessionId: undefined, status: "running" }));
    expect(asyncAgentRegistry.listForSession("s1")).toEqual([]);
    // but list() still includes it
    expect(asyncAgentRegistry.list().map((e) => e.agentId)).toEqual(["a1"]);
  });
});
