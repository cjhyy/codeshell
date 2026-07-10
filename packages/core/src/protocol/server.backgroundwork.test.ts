import { describe, it, expect, beforeEach } from "bun:test";
import { AgentServer } from "./server.js";
import type { Engine } from "../engine/engine.js";
import { asyncAgentRegistry } from "../tool-system/builtin/agent-registry.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";

/**
 * agent/backgroundWork is the desktop background panel's single query: a
 * list-only, per-kind view across all three background-work registries
 * (shells + sub-agents + jobs). Per-shell output/kill still go through
 * agent/backgroundShells; this just answers "what's running right now" so the
 * panel can show newly-spawned work without the user toggling it.
 */

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (msg: unknown) => void) => {
        onMsg = cb;
      },
      close: () => {},
    } as any,
  };
}

function makeEngine() {
  return { isHeadless: () => true } as unknown as Engine;
}

function lastResult(sent: any[]): any {
  return sent[sent.length - 1]?.result;
}

describe("AgentServer agent/backgroundWork", () => {
  beforeEach(() => {
    asyncAgentRegistry.reset();
    backgroundJobRegistry.reset();
  });

  it("aggregates running sub-agents and jobs for the session, tagged by kind", () => {
    asyncAgentRegistry.register({
      agentId: "a-1",
      name: "Explore",
      agentType: "general-purpose",
      description: "search the codebase",
      sessionId: "s-1",
      status: "running",
      startedAt: Date.now(),
      abort: () => {},
    });
    backgroundJobRegistry.start("job-1", "s-1", "生成视频中: a cat");

    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine: makeEngine() });
    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/backgroundWork",
      params: { sessionId: "s-1" },
    });

    const items = lastResult(t.sent)?.items;
    expect(Array.isArray(items)).toBe(true);
    const agent = items.find((i: any) => i.kind === "subagent");
    expect(agent).toMatchObject({
      kind: "subagent",
      agentId: "a-1",
      description: "search the codebase",
      status: "running",
    });
    const job = items.find((i: any) => i.kind === "job");
    expect(job).toMatchObject({ kind: "job", jobId: "job-1", description: "生成视频中: a cat" });
  });

  it("scopes to the requested session (does not leak another session's work)", () => {
    backgroundJobRegistry.start("job-mine", "s-1", "mine");
    backgroundJobRegistry.start("job-theirs", "s-2", "theirs");

    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine: makeEngine() });
    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/backgroundWork",
      params: { sessionId: "s-1" },
    });

    const items = lastResult(t.sent)?.items ?? [];
    const jobIds = items.filter((i: any) => i.kind === "job").map((i: any) => i.jobId);
    expect(jobIds).toContain("job-mine");
    expect(jobIds).not.toContain("job-theirs");
  });

  it("can list all sessions with source-session metadata for the UI", () => {
    backgroundJobRegistry.start("job-mine", "s-1", "mine");
    backgroundJobRegistry.start("job-theirs", "s-2", "theirs");

    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine: makeEngine() });
    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/backgroundWork",
      params: { sessionId: "s-1", scope: "all" },
    });

    const items = lastResult(t.sent)?.items ?? [];
    const mine = items.find((i: any) => i.kind === "job" && i.jobId === "job-mine");
    const theirs = items.find((i: any) => i.kind === "job" && i.jobId === "job-theirs");
    expect(mine?.sourceSession).toMatchObject({
      sessionId: "s-1",
      shortId: "s-1",
      current: true,
    });
    expect(theirs?.sourceSession).toMatchObject({
      sessionId: "s-2",
      shortId: "s-2",
      current: false,
    });
  });

  it("surfaces DriveAgent linkage fields without exposing unknown CLI values", () => {
    backgroundJobRegistry.start("drive-1", "s-1", "delegate task", {
      kind: "drive-agent",
      cwd: "/tmp/project",
      cli: "codex",
    });
    backgroundJobRegistry.finish("drive-1", { ccSessionId: "thread-123" });
    backgroundJobRegistry.start("drive-bad", "s-1", "legacy task", {
      kind: "drive-agent",
      cwd: "/tmp/project",
      cli: "unknown-cli" as "codex",
    });

    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine: makeEngine() });
    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/backgroundWork",
      params: { sessionId: "s-1" },
    });

    const items = lastResult(t.sent)?.items ?? [];
    expect(items.find((i: any) => i.jobId === "drive-1")).toMatchObject({
      jobKind: "drive-agent",
      externalSessionId: "thread-123",
      cli: "codex",
      cwd: "/tmp/project",
    });
    expect(items.find((i: any) => i.jobId === "drive-bad")?.cli).toBeUndefined();
  });

  it("keeps a just-finished sub-agent briefly (inside its fade window)", () => {
    asyncAgentRegistry.register({
      agentId: "a-done",
      description: "finished task",
      sessionId: "s-1",
      status: "running",
      startedAt: Date.now(),
      abort: () => {},
    });
    asyncAgentRegistry.markCompleted("a-done"); // sets finishedFadeAt = now + 30s

    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine: makeEngine() });
    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/backgroundWork",
      params: { sessionId: "s-1" },
    });

    const items = lastResult(t.sent)?.items ?? [];
    const done = items.find((i: any) => i.kind === "subagent" && i.agentId === "a-done");
    expect(done).toBeDefined();
    expect(done.status).toBe("completed");
  });

  it("errors when sessionId is missing", () => {
    const t = makeTransport();
    new AgentServer({ transport: t.transport, engine: makeEngine() });
    t.deliver({ jsonrpc: "2.0", id: 1, method: "agent/backgroundWork", params: {} });

    expect(t.sent[t.sent.length - 1]?.error).toBeDefined();
    expect(lastResult(t.sent)).toBeUndefined();
  });
});
