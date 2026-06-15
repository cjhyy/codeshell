/**
 * Regression: Engine.run must keep waiting for background video jobs across
 * MULTIPLE summarize turns. The s-mqe0ox7n-a8d11c26 follow-up bug: when the
 * post-notification summarize turn ITSELF submits another video (e.g. shot #2
 * after shot #1 finishes), the original wait→drain→summarize ran ONCE, so the
 * second job rendered into the void — its notification landed with nobody to
 * drain it and no summarize turn ever read it.
 *
 * This is independent of goal mode: it's purely the engine's background-wait
 * loop. We script an LLM that submits video #1 first, then video #2 on the
 * summarize turn after #1 finishes, then stops. With the single-shot wait the
 * engine resolves before #2's poll completes — only ONE .mp4 lands. With the
 * outer loop it waits for #2 too. We count completion notifications on the
 * agentNotificationBus — single-shot=1, outer-loop=2 (verified by mutation).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../packages/core/src/engine/engine.js";
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
// completion notification in its input — i.e. inside the summarize turn the
// engine runs after #1 finishes. That ordering is what makes #2 "new work
// spawned by a summarize turn", the exact case the outer wait-loop must catch.
// (If #2 were emitted in turn 1's own tool loop, the first drain would already
// see both and the bug wouldn't reproduce.)
class ScriptedClient extends LLMClientBase {
  public callCount = 0;
  public submitted = 0;
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.callCount += 1;
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
    if (this.submitted === 0) {
      this.submitted = 1;
      return emit(1);
    }
    if (sawV1Done && this.submitted === 1) {
      this.submitted = 2;
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

let lastClient: ScriptedClient | null = null;
let savedProviders: Array<[string, new (cfg: any) => LLMClientBase]>;

beforeEach(() => {
  savedProviders = Array.from(PROVIDER_REGISTRY.entries());
  PROVIDER_REGISTRY.clear();
  lastClient = null;
  class Holding extends ScriptedClient {
    constructor(cfg: any) {
      super(cfg);
      lastClient = this;
    }
  }
  registerProvider("openai", Holding);
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

describe("Engine waits for sequential background videos across summarize turns", () => {
  let cwd: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "engine-goalvid-"));
    savedHome = process.env.HOME;
    process.env.HOME = cwd;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("waits for video #2 spawned mid-summarize (2 completions, not 1)", async () => {
    const engine = new Engine({
      llm: { provider: "openai", providerKind: "openai", model: "gpt-5", apiKey: "test", enableStreaming: false },
      cwd,
      sessionStorageDir: join(cwd, ".code-shell", "sessions"),
      enabledBuiltinTools: ["GenerateVideo"],
      maxTurns: 10,
      headless: true,
      permissionMode: "bypassPermissions",
    });

    // Count every video completion the engine enqueues across the whole run.
    // Under the single-shot wait the engine resolves after video #1 and never
    // loops back, so video #2's poll is cut short by afterEach and its
    // completion is never enqueued (1 completion). The outer loop waits for #2
    // too → 2 completions. This is the load-bearing discriminator (verified:
    // single-shot=1, outer-loop=2). The agentNotificationBus fires on every
    // enqueue regardless of draining, so it's race-free.
    let completed = 0;
    const unsub = agentNotificationBus.subscribe((_sid, ev) => {
      if (ev.status === "completed") completed += 1;
    });

    const result = await engine.run("生成 2 个视频");
    unsub();

    // BOTH videos must complete. Single-shot wait → only video #1 completes (#2
    // is orphaned, cut short by afterEach) → completed=1. Outer loop waits for
    // #2 too → completed=2. Verified by mutation: single-shot=1, outer-loop=2.
    expect(completed).toBe(2);
    // Both videos were actually submitted (the scripted client only submits #2
    // after seeing #1's completion, so this confirms the summarize-turn spawn).
    expect(lastClient!.submitted).toBe(2);
    // No background work left when the run resolves.
    expect(backgroundJobRegistry.hasRunningForSession(result.sessionId)).toBe(false);
    expect(notificationQueue.getSnapshot(result.sessionId).length).toBe(0);
  });
});
