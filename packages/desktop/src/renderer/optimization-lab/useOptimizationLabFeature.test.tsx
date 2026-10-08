import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import type { ViewState } from "../view";
import { useOptimizationLabFeature } from "./useOptimizationLabFeature";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
test("lab entry defaults hidden without discarding an enabled saved route before settings resolve", async () => {
  ensureMiniDom();
  const previous = Object.getOwnPropertyDescriptor(window, "codeshell");
  const reads: Array<(settings: unknown) => void> = [];
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: { getSettings: () => new Promise((resolve) => reads.push(resolve)) },
  });
  let settingsRevision = 0;
  const hook = await renderHook(() => {
    const [view, setView] = useState<ViewState>({
      viewMode: "optimization_lab",
      sidebarCollapsed: false,
      inspectorCollapsed: true,
    });
    return { view, enabled: useOptimizationLabFeature(settingsRevision, setView) };
  });
  cleanup = async () => {
    await hook.unmount();
    if (previous) Object.defineProperty(window, "codeshell", previous);
    else delete (window as any).codeshell;
  };
  expect(hook.result.current.enabled).toBe(false);
  expect(hook.result.current.view.viewMode).toBe("optimization_lab");
  settingsRevision++;
  await hook.rerender();
  await act(async () => {
    reads[1]!({ featureFlags: { optimization_lab: true } });
  });
  await act(async () => {
    reads[0]!({ featureFlags: { optimization_lab: false } });
  });
  expect(hook.result.current.enabled).toBe(true);
  expect(hook.result.current.view.viewMode).toBe("optimization_lab");
  settingsRevision++;
  await hook.rerender();
  await act(async () => {
    reads[2]!({});
  });
  expect(hook.result.current.enabled).toBe(false);
  expect(hook.result.current.view).toEqual({
    viewMode: "chat",
    sidebarCollapsed: false,
    inspectorCollapsed: true,
  });
});
