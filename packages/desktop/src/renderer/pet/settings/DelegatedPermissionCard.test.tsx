import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../../test-utils/renderHook";
import type { DelegatedPermissionApi } from "./DelegatedPermissionCard";

// Radix layout effects bind at import time: install the DOM before the card loads.
ensureMiniDom();
const { DelegatedPermissionCard, useDelegatedPermissionSetting } =
  await import("./DelegatedPermissionCard");

function fakeApi(settings: unknown, failWrite = false) {
  const writes: Array<Record<string, unknown>> = [];
  const api: DelegatedPermissionApi = {
    readUserSettings: async () => settings,
    writeUserSettings: async (patch) => {
      writes.push(patch);
      if (failWrite) throw new Error("settings.json is read-only");
    },
  };
  return { api, writes };
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await flushMicrotasks();
  });
}

describe("Mimi settings › delegated work permissions", () => {
  test("shows the three choices with inherit selected by default", () => {
    const html = renderToStaticMarkup(<DelegatedPermissionCard api={fakeApi({}).api} />);
    expect(html).toContain('data-pet-setting="delegated-permission"');
    expect(html).toContain("派发工作的权限");
  });

  test.each([
    [{}, "inherit"],
    [{ pet: { delegatedPermissionMode: "auto" } }, "auto"],
    [{ pet: { delegatedPermissionMode: "ask" } }, "ask"],
    [{ pet: { delegatedPermissionMode: "bogus" } }, "inherit"],
    [null, "inherit"],
  ])("loads %j as %s", async (settings, expected) => {
    const { api } = fakeApi(settings);
    const hook = await renderHook(() => useDelegatedPermissionSetting(api));
    await settle();
    expect(hook.result.current.mode).toBe(expected as never);
    await hook.unmount();
  });

  test("saves a choice to the user layer immediately", async () => {
    const { api, writes } = fakeApi({});
    const hook = await renderHook(() => useDelegatedPermissionSetting(api));
    await settle();
    await act(async () => hook.result.current.select("auto"));
    await settle();
    expect(hook.result.current.mode).toBe("auto");
    expect(writes).toEqual([{ pet: { delegatedPermissionMode: "auto" } }]);
    expect(hook.result.current.saveError).toBe("");
    await hook.unmount();
  });

  test("reverts the choice and reports a failed save", async () => {
    const { api } = fakeApi({ pet: { delegatedPermissionMode: "ask" } }, true);
    const hook = await renderHook(() => useDelegatedPermissionSetting(api));
    await settle();
    await act(async () => hook.result.current.select("auto"));
    await settle();
    expect(hook.result.current.mode).toBe("ask");
    expect(hook.result.current.saveError).toBe("settings.json is read-only");
    await hook.unmount();
  });
});
