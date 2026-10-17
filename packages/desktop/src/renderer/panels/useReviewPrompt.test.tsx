import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { onComposerSeedRequest } from "../chat/composerSeed";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useReviewPrompt } from "./useReviewPrompt";
import type { ReviewAiPromptResult } from "../../shared/review";

let cleanup: (() => Promise<void>) | undefined;
let unsubscribe: (() => void) | undefined;
beforeEach(() => ensureMiniDom());
afterEach(async () => {
  unsubscribe?.();
  await cleanup?.();
  cleanup = undefined;
  unsubscribe = undefined;
});

const request = { kind: "git", scope: { kind: "working", mode: "staged" } } as const;

test("prepares the exact scope once and adds a Session-bound composer draft", async () => {
  let resolve!: (value: ReviewAiPromptResult) => void;
  const calls: unknown[][] = [];
  Object.assign(window, {
    codeshell: {
      prepareReviewPrompt: (...args: unknown[]) => {
        calls.push(args);
        return new Promise<ReviewAiPromptResult>((res) => {
          resolve = res;
        });
      },
    },
  });
  const received: unknown[] = [];
  unsubscribe = onComposerSeedRequest((value) => {
    received.push(value);
    return true;
  });
  const context = {};
  const hook = await renderHook(() => useReviewPrompt("session-a", context));
  cleanup = hook.unmount;
  let first!: Promise<void>;
  await act(async () => {
    first = hook.result.current.prepare(request);
    await hook.result.current.prepare(request);
    await flushMicrotasks();
  });
  expect(calls).toEqual([["session-a", request]]);
  expect(hook.result.current.phase).toBe("preparing");
  await act(async () => {
    resolve({ prompt: "Review only the staged patch", truncated: true });
    await first;
  });
  expect(received).toEqual([
    { text: "Review only the staged patch", source: "code-review", sessionId: "session-a" },
  ]);
  expect(hook.result.current.phase).toBe("truncated");
});

test("ignores a late draft after changing scope, workspace, or Session", async () => {
  let resolve!: (value: ReviewAiPromptResult) => void;
  Object.assign(window, {
    codeshell: {
      prepareReviewPrompt: () =>
        new Promise<ReviewAiPromptResult>((res) => {
          resolve = res;
        }),
    },
  });
  const received: unknown[] = [];
  unsubscribe = onComposerSeedRequest((value) => received.push(value));
  let context = {};
  const hook = await renderHook(() => useReviewPrompt("session-a", context));
  cleanup = hook.unmount;
  let pending!: Promise<void>;
  await act(async () => {
    pending = hook.result.current.prepare(request);
    await flushMicrotasks();
  });
  context = {};
  await hook.rerender();
  await act(async () => {
    resolve({ prompt: "stale", truncated: false });
    await pending;
  });
  expect(received).toEqual([]);
  expect(hook.result.current.phase).toBe("idle");
});

test("surfaces failures without publishing an empty or oversized review", async () => {
  Object.assign(window, {
    codeshell: {
      prepareReviewPrompt: async () => {
        throw new Error("repository unavailable");
      },
    },
  });
  const context = {};
  const hook = await renderHook(() => useReviewPrompt("session-a", context));
  cleanup = hook.unmount;
  await act(async () => {
    await hook.result.current.prepare(request);
  });
  expect(hook.result.current.error).toBe("repository unavailable");
  Object.assign(window, {
    codeshell: {
      prepareReviewPrompt: async () => ({ prompt: "x".repeat(33_000), truncated: false }),
    },
  });
  await act(async () => {
    await hook.result.current.prepare(request);
  });
  expect(hook.result.current.error).toContain("active conversation");
});
