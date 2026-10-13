import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import type { CloudProjectBinding } from "../../shared/project-runtime";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import { useProjectRuntimeSelection } from "./useProjectRuntimeSelection";

const binding: CloudProjectBinding = {
  id: "binding-a",
  localProjectId: "a",
  origin: "https://cloud.example.com",
  environmentId: "environment-a",
  environmentName: "Cloud A",
  remoteProjectId: "remote-a",
  remoteProjectName: "Project A",
  createdAt: 1,
  updatedAt: 1,
};
let bridge: PropertyDescriptor | undefined;
let api: Record<string, any>;
let cleanup: (() => Promise<void>) | undefined;
function useHarness() {
  const [projectId, setProjectId] = useState<string | null>("a");
  return { ...useProjectRuntimeSelection(projectId), setProjectId };
}
beforeEach(() => {
  ensureMiniDom();
  bridge = Object.getOwnPropertyDescriptor(window, "codeshell");
  api = {
    listBindings: async (id: string) => (id === "a" ? [binding] : []),
    getSelection: async (id: string) => ({
      localProjectId: id,
      bindingId: id === "a" ? binding.id : null,
    }),
    select: async ({ localProjectId, bindingId }: any) => ({ localProjectId, bindingId }),
  };
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: { cloudEnvironment: api },
  });
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  if (bridge) Object.defineProperty(window, "codeshell", bridge);
  else delete (window as any).codeshell;
});
test("loading a different project cannot inherit the previous environment on failure", async () => {
  const hook = await renderHook(useHarness);
  cleanup = hook.unmount;
  expect(hook.result.current.selectedBinding).toEqual(binding);
  api.listBindings = async () => {
    throw new Error("store unavailable");
  };
  await act(async () => hook.result.current.setProjectId("b"));
  expect(hook.result.current.ready).toBe(false);
  expect(hook.result.current.bindings).toEqual([]);
  expect(hook.result.current.bindingId).toBeNull();
  expect(hook.result.current.error).toContain("store unavailable");
});
test("a delayed cloud selection callback cannot alter a newly selected project", async () => {
  const calls: unknown[] = [];
  api.select = async (input: unknown) => {
    calls.push(input);
    return input;
  };
  const hook = await renderHook(useHarness);
  cleanup = hook.unmount;
  const oldSelect = hook.result.current.select;
  await act(async () => hook.result.current.setProjectId("b"));
  await act(async () => oldSelect(binding.id));
  expect(calls).toEqual([]);
  expect(hook.result.current.ready).toBe(true);
  expect(hook.result.current.selectedBinding).toBeNull();
});
test("a stale picker refresh cannot invalidate the next project's pending runtime read", async () => {
  const hook = await renderHook(useHarness);
  cleanup = hook.unmount;
  const oldRefresh = hook.result.current.refresh;
  let complete!: (value: unknown) => void;
  api.getSelection = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  await act(async () => hook.result.current.setProjectId("b"));
  expect(hook.result.current.ready).toBe(false);
  await act(async () => oldRefresh());
  await act(async () => complete({ localProjectId: "b", bindingId: null }));
  expect(hook.result.current.ready).toBe(true);
  expect(hook.result.current.selectedBinding).toBeNull();
});
test("unknown persisted cloud selection fails closed instead of activating local", async () => {
  api.getSelection = async () => ({ localProjectId: "a", bindingId: "missing" });
  const hook = await renderHook(useHarness);
  cleanup = hook.unmount;
  expect(hook.result.current.ready).toBe(false);
  expect(hook.result.current.error).toContain("unavailable");
});
