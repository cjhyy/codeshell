import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { loadOverrideMap } from "../transcripts";
import { renderHook } from "../test-utils/renderHook";
import { useBucketOverrides } from "./useBucketOverrides";

let savedStorage: PropertyDescriptor | undefined;
const hooks: Array<{ unmount: () => Promise<void> }> = [];

beforeEach(() => {
  savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
});

afterEach(async () => {
  for (const hook of hooks.splice(0)) await hook.unmount();
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("a second window saving its Session model keeps the first window's saved model", async () => {
  // Both windows are open (and have read the shared map) before either saves.
  const windowA = await renderHook(useBucketOverrides);
  const windowB = await renderHook(useBucketOverrides);
  hooks.push(windowA, windowB);

  await act(async () => {
    windowA.result.current.setModelOverrides((prev) => ({ ...prev, "p::s1": "model-a" }));
  });
  await act(async () => {
    windowB.result.current.setModelOverrides((prev) => ({ ...prev, "p::s2": "model-b" }));
  });

  expect(loadOverrideMap<string>("model")).toEqual({ "p::s1": "model-a", "p::s2": "model-b" });

  // A window clearing its own choice removes only that entry.
  await act(async () => {
    windowB.result.current.setModelOverrides(({ "p::s2": _drop, ...rest }) => rest);
  });
  expect(loadOverrideMap<string>("model")).toEqual({ "p::s1": "model-a" });
});

test("a window adopts another window's saved choice and keeps its own draft choice", async () => {
  const windowA = await renderHook(useBucketOverrides);
  hooks.push(windowA);
  await act(async () => {
    windowA.result.current.setModelOverrides({ "p::_none_": "draft-model" });
  });

  localStorage.setItem("codeshell.overrides.model", JSON.stringify({ "p::s2": "model-b" }));
  await act(async () => {
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "codeshell.overrides.model" }));
  });

  expect(windowA.result.current.modelOverrides).toEqual({
    "p::s2": "model-b",
    "p::_none_": "draft-model",
  });
});
