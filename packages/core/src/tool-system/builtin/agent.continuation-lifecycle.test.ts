import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type {
  SubAgentSpawner,
  SubAgentSpawnRequest,
  SubAgentSpawnResult,
  ToolContext,
} from "../context.js";
import { agentCancelTool, agentSendInputTool, agentTool } from "./agent.js";
import {
  asyncAgentRegistry,
  type AsyncAgentEntry,
  type ChildWriterLease,
  type LiveChildControl,
} from "./agent-registry.js";
import { agentHeartbeatPinger } from "./agent-heartbeat.js";
import { notificationQueue } from "./agent-notifications.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface RuntimeAttempt {
  request: SubAgentSpawnRequest;
  completion: ReturnType<typeof deferred<SubAgentSpawnResult>>;
  control: LiveChildControl;
  lease: ChildWriterLease;
  statusBeforeBind: AsyncAgentEntry["status"] | undefined;
}

/** Exercise the native spawner contract without constructing an Engine or making
 * model/network requests: bind one live control, retain it until the deferred
 * run settles, and close intake before publishing the terminal result. */
function fixture() {
  const attempts: RuntimeAttempt[] = [];
  const events: string[] = [];
  const spawner: SubAgentSpawner = {
    spawn: async (request) => {
      const childSessionId = request.resumeSessionId ?? request.agentId;
      const completion = deferred<SubAgentSpawnResult>();
      const control: LiveChildControl = {
        childSessionId,
        runtimeGeneration: request.runtimeGeneration!,
        getState: () => "model",
        routeDirection: (draft) => {
          const envelope = notificationQueue.enqueue(draft)!;
          return {
            status: "queued",
            envelopeId: envelope.id,
            sequence: envelope.sequence,
            target: envelope.to,
            acceptedAt: envelope.createdAt,
          };
        },
      };
      const statusBeforeBind = asyncAgentRegistry.get(request.agentId)?.status;
      const lease = request.bindLiveControl?.(control, `owner-${attempts.length + 1}`);
      if (!lease || lease === true) throw new Error("Expected a native child writer lease");
      attempts.push({ request, completion, control, lease, statusBeforeBind });
      if (!request.resumeSessionId) {
        completion.resolve({ text: "initial report", sessionId: childSessionId });
      }
      try {
        return await completion.promise;
      } finally {
        request.closeLiveControl?.(control, lease);
      }
    },
    sessionExists: (id) => attempts.some((attempt) => attempt.request.agentId === id),
    getSessionParentId: () => "parent",
    getSessionContinuation: (id) =>
      attempts.find((attempt) => attempt.request.agentId === id)?.request.continuation,
    parentStream: (event) => events.push(event.type),
    describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
  };
  const ctx = { subAgentSpawner: spawner, sessionId: "parent" } as ToolContext;
  return { attempts, ctx, events };
}

async function launch(f: ReturnType<typeof fixture>) {
  const output = await agentTool({ description: "inspect", prompt: "initial task" }, f.ctx);
  const agentId = output.match(/^agent_id: ([A-Za-z0-9_-]+)/m)?.[1];
  expect(agentId).toBeDefined();
  return agentId!;
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for child lifecycle");
    await Bun.sleep(1);
  }
}

beforeEach(() => {
  asyncAgentRegistry.reset();
  notificationQueue.reset();
  process.env.CODE_SHELL_AGENT_BG_MS = "0";
});

afterEach(() => {
  asyncAgentRegistry.reset();
  notificationQueue.reset();
  agentHeartbeatPinger.stop();
  delete process.env.CODE_SHELL_AGENT_BG_MS;
});

