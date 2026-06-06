/**
 * 4.1 — a synchronous Agent(...) that runs past the auto-background threshold
 * is DETACHED into the background (not killed), so the main turn isn't blocked
 * for up to 30min. The agent keeps running on the same signal; when it
 * finishes, its result arrives via the notification queue (like an explicit
 * run_in_background agent). User-confirmed semantics: "转后台 + 立即回结果提示,
 * 下轮接".
 *
 * Threshold is overridden to a few ms via CODE_SHELL_AGENT_BG_MS so the test
 * doesn't wait the real 120s.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { agentTool } from "./agent.js";
import type { SubAgentSpawner, ToolContext } from "../context.js";
import { asyncAgentRegistry } from "./agent-registry.js";
import { notificationQueue } from "./agent-notifications.js";

function makeCtx(spawn: SubAgentSpawner["spawn"], sessionId = "s-test"): ToolContext {
  const spawner: SubAgentSpawner = {
    spawn,
    parentStream: () => {},
    describe: () => ({ cwd: "/tmp", permissionMode: "acceptEdits" }),
  };
  return { subAgentSpawner: spawner, sessionId } as unknown as ToolContext;
}

beforeEach(() => {
  asyncAgentRegistry.reset();
  notificationQueue.reset();
  process.env.CODE_SHELL_AGENT_BG_MS = "30"; // tiny threshold for the test
});
afterEach(() => {
  asyncAgentRegistry.reset();
  notificationQueue.reset();
  delete process.env.CODE_SHELL_AGENT_BG_MS;
});

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("synchronous Agent auto-backgrounds past the threshold", () => {
  it("a slow sync agent returns a 'moved to background' handle, not a blocked wait", async () => {
    // Spawn takes 200ms > 30ms threshold → should auto-background.
    const ctx = makeCtx(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "slow result";
    });

    const started = Date.now();
    const out = (await agentTool({ description: "long task", prompt: "p" }, ctx)) as string;
    const elapsed = Date.now() - started;

    // Returned quickly (around the threshold), NOT after the full 200ms.
    expect(elapsed).toBeLessThan(150);
    expect(out).toMatch(/background/i);
    expect(out).toMatch(/agent_id|notified/i);

    // The agent is now tracked as a running background agent.
    expect(asyncAgentRegistry.hasRunningForSession("s-test")).toBe(true);

    // When it finishes, the result lands in the notification queue.
    await until(() => notificationQueue.getSnapshot("s-test").length > 0);
    const notif = notificationQueue.getSnapshot("s-test")[0];
    expect(notif.status).toBe("completed");
    expect(notif.finalText).toBe("slow result");
  });

  it("a fast sync agent (under threshold) returns its text inline as before", async () => {
    const ctx = makeCtx(async () => "quick result");
    const out = await agentTool({ description: "d", prompt: "p" }, ctx);
    expect(out).toBe("quick result");
    // No background agent left running; no notification needed.
    expect(asyncAgentRegistry.hasRunningForSession("s-test")).toBe(false);
    expect(notificationQueue.getSnapshot("s-test")).toHaveLength(0);
  });

  it("an auto-backgrounded agent that later fails enqueues a failed notification", async () => {
    const ctx = makeCtx(async () => {
      await new Promise((r) => setTimeout(r, 200));
      throw new Error("late boom");
    });
    const out = (await agentTool({ description: "d", prompt: "p" }, ctx)) as string;
    expect(out).toMatch(/background/i);
    await until(() => notificationQueue.getSnapshot("s-test").length > 0);
    const notif = notificationQueue.getSnapshot("s-test")[0];
    expect(notif.status).toBe("failed");
    expect(notif.error).toContain("late boom");
  });
});
