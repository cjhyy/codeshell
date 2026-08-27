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
});
