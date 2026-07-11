import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { agentTool, agentSendInputTool } from "./agent.js";
import type { SubAgentSpawner, SubAgentSpawnRequest, ToolContext } from "../context.js";
import { asyncAgentRegistry } from "./agent-registry.js";
import { notificationQueue } from "./agent-notifications.js";

/**
 * A fake spawner that records every request and lets a test script the
 * returned text per call. `existing` is the set of session ids that
 * "exist on disk" so we can exercise the cross-restart disk-probe path.
 */
function makeSpawner(opts?: {
  reply?: (req: SubAgentSpawnRequest) => string;
  existing?: Set<string>;
}): {
  spawner: SubAgentSpawner;
  reqs: SubAgentSpawnRequest[];
} {
  const reqs: SubAgentSpawnRequest[] = [];
  const existing = opts?.existing ?? new Set<string>();
  const spawner: SubAgentSpawner = {
    spawn: async (req) => {
      reqs.push(req);
      // First spawn of an id materializes it; resume sees it as existing.
      existing.add(req.resumeSessionId ?? req.agentId);
      const text = opts?.reply ? opts.reply(req) : "ok";
      // agent_id === childSid: the child session id is the agentId unless
      // we're resuming a specific session.
      return { text, sessionId: req.resumeSessionId ?? req.agentId };
    },
    sessionExists: (sid: string) => existing.has(sid),
    parentStream: () => {},
    describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
  };
  return { spawner, reqs };
}

function makeCtx(spawner: SubAgentSpawner, sessionId = "s-test"): ToolContext {
  return { subAgentSpawner: spawner, sessionId } as unknown as ToolContext;
}

