import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import type { RendererConfigurationTarget, WorkspaceProfileSummary } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { useSessionWorkspaceProfiles } from "./useSessionWorkspaceProfiles";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function profile(name: string, description?: string): WorkspaceProfileSummary {
  return {
    name,
    label: `Label ${name}`,
    description,
    basePreset: "general",
    plugins: [],
    skills: [],
    mcp: [],
    agents: [],
    mainInstruction: undefined,
    active: false,
    portableMemory: false,
    exclusiveCapabilities: false,
    version: undefined,
  };
}

describe("useSessionWorkspaceProfiles", () => {
  let cleanup: (() => Promise<void>) | null;
  let bridgeBefore: PropertyDescriptor | undefined;
  let listProfiles: ReturnType<
    typeof mock<(target: RendererConfigurationTarget | null) => Promise<WorkspaceProfileSummary[]>>
  >;

  beforeEach(() => {
    ensureMiniDom();
    cleanup = null;
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    listProfiles = mock(async () => []);
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: { listProfiles },
    });
  });

  afterEach(async () => {
    await cleanup?.();
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
  });

  test("loads asynchronously and preserves the description in identity choices", async () => {
    const pending = deferred<WorkspaceProfileSummary[]>();
    listProfiles.mockReturnValueOnce(pending.promise);
    const target: RendererConfigurationTarget = { projectId: "project-a" };
    const hook = await renderHook(() =>
      useSessionWorkspaceProfiles({
        configurationAvailable: true,
        configurationTarget: target,
        refreshKey: "chat",
      }),
    );
    cleanup = hook.unmount;
    expect(hook.result.current).toEqual([]);
    expect(listProfiles).toHaveBeenCalledWith(target);

    await act(async () => {
      pending.resolve([profile("product-manager", "Defines the product goal")]);
      await flushMicrotasks();
    });
    expect(hook.result.current).toEqual([
      {
        name: "product-manager",
        label: "Label product-manager",
        description: "Defines the product goal",
      },
    ]);
  });

  test("does not let an older configuration target overwrite the current result", async () => {
    const first = deferred<WorkspaceProfileSummary[]>();
    const second = deferred<WorkspaceProfileSummary[]>();
    listProfiles.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let target: RendererConfigurationTarget = { projectId: "project-a" };
    const hook = await renderHook(() =>
      useSessionWorkspaceProfiles({
        configurationAvailable: true,
        configurationTarget: target,
        refreshKey: "chat",
      }),
    );
    cleanup = hook.unmount;
    target = { projectId: "project-b" };
    await hook.rerender();

    await act(async () => {
      second.resolve([profile("current")]);
      await flushMicrotasks();
      first.resolve([profile("stale")]);
      await flushMicrotasks();
    });
    expect(hook.result.current.map((entry) => entry.name)).toEqual(["current"]);
    expect(listProfiles.mock.calls.map(([value]) => value)).toEqual([
      { projectId: "project-a" },
      { projectId: "project-b" },
    ]);
  });

  test("clears unavailable choices and ignores a pending response after availability changes", async () => {
    const pending = deferred<WorkspaceProfileSummary[]>();
    listProfiles.mockResolvedValueOnce([profile("loaded")]).mockReturnValueOnce(pending.promise);
    const target: RendererConfigurationTarget = { sessionId: "session-a" };
    let available = true;
    let refreshKey = "chat";
    const hook = await renderHook(() =>
      useSessionWorkspaceProfiles({
        configurationAvailable: available,
        configurationTarget: target,
        refreshKey,
      }),
    );
    cleanup = hook.unmount;
    expect(hook.result.current.map((entry) => entry.name)).toEqual(["loaded"]);

    refreshKey = "digital-humans";
    await hook.rerender();
    available = false;
    await hook.rerender();
    expect(hook.result.current).toEqual([]);
    await act(async () => {
      pending.resolve([profile("stale")]);
      await flushMicrotasks();
    });
    expect(hook.result.current).toEqual([]);
    expect(listProfiles).toHaveBeenCalledTimes(2);
  });

  test("refreshes on page changes and clears the old list when a refresh rejects", async () => {
    listProfiles
      .mockResolvedValueOnce([profile("loaded")])
      .mockRejectedValueOnce(new Error("bridge unavailable"));
    const target: RendererConfigurationTarget = { projectId: "project-a" };
    let refreshKey = "chat";
    const hook = await renderHook(() =>
      useSessionWorkspaceProfiles({
        configurationAvailable: true,
        configurationTarget: target,
        refreshKey,
      }),
    );
    cleanup = hook.unmount;
    expect(hook.result.current).toHaveLength(1);

    await hook.rerender();
    expect(listProfiles).toHaveBeenCalledTimes(1);
    refreshKey = "digital-humans";
    await hook.rerender();
    expect(listProfiles).toHaveBeenCalledTimes(2);
    expect(hook.result.current).toEqual([]);
  });

  test("clears choices if the bridge no longer supports listing profiles", async () => {
    listProfiles.mockResolvedValueOnce([profile("loaded")]);
    const target: RendererConfigurationTarget = { projectId: "project-a" };
    let refreshKey = "chat";
    const hook = await renderHook(() =>
      useSessionWorkspaceProfiles({
        configurationAvailable: true,
        configurationTarget: target,
        refreshKey,
      }),
    );
    cleanup = hook.unmount;
    expect(hook.result.current).toHaveLength(1);

    Reflect.deleteProperty(window.codeshell, "listProfiles");
    refreshKey = "digital-humans";
    await hook.rerender();
    expect(hook.result.current).toEqual([]);
  });
});
