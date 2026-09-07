import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import type { ExternalRuntimeModelEntry } from "../../shared/external-runtime-models";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { useExternalRuntimeModels } from "./useExternalRuntimeModels";

const oldModels: ExternalRuntimeModelEntry[] = [
  {
    key: "codex/old-model",
    label: "Old model",
    provider: "codex",
    kind: "codex",
    maxContextTokens: 100_000,
  },
];
const newModels: ExternalRuntimeModelEntry[] = [
  { ...oldModels[0], key: "codex/new-model", label: "New model" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("external runtime model refresh", () => {
  let hook: Awaited<ReturnType<typeof renderHook<ExternalRuntimeModelEntry[]>>> | null;
  let enabled: boolean;
  let revision: number;
  let bridgeBefore: PropertyDescriptor | undefined;
  let hiddenBefore: PropertyDescriptor | undefined;
  let fetchModels: ReturnType<typeof mock<() => Promise<ExternalRuntimeModelEntry[]>>>;
  let pollCallback: () => Promise<void>;
  let timeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;
  let clearTimeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "clearTimeout">>;

  beforeEach(() => {
    ensureMiniDom();
    hook = null;
    enabled = true;
    revision = 0;
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    hiddenBefore = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      writable: true,
      value: false,
    });
    fetchModels = mock(async () => oldModels);
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: { externalRuntime: { models: fetchModels } },
    });
    timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation((handler) => {
      pollCallback = handler as () => Promise<void>;
      return 42 as unknown as ReturnType<typeof setTimeout>;
    });
    clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  });

  afterEach(async () => {
    await hook?.unmount();
    timeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
    if (hiddenBefore) Object.defineProperty(document, "hidden", hiddenBefore);
    else Reflect.deleteProperty(document, "hidden");
  });

  const mount = async () => {
    hook = await renderHook(() => useExternalRuntimeModels(enabled, revision));
  };
  const focus = async () => {
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
  };

  test("renders immediately while discovery is pending and coalesces focus events", async () => {
    const pending = deferred<ExternalRuntimeModelEntry[]>();
    fetchModels.mockImplementationOnce(() => pending.promise);
    await mount();
    expect(hook!.result.current).toEqual([]);
    expect(timeoutSpy).not.toHaveBeenCalled();
    await focus();
    await focus();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(oldModels));
    expect(hook!.result.current).toEqual(oldModels);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);

    fetchModels.mockResolvedValueOnce(newModels);
    await focus();
    expect(hook!.result.current).toEqual(newModels);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
  });

  test("preserves the last usable list on a failed refresh", async () => {
    await mount();
    fetchModels.mockRejectedValueOnce(new Error("bridge unavailable"));
    await focus();
    expect(hook!.result.current).toEqual(oldModels);
    fetchModels.mockResolvedValueOnce(newModels);
    await focus();
    expect(hook!.result.current).toEqual(newModels);
  });

  test("settings changes ignore stale responses and wait before querying again", async () => {
    const pending = deferred<ExternalRuntimeModelEntry[]>();
    const next = deferred<ExternalRuntimeModelEntry[]>();
    fetchModels.mockImplementationOnce(() => pending.promise);
    fetchModels.mockImplementationOnce(() => next.promise);
    await mount();
    revision++;
    await hook!.rerender();
    await focus();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(oldModels));
    expect(hook!.result.current).toEqual([]);
    expect(fetchModels).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(newModels));
    expect(hook!.result.current).toEqual(newModels);
  });

  test("polls every five minutes only while visible and refreshes when shown", async () => {
    await mount();
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 300_000);
    Object.assign(document, { hidden: true });
    await act(async () => pollCallback());
    await focus();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    Object.assign(document, { hidden: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchModels).toHaveBeenCalledTimes(2);
    await act(async () => pollCallback());
    expect(fetchModels).toHaveBeenCalledTimes(3);
  });

  test("waits for discovery completion before scheduling the next five-minute poll", async () => {
    await mount();
    const pending = deferred<ExternalRuntimeModelEntry[]>();
    fetchModels.mockImplementationOnce(() => pending.promise);
    let polling!: Promise<void>;
    await act(async () => {
      polling = pollCallback();
    });
    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    await focus();
    expect(fetchModels).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(newModels);
      await polling;
    });
    expect(hook!.result.current).toEqual(newModels);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 300_000);
  });

  test("disabling clears choices and ignores an outstanding response", async () => {
    await mount();
    const pending = deferred<ExternalRuntimeModelEntry[]>();
    fetchModels.mockImplementationOnce(() => pending.promise);
    await focus();
    enabled = false;
    await hook!.rerender();
    expect(hook!.result.current).toEqual([]);
    await act(async () => pending.resolve(newModels));
    expect(hook!.result.current).toEqual([]);
    await focus();
    expect(fetchModels).toHaveBeenCalledTimes(2);
    enabled = true;
    await hook!.rerender();
    expect(fetchModels).toHaveBeenCalledTimes(3);
    expect(hook!.result.current).toEqual(oldModels);
  });

  test("unmount cancels pending updates and removes timers and listeners", async () => {
    await mount();
    const pending = deferred<ExternalRuntimeModelEntry[]>();
    fetchModels.mockImplementationOnce(() => pending.promise);
    await focus();
    await hook!.unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(42);
    await focus();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await pollCallback();
      pending.resolve(newModels);
    });
    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(hook!.result.current).toEqual(oldModels);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
  });
});
