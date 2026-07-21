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
import {
  generateVideoTool,
  __setVideoPollingLimitsForTests,
  __setVideoProviderForTests,
} from "./generate-video.js";
import {
  FakeVideoProvider,
  type VideoDownloadResult,
  type VideoPollResult,
  type VideoProvider,
  type VideoSubmitResult,
} from "./video-providers.js";
import { notificationQueue } from "./agent-notifications.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import type { ToolContext } from "../context.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "genvid-"));
  notificationQueue.reset();
  backgroundJobRegistry.reset();
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  notificationQueue.reset();
  backgroundJobRegistry.reset();
  __setVideoProviderForTests(null);
  __setVideoPollingLimitsForTests(null);
});

function ctx(signal?: AbortSignal): ToolContext {
  return { cwd: ws, sessionId: "s-vid", signal } as unknown as ToolContext;
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
    let yielded: string | undefined;
    const context = ctx();
    context.runYield = {
      request: (reason) => {
        yielded = reason;
      },
      consume: () => undefined,
    };
    const out = (await generateVideoTool(
      { prompt: "a sunset", pollIntervalMs: 10 },
      context,
    )) as string;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(200); // did NOT block on polling
    expect(out).toMatch(/background|started|notified/i);
    expect(yielded).toBe("background_notification");

    await until(() => notificationQueue.getSnapshot("s-vid").length > 0);
    const notif = notificationQueue.getSnapshot("s-vid")[0];
    expect(notif.status).toBe("completed");

    const dir = join(ws, ".code-shell", "generated_videos");
    expect(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".mp4"))).toBe(true);
  });

  test("a failed job enqueues a failed notification (no file)", async () => {
    __setVideoProviderForTests(
      new FakeVideoProvider({ failAfterPolls: 0, failMessage: "blocked by policy" }),
    );
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

  test("registers a background job while polling, clears it on completion", async () => {
    // Slow poll so the job is observably 'running' right after submit.
    __setVideoProviderForTests(new FakeVideoProvider({ succeedAfterPolls: 2, bytes: "MP4DATA" }));
    await generateVideoTool({ prompt: "p", pollIntervalMs: 30 }, ctx());
    // Engine.run's wait-loop must see this session's job as running so it parks
    // the turn instead of letting the goal-stop-hook force busywork.
    expect(backgroundJobRegistry.hasRunningForSession("s-vid")).toBe(true);
    await until(() => notificationQueue.getSnapshot("s-vid").length > 0);
    // Cleared once the poll loop finishes — the wait-loop can now resolve.
    expect(backgroundJobRegistry.hasRunningForSession("s-vid")).toBe(false);
  });

  test("clears the background job even when the job fails", async () => {
    __setVideoProviderForTests(new FakeVideoProvider({ failAfterPolls: 0, failMessage: "x" }));
    await generateVideoTool({ prompt: "p", pollIntervalMs: 10 }, ctx());
    await until(() => notificationQueue.getSnapshot("s-vid").length > 0);
    expect(backgroundJobRegistry.hasRunningForSession("s-vid")).toBe(false);
  });

  test("abort after the remote URL is known still notifies and retains the URL outcome", async () => {
    let downloadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });
    const url = "https://cdn.example/video.mp4";
    const provider: VideoProvider = {
      kind: "fake",
      async submit(): Promise<VideoSubmitResult> {
        return { ok: true, jobId: "known-url" };
      },
      async poll(): Promise<VideoPollResult> {
        return { ok: true, status: "succeeded" };
      },
      async download(req): Promise<VideoDownloadResult> {
        req.onUrl?.(url);
        downloadStarted();
        if (!req.signal) throw new Error("download did not receive a signal");
        return await new Promise((resolve) => {
          req.signal!.addEventListener(
            "abort",
            () => resolve({ ok: false, error: "download aborted" }),
            { once: true },
          );
        });
      },
    };
    __setVideoProviderForTests(provider);

    await generateVideoTool({ prompt: "keep the link", pollIntervalMs: 1 }, ctx());
    await started;
    await expect(backgroundJobRegistry.cancel("video-known-url")).resolves.toBe(true);

    await until(() => backgroundJobRegistry.get("video-known-url")?.status !== "running");
    const job = backgroundJobRegistry.get("video-known-url");
    expect(job?.status).toBe("completed");
    expect(job?.finalText).toContain(url);
    const notification = notificationQueue.getSnapshot("s-vid")[0];
    expect(notification.status).toBe("completed");
    expect(notification.finalText).toContain(url);
  });

  test("download request timeout retains a URL reported before the byte download hangs", async () => {
    __setVideoPollingLimitsForTests({ maxPollMs: 1_000, requestTimeoutMs: 25 });
    const url = "https://cdn.example/timed-out-download.mp4";
    let downloadSignal: AbortSignal | undefined;
    const provider: VideoProvider = {
      kind: "fake",
      async submit(): Promise<VideoSubmitResult> {
        return { ok: true, jobId: "download-timeout-url" };
      },
      async poll(): Promise<VideoPollResult> {
        return { ok: true, status: "succeeded" };
      },
      async download(req): Promise<VideoDownloadResult> {
        downloadSignal = req.signal;
        req.onUrl?.(url);
        return await new Promise(() => {});
      },
    };
    __setVideoProviderForTests(provider);

    await generateVideoTool({ prompt: "retain timed out URL", pollIntervalMs: 1 }, ctx());

    await until(
      () => backgroundJobRegistry.get("video-download-timeout-url")?.status !== "running",
    );
    const job = backgroundJobRegistry.get("video-download-timeout-url");
    expect(downloadSignal?.aborted).toBe(true);
    expect(job?.status).toBe("completed");
    expect(job?.finalText).toContain(url);
    const notification = notificationQueue.getSnapshot("s-vid")[0];
    expect(notification.status).toBe("completed");
    expect(notification.finalText).toContain(url);
  });

  test("poll request timeout aborts its request without waiting for the total deadline", async () => {
    __setVideoPollingLimitsForTests({ maxPollMs: 1_000, requestTimeoutMs: 25 });
    let pollSignal: AbortSignal | undefined;
    const provider: VideoProvider = {
      kind: "fake",
      async submit(): Promise<VideoSubmitResult> {
        return { ok: true, jobId: "poll-request-timeout" };
      },
      async poll(req): Promise<VideoPollResult> {
        pollSignal = req.signal;
        return await new Promise(() => {});
      },
      async download(): Promise<VideoDownloadResult> {
        throw new Error("download must not run");
      },
    };
    __setVideoProviderForTests(provider);

    await generateVideoTool({ prompt: "poll timeout", pollIntervalMs: 1 }, ctx());

    await until(() => backgroundJobRegistry.get("video-poll-request-timeout")?.status === "failed");
    expect(pollSignal?.aborted).toBe(true);
    expect(backgroundJobRegistry.get("video-poll-request-timeout")?.finalText).not.toContain(
      "video job poll-request-timeout timed out",
    );
  });

  test("abort before remote completion stops polling and marks the job cancelled", async () => {
    let pollStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pollStarted = resolve;
    });
    let polls = 0;
    const provider: VideoProvider = {
      kind: "fake",
      async submit(): Promise<VideoSubmitResult> {
        return { ok: true, jobId: "still-rendering" };
      },
      async poll(req): Promise<VideoPollResult> {
        polls++;
        pollStarted();
        if (!req.signal) throw new Error("poll did not receive a signal");
        return await new Promise((resolve) => {
          req.signal!.addEventListener(
            "abort",
            () => resolve({ ok: false, error: "poll aborted" }),
            { once: true },
          );
        });
      },
      async download(): Promise<VideoDownloadResult> {
        throw new Error("download must not run");
      },
    };
    const controller = new AbortController();
    __setVideoProviderForTests(provider);

    await generateVideoTool(
      { prompt: "still rendering", pollIntervalMs: 1 },
      ctx(controller.signal),
    );
    await started;
    controller.abort();

    await until(() => backgroundJobRegistry.get("video-still-rendering")?.status === "cancelled");
    expect(polls).toBe(1);
    expect(backgroundJobRegistry.get("video-still-rendering")?.finalText).toContain(
      "may still be rendering",
    );
  });

  test("an independently scheduled total deadline aborts a permanently hung poll", async () => {
    __setVideoPollingLimitsForTests({ maxPollMs: 25, requestTimeoutMs: 1_000 });
    let pollSignal: AbortSignal | undefined;
    const provider: VideoProvider = {
      kind: "fake",
      async submit(): Promise<VideoSubmitResult> {
        return { ok: true, jobId: "hung-poll" };
      },
      async poll(req): Promise<VideoPollResult> {
        if (!req.signal) throw new Error("poll did not receive a signal");
        pollSignal = req.signal;
        return await new Promise(() => {});
      },
      async download(): Promise<VideoDownloadResult> {
        throw new Error("download must not run");
      },
    };
    __setVideoProviderForTests(provider);

    await generateVideoTool({ prompt: "deadline", pollIntervalMs: 1 }, ctx());

    await until(() => backgroundJobRegistry.get("video-hung-poll")?.status === "failed");
    expect(pollSignal?.aborted).toBe(true);
    expect(backgroundJobRegistry.hasRunningForSession("s-vid")).toBe(false);
    expect(backgroundJobRegistry.get("video-hung-poll")?.finalText).toContain("timed out");
  });
});
