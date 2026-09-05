import { afterEach, describe, expect, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import type { SessionWorkspaceAuthority, StreamEventEnvelope } from "../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "./test-utils/renderHook";
import { useSessionUiAuthority } from "./sessionUiAuthority";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function authority(sessionId: string): SessionWorkspaceAuthority {
  return {
    workspace: { root: `/roots/${sessionId}`, kind: "main" },
    projectId: "project-1",
    mainRootId: `root-${sessionId}`,
    mainRoot: `/roots/${sessionId}`,
    mainRootName: sessionId,
    rootStatus: "ok",
  };
}

let cleanup: (() => Promise<void>) | null = null;

function streamHost(lookup: (sessionId: string) => Promise<SessionWorkspaceAuthority>) {
  const listeners = new Set<(event: StreamEventEnvelope) => void>();
  const workspaceListeners = new Set<(event: { sessionId: string }) => void>();
  Object.assign(window, {
    codeshell: {
      getSessionWorkspaceAuthority: lookup,
      onWorkspaceChanged: (callback: (event: { sessionId: string }) => void) => {
        workspaceListeners.add(callback);
        return () => workspaceListeners.delete(callback);
      },
      onStreamEvent: (callback: (event: StreamEventEnvelope) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  });
  return {
    listeners,
    workspaceListeners,
    emit(envelope: StreamEventEnvelope) {
      for (const listener of listeners) listener(envelope);
    },
  };
}

function sessionParams(sessionId: string) {
  return {
    sessionId,
    projectId: "project-1",
    projectPrimaryRoot: "/current-primary",
    projectPrimaryRootId: "current-primary",
    projectAuthorityVersion: "revision-1",
    noRepoCwd: null,
    allowProjectFallback: false,
  };
}

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("useSessionUiAuthority", () => {
  test("recovers an initially unknown Session when its top-level run starts", async () => {
    ensureMiniDom();
    const persisted = deferred<SessionWorkspaceAuthority>();
    let calls = 0;
    const host = streamHost(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("unknown session")) : persisted.promise;
    });
    const hook = await renderHook(() => useSessionUiAuthority(sessionParams("session")));
    cleanup = hook.unmount;

    expect(hook.result.current.rootStatus).toBe("unavailable");
    expect(hook.result.current.rootStatusMessage).toBe("unknown session");
    expect(hook.result.current.configurationAvailable).toBe(false);

    await act(async () => {
      host.emit({
        sessionId: "session",
        event: { type: "session_started", sessionId: "session", promptTokens: 0 },
      });
      await flushMicrotasks();
    });
    expect(calls).toBe(2);
    expect(hook.result.current.rootStatus).toBe("unavailable");

    await act(async () => {
      persisted.resolve(authority("session"));
      await flushMicrotasks();
    });
    expect(hook.result.current.rootStatus).toBe("ok");
    expect(hook.result.current.configurationAvailable).toBe(true);
    expect(hook.result.current.workspaceRoot).toBe("/roots/session");
  });

  test("ignores other Sessions, ordinary stream deltas and sub-agent start events", async () => {
    ensureMiniDom();
    let calls = 0;
    const host = streamHost(async () => {
      calls += 1;
      return authority("session");
    });
    const hook = await renderHook(() => useSessionUiAuthority(sessionParams("session")));
    cleanup = hook.unmount;
    expect(host.listeners.size).toBe(1);

    await act(async () => {
      host.emit({
        sessionId: "other-session",
        event: { type: "session_started", sessionId: "session", promptTokens: 0 },
      });
      host.emit({
        sessionId: "session",
        event: { type: "session_started", sessionId: "child-session", promptTokens: 0 },
      });
      host.emit({
        sessionId: "session",
        event: { type: "text_delta", text: "working" },
      });
      host.emit({
        sessionId: "session",
        event: { type: "agent_start", agentId: "child", description: "child task" },
      });
      const childStart = {
        type: "session_started" as const,
        sessionId: "session",
        promptTokens: 0,
        agentId: "child",
      };
      host.emit({ sessionId: "session", event: childStart });
      await flushMicrotasks();
    });
    expect(calls).toBe(1);
    expect(hook.result.current.workspaceRoot).toBe("/roots/session");
  });

  test("ignores an old subscription callback between a Session switch render and effect cleanup", async () => {
    ensureMiniDom();
    const calls: string[] = [];
    const host = streamHost(async (sessionId) => {
      calls.push(sessionId);
      return authority(sessionId);
    });
    let sessionId = "old-session";
    const hook = await renderHook(() => {
      const projection = useSessionUiAuthority(sessionParams(sessionId));
      useLayoutEffect(() => {
        if (sessionId !== "new-session") return;
        // Passive effect cleanup has not yet removed the old subscription.
        host.emit({
          sessionId: "old-session",
          event: { type: "session_started", sessionId: "old-session", promptTokens: 0 },
        });
      }, [sessionId]);
      return projection;
    });
    cleanup = hook.unmount;

    sessionId = "new-session";
    await hook.rerender();

    expect(calls).toEqual(["old-session", "new-session"]);
    expect(hook.result.current.workspaceRoot).toBe("/roots/new-session");
  });

  test("cleans stream subscriptions when switching Session and unmounting", async () => {
    ensureMiniDom();
    const oldRefresh = deferred<SessionWorkspaceAuthority>();
    const calls: string[] = [];
    const host = streamHost((sessionId) => {
      calls.push(sessionId);
      return calls.length === 2 ? oldRefresh.promise : Promise.resolve(authority(sessionId));
    });
    let sessionId = "old-session";
    const hook = await renderHook(() => useSessionUiAuthority(sessionParams(sessionId)));
    cleanup = hook.unmount;
    expect(host.listeners.size).toBe(1);

    await act(async () => {
      host.emit({
        sessionId: "old-session",
        event: { type: "session_started", sessionId: "old-session", promptTokens: 0 },
      });
      await flushMicrotasks();
    });
    sessionId = "new-session";
    await hook.rerender();
    expect(host.listeners.size).toBe(1);
    expect(hook.result.current.workspaceRoot).toBe("/roots/new-session");

    await act(async () => {
      host.emit({
        sessionId: "old-session",
        event: { type: "session_started", sessionId: "old-session", promptTokens: 0 },
      });
      oldRefresh.resolve(authority("stale-session"));
      await flushMicrotasks();
    });
    expect(calls).toEqual(["old-session", "old-session", "new-session"]);
    expect(hook.result.current.workspaceRoot).toBe("/roots/new-session");

    await hook.unmount();
    cleanup = null;
    expect(host.listeners.size).toBe(0);
    expect(host.workspaceListeners.size).toBe(0);
  });

  test("keeps a removed-root verdict distinct when a started run refreshes authority", async () => {
    ensureMiniDom();
    let calls = 0;
    const host = streamHost(async () => {
      calls += 1;
      return { ...authority("session"), rootStatus: "root_removed" };
    });
    const hook = await renderHook(() => useSessionUiAuthority(sessionParams("session")));
    cleanup = hook.unmount;
    await act(async () => {
      host.emit({
        sessionId: "session",
        event: { type: "session_started", sessionId: "session", promptTokens: 0 },
      });
      await flushMicrotasks();
    });
    expect(calls).toBe(2);
    expect(hook.result.current.rootStatus).toBe("root_removed");
    expect(hook.result.current.configurationAvailable).toBe(false);
    expect(hook.result.current.workspaceRoot).toBeNull();
  });

  test("does not let a stale authority response overwrite the newly selected Session", async () => {
    ensureMiniDom();
    const oldRequest = deferred<SessionWorkspaceAuthority>();
    const newRequest = deferred<SessionWorkspaceAuthority>();
    Object.assign(window, {
      codeshell: {
        getSessionWorkspaceAuthority: (sessionId: string) =>
          sessionId === "old-session" ? oldRequest.promise : newRequest.promise,
        onWorkspaceChanged: () => () => undefined,
      },
    });
    let sessionId = "old-session";
    const hook = await renderHook(() =>
      useSessionUiAuthority({
        sessionId,
        projectId: "project-1",
        projectPrimaryRoot: "/current-primary",
        projectPrimaryRootId: "current-primary",
        projectAuthorityVersion: "revision-1",
        noRepoCwd: null,
        allowProjectFallback: false,
      }),
    );
    cleanup = hook.unmount;

    sessionId = "new-session";
    await hook.rerender();
    await act(async () => {
      newRequest.resolve(authority("new-session"));
      await flushMicrotasks();
    });
    expect(hook.result.current.mainRootId).toBe("root-new-session");

    await act(async () => {
      oldRequest.resolve(authority("old-session"));
      await flushMicrotasks();
    });
    expect(hook.result.current.mainRootId).toBe("root-new-session");
    expect(hook.result.current.workspaceRoot).toBe("/roots/new-session");
  });

  test("masks an authority loaded for an older project authority version", async () => {
    ensureMiniDom();
    const oldRequest = deferred<SessionWorkspaceAuthority>();
    const newRequest = deferred<SessionWorkspaceAuthority>();
    const requests = [oldRequest, newRequest];
    Object.assign(window, {
      codeshell: {
        getSessionWorkspaceAuthority: () => requests.shift()!.promise,
        onWorkspaceChanged: () => () => undefined,
      },
    });
    let projectAuthorityVersion = "revision-1";
    const hook = await renderHook(() =>
      useSessionUiAuthority({
        sessionId: "session",
        projectId: "project-1",
        projectPrimaryRoot: "/current-primary",
        projectPrimaryRootId: "current-primary",
        projectAuthorityVersion,
        noRepoCwd: null,
        allowProjectFallback: false,
      }),
    );
    cleanup = hook.unmount;

    projectAuthorityVersion = "revision-2";
    await hook.rerender();
    expect(hook.result.current.rootStatus).toBe("loading");
    expect(hook.result.current.mainRootId).toBeNull();

    await act(async () => {
      oldRequest.resolve(authority("old-version"));
      await flushMicrotasks();
    });
    expect(hook.result.current.rootStatus).toBe("loading");
    expect(hook.result.current.mainRootId).toBeNull();

    await act(async () => {
      newRequest.resolve(authority("new-version"));
      await flushMicrotasks();
    });
    expect(hook.result.current.rootStatus).toBe("ok");
    expect(hook.result.current.mainRootId).toBe("root-new-version");
  });

  test("keeps same-target authority visible while workspace change refreshes it", async () => {
    ensureMiniDom();
    const refreshRequest = deferred<SessionWorkspaceAuthority>();
    let changed: ((event: { sessionId: string }) => void) | undefined;
    let calls = 0;
    Object.assign(window, {
      codeshell: {
        getSessionWorkspaceAuthority: () => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(authority("before-refresh"))
            : refreshRequest.promise;
        },
        onWorkspaceChanged: (callback: (event: { sessionId: string }) => void) => {
          changed = callback;
          return () => {
            changed = undefined;
          };
        },
      },
    });
    const hook = await renderHook(() =>
      useSessionUiAuthority({
        sessionId: "session",
        projectId: "project-1",
        projectPrimaryRoot: "/current-primary",
        projectPrimaryRootId: "current-primary",
        projectAuthorityVersion: "revision-1",
        noRepoCwd: null,
        allowProjectFallback: false,
      }),
    );
    cleanup = hook.unmount;
    expect(hook.result.current.workspaceRoot).toBe("/roots/before-refresh");

    await act(async () => {
      changed?.({ sessionId: "session" });
      await flushMicrotasks();
    });
    expect(hook.result.current.workspaceRoot).toBe("/roots/before-refresh");

    await act(async () => {
      refreshRequest.resolve(authority("after-refresh"));
      await flushMicrotasks();
    });
    expect(hook.result.current.workspaceRoot).toBe("/roots/after-refresh");
  });
});
