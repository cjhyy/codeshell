/**
 * Sequential background videos must BOTH complete — now via the unified
 * notification-wakeup path, not the old engine for(;;) park (2026-06-17
 * unified-background-work redesign).
 *
 * The s-mqe0ox7n-a8d11c26 follow-up bug: a summarize turn that ITSELF submits
 * another video (shot #2 after shot #1 finishes) must still be waited on.
 * Previously the engine parked on the backgroundJobRegistry across summarize
 * turns. Now video does NOT park the engine at all: each run ends, yields, and
 * the completion notification wakes the IDLE session for the next turn. The
 * sequential case is driven by the server's run-boundary re-check (trigger B in
 * maybeWakeIdleSession): video #1 completes → wakes a turn → that turn submits
 * #2 → its completion wakes another turn.
 *
 * We drive a real (non-headless) Engine through AgentServer (which owns the
 * wakeup path) and script an LLM that submits #1, then #2 only after seeing #1's
 * completion, then stops. We count completion notifications on the
 * agentNotificationBus — both videos must complete (2), proving the chained
 * wakeup replaces the old outer loop.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../packages/core/src/engine/engine.js";
import { AgentServer } from "../packages/core/src/protocol/server.js";
import { ChatSessionManager } from "../packages/core/src/protocol/chat-session-manager.js";
import {
  registerProvider,
  PROVIDER_REGISTRY,
} from "../packages/core/src/llm/client-factory.js";
import { LLMClientBase } from "../packages/core/src/llm/client-base.js";
import type { LLMResponse } from "../packages/core/src/types.js";
import type { CreateMessageOptions } from "../packages/core/src/llm/types.js";
import { __setVideoProviderForTests } from "../packages/core/src/tool-system/builtin/generate-video.js";
import { FakeVideoProvider } from "../packages/core/src/tool-system/builtin/video-providers.js";
import { notificationQueue, agentNotificationBus } from "../packages/core/src/tool-system/builtin/agent-notifications.js";
import { backgroundJobRegistry } from "../packages/core/src/tool-system/builtin/background-jobs.js";

// Submits video #1 first. Then submits video #2 ONLY after it sees video #1's
// completion notification in its input — i.e. inside the turn the WAKEUP runs
// after #1 finishes. That ordering makes #2 "new work spawned by a woken turn",
// the exact case the chained run-boundary re-check must catch.
// Shared script state across ALL client instances in a test. The engine
// resolves a FRESH llmClient per engine.run() call, so per-instance counters
// would reset on every woken turn (each woken turn = a new run = a new client).
// Module-level state keeps the "submit #1, then #2 after #1 done, then stop"
// script coherent across the whole wakeup chain.
const script = { callCount: 0, submitted: 0 };

class ScriptedClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    script.callCount += 1;
    const txt = JSON.stringify(options.messages ?? []);
    const sawV1Done = txt.includes("shot 1") && txt.includes("Video saved");
    const emit = (n: number): LLMResponse =>
      ({
        text: `submitting video ${n}`,
        toolCalls: [
          { id: `call-${n}`, toolName: "GenerateVideo", args: { prompt: `shot ${n}`, pollIntervalMs: 30 } },
        ],
        stopReason: "tool_use",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }) as unknown as LLMResponse;
    if (script.submitted === 0) {
      script.submitted = 1;
      return emit(1);
    }
    if (sawV1Done && script.submitted === 1) {
      script.submitted = 2;
      return emit(2);
    }
    return {
      text: "all videos done",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } as unknown as LLMResponse;
  }
}

let savedProviders: Array<[string, new (cfg: any) => LLMClientBase]>;

beforeEach(() => {
  savedProviders = Array.from(PROVIDER_REGISTRY.entries());
  PROVIDER_REGISTRY.clear();
  script.callCount = 0;
  script.submitted = 0;
  registerProvider("openai", ScriptedClient);
  notificationQueue.reset();
  backgroundJobRegistry.reset();
  __setVideoProviderForTests(new FakeVideoProvider({ succeedAfterPolls: 1, bytes: "MP4" }));
});

afterEach(() => {
  PROVIDER_REGISTRY.clear();
  for (const [k, v] of savedProviders) PROVIDER_REGISTRY.set(k, v);
  notificationQueue.reset();
  backgroundJobRegistry.reset();
  __setVideoProviderForTests(null);
});

function makeTransport() {
  let onMsg: (msg: unknown) => void = () => {};
  return {
    transport: {
      send: () => {},
      onMessage: (cb: (msg: unknown) => void) => { onMsg = cb; },
      close: () => {},
    } as any,
    deliver: (msg: unknown) => onMsg(msg),
  };
}

describe("Sequential background videos complete via notification-wakeup", () => {
  let cwd: string;
  let savedHome: string | undefined;
  const servers: AgentServer[] = [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "engine-goalvid-"));
    savedHome = process.env.HOME;
    process.env.HOME = cwd;
  });
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("waits for video #2 spawned by the woken turn (2 completions, not 1)", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () =>
        new Engine({
          llm: { provider: "openai", providerKind: "openai", model: "gpt-5", apiKey: "test", enableStreaming: false },
          cwd,
          sessionStorageDir: join(cwd, ".code-shell", "sessions"),
          enabledBuiltinTools: ["GenerateVideo"],
          maxTurns: 10,
          // INTERACTIVE (not headless): the server's wakeup path drives the
          // sequential videos. Headless would only wait on sub-agents.
          permissionMode: "bypassPermissions",
        }),
    });
    const t = makeTransport();
    servers.push(new AgentServer({ transport: t.transport, chatManager }));

    // Count every distinct video completion enqueued across the run + wakeups.
    const completedJobs = new Set<string>();
    const unsub = agentNotificationBus.subscribe((_sid, ev) => {
      if (ev.status === "completed") completedJobs.add(ev.agentId);
    });

    t.deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/run",
      params: { sessionId: "vid-1", task: "生成 2 个视频" },
    });

    // Wait for the chain to settle: run resolves → trigger B re-check → #1
    // completion wakes a turn → submits #2 → its completion wakes another turn
    // → the "all videos done" turn → no more work. Settled = both videos done,
    // no running job, queue drained, and script stopped submitting.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const settled =
        script.submitted === 2 &&
        completedJobs.size >= 2 &&
        !backgroundJobRegistry.hasRunningForSession("vid-1") &&
        notificationQueue.getSnapshot("vid-1").length === 0;
      if (settled) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // Let any final wakeup turn drain.
    await new Promise((r) => setTimeout(r, 100));
    unsub();

    // BOTH videos completed via the wakeup chain (exactly 2 distinct jobs).
    expect(completedJobs.size).toBe(2);
    // #2 was submitted only after #1's completion → confirms the woken-turn spawn.
    expect(script.submitted).toBe(2);
    // No background work left, queue drained.
    expect(backgroundJobRegistry.hasRunningForSession("vid-1")).toBe(false);
    expect(notificationQueue.getSnapshot("vid-1").length).toBe(0);
  });
});
