import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const forbidden = (..._args: any[]) => { throw new Error("NETWORK_FORBIDDEN_round10"); };
globalThis.fetch = forbidden as any;
http.request = http.get = forbidden as any;
https.request = https.get = forbidden as any;
net.connect = net.createConnection = forbidden as any;
tls.connect = forbidden as any;
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) {
  throw new Error("guarded HOME required");
}
import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
const { createRoot } = await import("../../../../packages/desktop/node_modules/react-dom/client");
const {
  ensureMiniDom,
  flushMicrotasks,
} = await import("../../../../packages/desktop/src/renderer/test-utils/renderHook");

ensureMiniDom();
const { ManagePage } =
  await import("../../../../packages/desktop/src/renderer/extensions/ManagePage");
const { DialogProvider } =
  await import("../../../../packages/desktop/src/renderer/ui/DialogProvider");
const { readSettings, writeSettings: nativeWriteSettings } = await import("../../../../packages/desktop/src/main/settings-service");
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
  await nativeWriteSettings("user", disk);
  const writes: any[] = [];
  const ipcOrder: string[] = [];
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
      listSkills: () => { ipcOrder.push("skills:list"); return skills; },
      getSettings: async () => { ipcOrder.push("settings:get"); return structuredClone(disk); },
      listPlugins: async () => { ipcOrder.push("plugins:list"); return [plugin("alpha"), plugin("beta")]; },
      checkPluginUpdate: async () => ({ updateAvailable: false }),
      updateSettings: async (_scope, patch) => {
        writes.push(patch);
        await nativeWriteSettings("user", patch);
        disk = await readSettings("user");
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
  expect(ipcOrder.slice(0, 3)).toEqual(["plugins:list", "skills:list", "settings:get"]);
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
      ipcOrder,
      persistedAfterDisablingBeta: disk,
      painted: {
        alpha: props(switches()[0])["aria-checked"],
        beta: props(switches()[1])["aria-checked"],
      },
      writes,
    }),
  );
});
test("CONTROL after initial authoritative load toggling beta preserves disabled alpha and its skill", async () => {
  let resolveSkills: any;
  const skills = Promise.resolve([{name: "alpha:skill", source: "plugin", filePath: "/fixture/alpha/SKILL.md", description: "fixture"}]);
  let disk: any = { disabledPlugins: ["alpha"], disabledSkills: ["alpha:skill"] };
  await nativeWriteSettings("user", disk);
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
        await nativeWriteSettings("user", patch);
        disk = await readSettings("user");
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
  expect(props(switches()[0])["aria-checked"]).toBe(false);
  expect(props(switches()[1])["aria-checked"]).toBe(true);
  await act(async () => {
    props(switches()[1]).onClick({ defaultPrevented: false, stopPropagation() {} });
    await flushMicrotasks();
  });
  expect(writes).toHaveLength(1);
  expect(disk.disabledPlugins).toEqual(["alpha", "beta"]);
  expect(disk.disabledSkills).toEqual(["alpha:skill"]);
  expect(props(switches()[0])["aria-checked"]).toBe(false);
  expect(props(switches()[1])["aria-checked"]).toBe(false);
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
