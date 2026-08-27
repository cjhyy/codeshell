import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { SessionWorkspaceAuthority } from "../preload/types";
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

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("useSessionUiAuthority", () => {
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
