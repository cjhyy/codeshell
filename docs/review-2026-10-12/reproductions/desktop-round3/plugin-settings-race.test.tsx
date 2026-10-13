import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "../../../../packages/desktop/node_modules/react-dom/client";
import {
  ensureMiniDom,
  flushMicrotasks,
} from "../../../../packages/desktop/src/renderer/test-utils/renderHook";

ensureMiniDom();
const { ManagePage } =
  await import("../../../../packages/desktop/src/renderer/extensions/ManagePage");
const { DialogProvider } =
  await import("../../../../packages/desktop/src/renderer/ui/DialogProvider");
let root: any;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = undefined;
});
function nodes(node: any): any[] {
  return [node, ...Array.from(node?.childNodes ?? []).flatMap(nodes)];
}
function props(node: any): any {
  const key = Object.keys(node).find((x) => x.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function plugin(name: string): any {
  return {
    name,
    displayName: name,
    installKey: `${name}@local`,
    marketplace: null,
    sourceLabel: "Local",
    installPath: "/fixture/" + name,
    installedAt: "fixture",
    version: "1",
    skillCount: 0,
    mediaAvailability: { composerIcon: false, logo: false, logoDark: false },
  };
}
test("CONFIRMED toggling before the skill scan completes re-enables an unrelated disabled plugin", async () => {
  let resolveSkills: any;
  const skills = new Promise((resolve) => (resolveSkills = resolve));
  let disk: any = { disabledPlugins: ["alpha"], disabledSkills: ["alpha:skill"] };
  const writes: any[] = [];
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  });
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      listSkills: () => skills,
      getSettings: async () => structuredClone(disk),
      listPlugins: async () => [plugin("alpha"), plugin("beta")],
      checkPluginUpdate: async () => ({ updateAvailable: false }),
      updateSettings: async (_scope, patch) => {
        writes.push(patch);
        disk = { ...disk, ...patch };
      },
    },
  });
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root.render(
      <DialogProvider>
        <ManagePage
          cwd="/fixture"
          configurationTarget={{ noRepo: true }}
          activeProjectPath={null}
        />
      </DialogProvider>,
    );
    await flushMicrotasks();
  });
  const switches = () => nodes(container).filter((node) => props(node).role === "switch");
  expect(switches()).toHaveLength(2);
  // The list is interactive although global enable/disable settings are held
  // behind Promise.all's pending skill scan. alpha is disabled on disk.
  expect(props(switches()[0])["aria-checked"]).toBe(true);
  expect(props(switches()[1])["aria-checked"]).toBe(true);
  await act(async () => {
    props(switches()[1]).onClick({ defaultPrevented: false, stopPropagation() {} });
    await flushMicrotasks();
  });
  expect(writes).toHaveLength(1);
  expect(disk.disabledPlugins).toEqual(["beta"]);
  expect(disk.disabledSkills).toEqual([]);
  // When the older refresh finally completes, it also paints beta enabled
  // despite the just-persisted disabled state.
  await act(async () => {
    resolveSkills([
      {
        name: "alpha:skill",
        source: "plugin",
        filePath: "/fixture/alpha/SKILL.md",
        description: "fixture",
      },
    ]);
    await flushMicrotasks();
  });
  expect(props(switches()[0])["aria-checked"]).toBe(false);
  expect(props(switches()[1])["aria-checked"]).toBe(true);
  console.log(
    JSON.stringify({
      persistedAfterDisablingBeta: disk,
      painted: {
        alpha: props(switches()[0])["aria-checked"],
        beta: props(switches()[1])["aria-checked"],
      },
      writes,
    }),
  );
});
