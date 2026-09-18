import { afterEach, describe, expect, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import type { StreamEventEnvelope } from "../../preload/types";
import type { ReviewGitStatusResult } from "../../shared/review";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import {
  readReviewAvailability,
  useReviewAvailability,
  type ReviewAvailabilityState,
} from "./useReviewAvailability";

const empty: ReviewGitStatusResult = { repositories: [], errors: [] };
const repository: ReviewGitStatusResult = {
  repositories: [
    {
      rootId: "secondary",
      rootIds: ["secondary"],
      repoRoot: "/secondary-repo",
      branch: null,
      entries: [],
      clean: true,
    },
  ],
  errors: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function host(read: (sessionId: string) => Promise<ReviewGitStatusResult>) {
  ensureMiniDom();
  const workspaceListeners = new Set<(event: { sessionId: string }) => void>();
  const streamListeners = new Set<(event: StreamEventEnvelope) => void>();
  Object.assign(window, {
    codeshell: {
      getReviewStatus: read,
      onWorkspaceChanged: (callback: (event: { sessionId: string }) => void) => {
        workspaceListeners.add(callback);
        return () => workspaceListeners.delete(callback);
      },
      onStreamEvent: (callback: (event: StreamEventEnvelope) => void) => {
        streamListeners.add(callback);
        return () => streamListeners.delete(callback);
      },
    },
  });
  return {
    workspaceListeners,
    streamListeners,
    workspace(sessionId: string) {
      for (const listener of workspaceListeners) listener({ sessionId });
    },
    stream(event: StreamEventEnvelope) {
      for (const listener of streamListeners) listener(event);
    },
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("readReviewAvailability", () => {
  test("recognizes clean unborn and secondary repositories and preserves discovery errors", async () => {
    let result = repository;
    host(async () => result);
    expect(await readReviewAvailability("classification")).toEqual({
      status: "available",
      available: true,
    });
    result = empty;
    expect(await readReviewAvailability("classification")).toEqual({
      status: "unavailable",
      available: false,
    });
    result = {
      repositories: [],
      errors: [
        { operation: "discover", rootId: "primary", rootIds: ["primary"], message: "git missing" },
      ],
    };
    expect(await readReviewAvailability("classification")).toEqual({
      status: "error",
      available: false,
    });
    result = {
      repositories: [],
      errors: [
        {
          operation: "status",
          rootId: "primary",
          rootIds: ["primary"],
          repoRoot: "/repo",
          message: "status failed",
        },
      ],
    };
    expect(await readReviewAvailability("classification")).toEqual({
      status: "available",
      available: true,
    });
    result = {
      ...repository,
      errors: [
        { operation: "discover", rootId: "primary", rootIds: ["primary"], message: "denied" },
      ],
    };
    expect((await readReviewAvailability("classification")).available).toBe(true);
  });

  test("shares pending reads by identity but neither caches results nor swallows errors as non-repo", async () => {
    let request = deferred<ReviewGitStatusResult>();
    let calls = 0;
    host(() => {
      calls += 1;
      return request.promise;
    });
    const first = readReviewAvailability("shared", "roots-a");
    const same = readReviewAvailability("shared", "roots-a");
    const different = readReviewAvailability("shared", "roots-b");
    await flushMicrotasks();
    expect(calls).toBe(2);
    request.reject(new Error("IPC unavailable"));
    expect(await first).toEqual({ status: "error", available: false });
    expect(await same).toEqual({ status: "error", available: false });
    await different;
    request = deferred<ReviewGitStatusResult>();
    const retry = readReviewAvailability("shared", "roots-a");
    await flushMicrotasks();
    expect(calls).toBe(3);
    request.resolve(repository);
    expect((await retry).available).toBe(true);
  });
});

describe("useReviewAvailability", () => {
  test("requires both identities and starts hidden until a repository is confirmed", async () => {
    const request = deferred<ReviewGitStatusResult>();
    let calls = 0;
    host(() => {
      calls += 1;
      return request.promise;
    });
    let sessionId: string | null = null;
    let workspaceKey: string | null = "root";
    const hook = await renderHook(() => useReviewAvailability(sessionId, workspaceKey));
    cleanup = hook.unmount;
    expect(hook.result.current.available).toBe(false);
    sessionId = "draft";
    workspaceKey = null;
    await hook.rerender();
    expect(calls).toBe(0);
    workspaceKey = "root";
    await hook.rerender();
    expect(hook.result.current).toEqual({ status: "loading", available: false });
    await act(async () => {
      request.resolve(repository);
      await flushMicrotasks();
    });
    expect(hook.result.current.available).toBe(true);
  });

  test("hides old capability during the switch render and rejects late workspace responses", async () => {
    const requests: Array<ReturnType<typeof deferred<ReviewGitStatusResult>>> = [];
    host(() => {
      const request = deferred<ReviewGitStatusResult>();
      requests.push(request);
      return request.promise;
    });
    let workspaceKey = "root-a";
    const renders: ReviewAvailabilityState[] = [];
    const hook = await renderHook(() => {
      const result = useReviewAvailability("switch", workspaceKey);
      useLayoutEffect(() => {
        renders.push(result);
      }, [workspaceKey]);
      return result;
    });
    cleanup = hook.unmount;
    await act(async () => {
      requests[0]!.resolve(repository);
      await flushMicrotasks();
    });
    expect(hook.result.current.available).toBe(true);
    workspaceKey = "root-b";
    await hook.rerender();
    expect(renders.at(-1)).toEqual({ status: "loading", available: false });
    workspaceKey = "root-a";
    await hook.rerender();
    expect(hook.result.current).toEqual({ status: "loading", available: false });
    await act(async () => {
      requests[2]!.resolve(empty);
      await flushMicrotasks();
      requests[1]!.resolve(repository);
      await flushMicrotasks();
    });
    expect(hook.result.current).toEqual({ status: "unavailable", available: false });
  });

  test("workspace changes replace in-flight reads once across consumers and reject stale responses", async () => {
    const requests: Array<ReturnType<typeof deferred<ReviewGitStatusResult>>> = [];
    const events = host(() => {
      const request = deferred<ReviewGitStatusResult>();
      requests.push(request);
      return request.promise;
    });
    const hook = await renderHook(() => [
      useReviewAvailability("workspace-change", "same-key"),
      useReviewAvailability("workspace-change", "same-key"),
    ]);
    cleanup = hook.unmount;
    expect(requests.length).toBe(1);
    await act(async () => {
      events.workspace("other");
      await flushMicrotasks();
    });
    expect(requests.length).toBe(1);
    await act(async () => {
      events.workspace("workspace-change");
      await flushMicrotasks();
    });
    expect(requests.length).toBe(2);
    await act(async () => {
      requests[1]!.resolve(empty);
      await flushMicrotasks();
      requests[0]!.resolve(repository);
      await flushMicrotasks();
    });
    expect(hook.result.current).toEqual([
      { status: "unavailable", available: false },
      { status: "unavailable", available: false },
    ]);
  });

  test("keeps known availability while refreshing and pauses inactive listeners", async () => {
    const requests: Array<ReturnType<typeof deferred<ReviewGitStatusResult>>> = [];
    const events = host(() => {
      const request = deferred<ReviewGitStatusResult>();
      requests.push(request);
      return request.promise;
    });
    let active = true;
    const hook = await renderHook(() => useReviewAvailability("paused", "roots", active));
    cleanup = hook.unmount;
    await act(async () => {
      requests[0]!.resolve(repository);
      await flushMicrotasks();
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    expect(requests.length).toBe(2);
    expect(hook.result.current).toEqual({ status: "available", available: true });
    active = false;
    await hook.rerender();
    await act(async () => {
      events.workspace("paused");
      window.dispatchEvent(new Event("focus"));
      requests[1]!.resolve(empty);
      await flushMicrotasks();
    });
    expect(requests.length).toBe(2);
    expect(hook.result.current.available).toBe(true);
    expect(events.workspaceListeners.size).toBe(0);
    expect(events.streamListeners.size).toBe(0);
    active = true;
    await hook.rerender();
    expect(requests.length).toBe(3);
    await act(async () => {
      requests[2]!.resolve(empty);
      await flushMicrotasks();
    });
    expect(hook.result.current.available).toBe(false);
    await hook.unmount();
    cleanup = null;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    expect(requests.length).toBe(3);
  });

  test("refreshes top-level lifecycle and Git events, ignoring tokens and unrelated sessions", async () => {
    let calls = 0;
    const events = host(async () => {
      calls += 1;
      return repository;
    });
    const hook = await renderHook(() => useReviewAvailability("lifecycle", "roots"));
    cleanup = hook.unmount;
    await act(async () => {
      events.stream({ sessionId: "lifecycle", event: { type: "text_delta", text: "working" } });
      events.stream({ sessionId: "other", event: { type: "turn_complete", reason: "completed" } });
      events.stream({
        sessionId: "lifecycle",
        event: { type: "turn_complete", reason: "completed", agentId: "child" },
      });
      events.stream({
        sessionId: "lifecycle",
        event: { type: "session_started", sessionId: "child", promptTokens: 0 },
      });
      await flushMicrotasks();
    });
    expect(calls).toBe(1);
    for (const event of [
      { type: "turn_complete", reason: "completed" },
      { type: "error", error: "failed" },
      { type: "session_started", sessionId: "lifecycle", promptTokens: 0 },
    ] as StreamEventEnvelope["event"][]) {
      await act(async () => {
        events.stream({ sessionId: "lifecycle", event });
        await flushMicrotasks();
      });
    }
    expect(calls).toBe(4);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("codeshell:git-branches-changed", { detail: { cwd: "/secondary-repo" } }),
      );
      await flushMicrotasks();
    });
    expect(calls).toBe(5);
  });
});