describe("sub-agent continuation lifecycle", () => {
  it("keeps an initial synchronous launch silent after its native runtime completes", async () => {
    const f = fixture();
    const agentId = await launch(f);

    expect(f.attempts[0].statusBeforeBind).toBeUndefined();
    expect(asyncAgentRegistry.get(agentId)?.status).toBe("completed");
    expect(asyncAgentRegistry.getWriterLease(agentId)).toBeUndefined();
    expect(notificationQueue.getSnapshot("parent")).toHaveLength(0);
  });

  it("registers a resumed runtime before binding, routes later input, and releases its completed lease", async () => {
    const f = fixture();
    const agentId = await launch(f);
    const originalGeneration = asyncAgentRegistry.get(agentId)!.runtimeGeneration!;

    const followUp = agentSendInputTool({ agent_id: agentId, prompt: "review the fix" }, f.ctx);
    await until(() => f.attempts.length === 2);
    const resumed = f.attempts[1];
    expect(resumed.statusBeforeBind).toBe("running");
    expect(resumed.request.resumeSessionId).toBe(agentId);
    expect(resumed.request.runtimeGeneration).toBeGreaterThan(originalGeneration);
    expect(asyncAgentRegistry.get(agentId)).toMatchObject({
      status: "running",
      runtimeGeneration: resumed.request.runtimeGeneration,
      liveControl: resumed.control,
      writerLease: resumed.lease,
    });
    expect(asyncAgentRegistry.getWriterLease(agentId)).toEqual(resumed.lease);

    const routed = await agentSendInputTool(
      { agent_id: agentId, prompt: "also check cancellation" },
      f.ctx,
    );
    expect(JSON.parse(routed)).toMatchObject({ status: "queued" });
    expect(f.attempts).toHaveLength(2);
    expect(notificationQueue.getSnapshot(agentId)[0]).toMatchObject({
      kind: "direction",
      runtimeGeneration: resumed.request.runtimeGeneration,
      payload: { prompt: "also check cancellation" },
    });

    resumed.completion.resolve({ text: "fix reviewed", sessionId: agentId });
    expect((await followUp).endsWith("\n\nfix reviewed")).toBe(true);
    expect(asyncAgentRegistry.get(agentId)).toMatchObject({
      status: "completed",
      runtimeGeneration: resumed.request.runtimeGeneration,
    });
    expect(asyncAgentRegistry.getWriterLease(agentId)).toBeUndefined();
    expect(asyncAgentRegistry.get(agentId)?.liveControl).toBeUndefined();
    expect(notificationQueue.getSnapshot(agentId)).toHaveLength(0);
    expect(notificationQueue.getSnapshot("parent")).toHaveLength(0);
  });

  it("marks a failed continuation terminal and releases its writer lease", async () => {
    const f = fixture();
    const agentId = await launch(f);
    const followUp = agentSendInputTool({ agent_id: agentId, prompt: "continue" }, f.ctx);
    await until(() => f.attempts.length === 2);

    f.attempts[1].completion.reject(new Error("continuation failed"));
    expect(await followUp).toContain("Agent error: continuation failed");
    expect(asyncAgentRegistry.get(agentId)?.status).toBe("failed");
    expect(asyncAgentRegistry.getWriterLease(agentId)).toBeUndefined();
    expect(asyncAgentRegistry.get(agentId)?.liveControl).toBeUndefined();
  });

  it("cancels the resumed controller and fences the transcript until its runtime exits", async () => {
    const f = fixture();
    const agentId = await launch(f);
    const followUp = agentSendInputTool({ agent_id: agentId, prompt: "continue" }, f.ctx);
    await until(() => f.attempts.length === 2);
    const resumed = f.attempts[1];

    expect(await agentCancelTool({ agent_id: agentId })).toContain("cancelled");
    expect(resumed.request.signal.aborted).toBe(true);
    expect(asyncAgentRegistry.get(agentId)?.status).toBe("cancelling");
    expect(asyncAgentRegistry.getWriterLease(agentId)).toEqual(resumed.lease);
    expect(
      await agentSendInputTool({ agent_id: agentId, prompt: "race the cancelled runtime" }, f.ctx),
    ).toContain("still cancelling");
    expect(f.attempts).toHaveLength(2);

    resumed.completion.reject(new Error("runtime aborted"));
    expect(await followUp).toBe("Agent was aborted.");
    expect(asyncAgentRegistry.get(agentId)?.status).toBe("cancelled");
    expect(asyncAgentRegistry.getWriterLease(agentId)).toBeUndefined();
    expect(asyncAgentRegistry.get(agentId)?.liveControl).toBeUndefined();
  });

  it("hands a long continuation to the background with the same runtime and generation", async () => {
    const f = fixture();
    const agentId = await launch(f);
    process.env.CODE_SHELL_AGENT_BG_MS = "10";

    const followUp = agentSendInputTool({ agent_id: agentId, prompt: "long review" }, f.ctx);
    await until(() => f.attempts.length === 2);
    const resumed = f.attempts[1];
    const generation = resumed.request.runtimeGeneration;
    expect(await followUp).toContain("moved it to the background");
    expect(f.attempts).toHaveLength(2);
    expect(asyncAgentRegistry.get(agentId)).toMatchObject({
      status: "running",
      runtimeGeneration: generation,
      liveControl: resumed.control,
      writerLease: resumed.lease,
    });
    expect(asyncAgentRegistry.getWriterLease(agentId)).toEqual(resumed.lease);

    resumed.completion.resolve({ text: "long review completed", sessionId: agentId });
    await until(() => asyncAgentRegistry.get(agentId)?.status === "completed");
    expect(f.attempts).toHaveLength(2);
    expect(asyncAgentRegistry.get(agentId)?.runtimeGeneration).toBe(generation);
    expect(asyncAgentRegistry.getWriterLease(agentId)).toBeUndefined();
    expect(notificationQueue.getSnapshot("parent")).toEqual([
      expect.objectContaining({
        kind: "result",
        payload: expect.objectContaining({
          workId: agentId,
          status: "completed",
          finalText: "long review completed",
        }),
      }),
    ]);
  });

  it("keeps cancellation fenced when the auto-background threshold expires before exit", async () => {
    const f = fixture();
    const agentId = await launch(f);
    process.env.CODE_SHELL_AGENT_BG_MS = "10";

    const followUp = agentSendInputTool({ agent_id: agentId, prompt: "long review" }, f.ctx);
    let settled = false;
    void followUp.then(() => {
      settled = true;
    });
    await until(() => f.attempts.length === 2);
    const resumed = f.attempts[1];
    expect(await agentCancelTool({ agent_id: agentId })).toContain("cancelled");

    await Bun.sleep(30);
    expect(settled).toBe(false);
    expect(resumed.request.signal.aborted).toBe(true);
    expect(asyncAgentRegistry.get(agentId)).toMatchObject({
      status: "cancelling",
      runtimeGeneration: resumed.request.runtimeGeneration,
      writerLease: resumed.lease,
    });
    expect(asyncAgentRegistry.getWriterLease(agentId)).toEqual(resumed.lease);
    expect(f.events).not.toContain("agent_backgrounded");
    expect(
      await agentSendInputTool({ agent_id: agentId, prompt: "race the cancelled runtime" }, f.ctx),
    ).toContain("still cancelling");
    expect(notificationQueue.getSnapshot(agentId)).toHaveLength(0);
    expect(f.attempts).toHaveLength(2);

    resumed.completion.reject(new Error("runtime aborted after threshold"));
    expect(await followUp).toBe("Agent was aborted.");
    expect(asyncAgentRegistry.get(agentId)?.status).toBe("cancelled");
    expect(asyncAgentRegistry.getWriterLease(agentId)).toBeUndefined();
    expect(asyncAgentRegistry.get(agentId)?.liveControl).toBeUndefined();
  });
});