describe("AgentSendInput — subagent continuation via transcript replay", () => {
  beforeEach(() => {
    asyncAgentRegistry.reset();
    notificationQueue.reset();
    // Disable auto-background so sync spawns return inline in tests.
    process.env.CODE_SHELL_AGENT_BG_MS = "0";
  });
  afterEach(() => {
    asyncAgentRegistry.reset();
    notificationQueue.reset();
    delete process.env.CODE_SHELL_AGENT_BG_MS;
  });

  it("spawn returns a sessionId equal to the agent_id (agent_id === childSid)", async () => {
    const { spawner, reqs } = makeSpawner();
    const ctx = makeCtx(spawner);
    await agentTool({ description: "d", prompt: "p" }, ctx);
    // The first (and only) spawn request carries the agentId; the fake
    // returns sessionId === agentId. We assert the request had NO resume id
    // (cold start) and that the agentId was passed through.
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.resumeSessionId).toBeUndefined();
    expect(reqs[0]!.agentId).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it("a completed sync sub-agent leaves a silent registry entry (childSessionId === agentId, no notification)", async () => {
    const { spawner, reqs } = makeSpawner();
    const ctx = makeCtx(spawner);
    await agentTool({ description: "memory test", prompt: "p" }, ctx);
    const agentId = reqs[0]!.agentId;

    // The sync agent must be findable so AgentSendInput can recover its role.
    const entry = asyncAgentRegistry.get(agentId);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("completed");
    expect(entry!.childSessionId).toBe(agentId); // agent_id === childSid
    expect(entry!.description).toBe("memory test");
    // Silent: it must NOT have enqueued a completion notification (no dock/wake).
    expect(notificationQueue.getSnapshot("s-test")).toHaveLength(0);
  });

  it("AgentSendInput resumes the same session id and passes the new prompt", async () => {
    // First: spawn a sub-agent. Capture its agent_id from the result text.
    const { spawner, reqs } = makeSpawner({ reply: (r) => `handled: ${r.prompt}` });
    const ctx = makeCtx(spawner);
    await agentTool({ description: "d", prompt: "remember the number 7" }, ctx);
    const agentId = reqs[0]!.agentId;

    // Now send a follow-up. It must spawn with resumeSessionId === agentId.
    const out = await agentSendInputTool(
      { agent_id: agentId, prompt: "what number did I tell you?" },
      ctx,
    );
    expect(reqs).toHaveLength(2);
    expect(reqs[1]!.resumeSessionId).toBe(agentId);
    expect(reqs[1]!.prompt).toBe("what number did I tell you?");
    expect(out).toContain("handled: what number did I tell you?");
  });

  it("resumes a known agent even after the in-memory registry is wiped (disk probe)", async () => {
    const { spawner, reqs } = makeSpawner();
    const ctx = makeCtx(spawner);
    await agentTool({ description: "d", prompt: "p" }, ctx);
    const agentId = reqs[0]!.agentId;

    // Simulate a process restart: registry is empty but the session exists
    // on disk (the fake spawner's `existing` set retains it).
    asyncAgentRegistry.reset();

    const out = await agentSendInputTool({ agent_id: agentId, prompt: "more" }, ctx);
    expect(out).not.toMatch(/Error/);
    expect(reqs[reqs.length - 1]!.resumeSessionId).toBe(agentId);
  });

  it("returns a clear error for an unknown agent_id (no crash)", async () => {
    const { spawner } = makeSpawner();
    const ctx = makeCtx(spawner);
    const out = await agentSendInputTool({ agent_id: "doesnotexist", prompt: "x" }, ctx);
    expect(out).toMatch(/Error/i);
    expect(out).toMatch(/doesnotexist/);
  });

  it("errors when agent_id is missing", async () => {
    const { spawner } = makeSpawner();
    const ctx = makeCtx(spawner);
    const out = await agentSendInputTool({ prompt: "x" }, ctx);
    expect(out).toMatch(/agent_id is required/i);
  });

  it("errors when prompt is missing", async () => {
    const { spawner, reqs } = makeSpawner();
    const ctx = makeCtx(spawner);
    await agentTool({ description: "d", prompt: "p" }, ctx);
    const agentId = reqs[0]!.agentId;
    const out = await agentSendInputTool({ agent_id: agentId }, ctx);
    expect(out).toMatch(/prompt is required/i);
  });

  it("refuses to run from within a sub-agent (no nesting)", async () => {
    const { spawner } = makeSpawner({ existing: new Set(["whatever"]) });
    const ctx = {
      subAgentSpawner: spawner,
      sessionId: "s-child",
      isSubAgent: true,
    } as unknown as ToolContext;
    const out = await agentSendInputTool({ agent_id: "whatever", prompt: "x" }, ctx);
    expect(out).toMatch(/nested agents are not supported/i);
  });

  it("re-resolves all role capability scopes on resume", async () => {
    // A resumed child Engine is built fresh; its scope comes from the spawn
    // request, not the persisted session. So AgentSendInput must re-resolve the
    // role's allowlists from agentType — otherwise a read-only reviewer would
    // regain write tools on continuation. We register an entry with an
    // agentType and a registry whose role restricts tools, then assert the
    // resume request carries that restriction.
    const { spawner, reqs } = makeSpawner({ existing: new Set(["agent-x"]) });
    // A minimal agentDefinitions registry exposing a restricted "reviewer".
    const agentDefinitions = {
      list: () => [{ name: "reviewer", description: "r", systemPrompt: "" }],
      get: (n: string) =>
        n === "reviewer"
          ? {
              name: "reviewer",
              description: "r",
              systemPrompt: "sp",
              tools: ["Read", "Grep"],
              skills: [],
              sandbox: "bwrap",
              mcp: [],
            }
          : undefined,
    };
    asyncAgentRegistry.register({
      agentId: "agent-x",
      agentType: "reviewer",
      description: "review",
      childSessionId: "agent-x",
      status: "completed",
      startedAt: 0,
      abort: () => {},
    });
    const ctx = {
      subAgentSpawner: spawner,
      sessionId: "s-test",
      agentDefinitions,
    } as unknown as ToolContext;

    await agentSendInputTool({ agent_id: "agent-x", prompt: "revise" }, ctx);
    const last = reqs[reqs.length - 1]!;
    expect(last.resumeSessionId).toBe("agent-x");
    expect(last.toolAllowlist).toEqual(["Read", "Grep"]);
    expect(last.skillAllowlist).toEqual([]);
    expect(last.sandboxMode).toBe("bwrap");
    expect(last.mcpAllowlist).toEqual([]);
  });

  it("refuses to resume an agent that is still running (concurrent-write guard)", async () => {
    // If the agent is still running (e.g. it auto-moved to the background and
    // hasn't finished), resuming would build a SECOND child Engine that resumes
    // the SAME on-disk session and appends to the SAME transcript concurrently —
    // sub-agents have no per-session `active` lock, so the two writers interleave
    // and can corrupt the child transcript. Reject instead of spawning.
    const { spawner, reqs } = makeSpawner({ existing: new Set(["agent-run"]) });
    asyncAgentRegistry.register({
      agentId: "agent-run",
      description: "long task",
      childSessionId: "agent-run",
      status: "running",
      startedAt: 0,
      abort: () => {},
    });
    const ctx = makeCtx(spawner);
    const out = await agentSendInputTool({ agent_id: "agent-run", prompt: "more" }, ctx);
    expect(out).toMatch(/still running/i);
    // Crucially, it must NOT have spawned a concurrent resume.
    expect(reqs).toHaveLength(0);
  });

  it("cascades parent abort to the resumed sub-agent", async () => {
    const { spawner, reqs } = makeSpawner();
    const ctx = makeCtx(spawner);
    await agentTool({ description: "d", prompt: "p" }, ctx);
    const agentId = reqs[0]!.agentId;

    const controller = new AbortController();
    controller.abort();
    const out = await agentSendInputTool(
      { agent_id: agentId, prompt: "x", __signal: controller.signal },
      ctx,
    );
    expect(out).toMatch(/abort/i);
  });
});
