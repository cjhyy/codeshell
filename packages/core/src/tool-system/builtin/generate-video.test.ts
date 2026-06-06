/**
 * 7.1 (块3) — GenerateVideo tool. Submits a video job and polls in the
 * background (video is always slow), then writes the result to
 * .code-shell/generated_videos/ and notifies via the notification queue —
 * never blocking the turn. Uses the injectable FakeVideoProvider so the test
 * runs without network and without waiting real poll intervals.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateVideoTool, __setVideoProviderForTests } from "./generate-video.js";
import { FakeVideoProvider } from "./video-providers.js";
import { notificationQueue } from "./agent-notifications.js";
import type { ToolContext } from "../context.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "genvid-"));
  notificationQueue.reset();
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  notificationQueue.reset();
  __setVideoProviderForTests(null);
});

function ctx(): ToolContext {
  return { cwd: ws, sessionId: "s-vid" } as unknown as ToolContext;
}

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("GenerateVideo", () => {
  test("returns immediately with a job handle, polls in background, writes file + notifies", async () => {
    // Inject a fake provider that succeeds on the 2nd poll. Tiny poll interval.
    __setVideoProviderForTests(new FakeVideoProvider({ succeedAfterPolls: 1, bytes: "MP4DATA" }));

    const started = Date.now();
    const out = (await generateVideoTool({ prompt: "a sunset", pollIntervalMs: 10 }, ctx())) as string;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(200); // did NOT block on polling
    expect(out).toMatch(/background|started|notified/i);

    await until(() => notificationQueue.getSnapshot("s-vid").length > 0);
    const notif = notificationQueue.getSnapshot("s-vid")[0];
    expect(notif.status).toBe("completed");

    const dir = join(ws, ".code-shell", "generated_videos");
    expect(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".mp4"))).toBe(true);
  });

  test("a failed job enqueues a failed notification (no file)", async () => {
    __setVideoProviderForTests(new FakeVideoProvider({ failAfterPolls: 0, failMessage: "blocked by policy" }));
    const out = (await generateVideoTool({ prompt: "p", pollIntervalMs: 10 }, ctx())) as string;
    expect(out).toMatch(/background|started/i);
    await until(() => notificationQueue.getSnapshot("s-vid").length > 0);
    const notif = notificationQueue.getSnapshot("s-vid")[0];
    expect(notif.status).toBe("failed");
    expect(notif.error).toContain("blocked by policy");
  });

  test("missing prompt errors", async () => {
    const out = await generateVideoTool({}, ctx());
    expect(out).toMatch(/prompt is required/i);
  });
});
