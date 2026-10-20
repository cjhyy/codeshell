import { afterEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fileURLToPath } from "node:url";
import { ensureMiniDom, flushMicrotasks } from "../../../packages/desktop/src/renderer/test-utils/renderHook";

ensureMiniDom();
let deniedFetches = 0;
globalThis.fetch = (() => { deniedFetches++; throw new Error("Pure renderer audit denies fetch"); }) as typeof fetch;
const source = (path: string) => fileURLToPath(new URL(`../../../packages/desktop/src/renderer/${path}`, import.meta.url));
const passthrough = ({ children }: any) => <div>{children}</div>;
mock.module(source("i18n/I18nProvider.tsx"), () => ({ useT: () => ({ t: (key: string) => key, lang: "zh" }) }));
mock.module(source("ui/ConfirmDialog.tsx"), () => ({ useConfirm: () => async () => true }));
mock.module(source("settings/ProfileMemoryPromotionDialog.tsx"), () => ({ ProfileMemoryPromotionDialog: () => null }));
mock.module(source("settings/ProjectPicker.tsx"), () => ({ ProjectPicker: () => null }));
mock.module(source("settingsBus.ts"), () => ({ writeSettings: async () => {} }));
mock.module(source("components/ui/button.tsx"), () => ({ Button: ({ children, variant: _variant, size: _size, ...props }: any) => <button {...props}>{children}</button> }));
mock.module(source("components/ui/checkbox.tsx"), () => ({ Checkbox: () => null }));
mock.module(source("components/ui/simple-select.tsx"), () => ({ SimpleSelect: () => null }));
mock.module(source("components/ui/switch.tsx"), () => ({ Switch: () => null }));
mock.module(source("components/ui/input.tsx"), () => ({ Input: (props: any) => <input {...props} /> }));
mock.module(source("components/ui/textarea.tsx"), () => ({ Textarea: (props: any) => <textarea {...props} /> }));

const roots: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(async () => {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function entry(scope: "user" | "dream") {
  return {
    id: `mem-${scope}`, name: `Owned ${scope} entry`, description: "Owned in-memory fixture",
    type: "project", content: `${scope} body`, fileName: `${scope}.md`, scope, level: "project",
    origin: scope === "user" ? "manual" : "dream", pinned: false,
  };
}
function nodes(node: any): any[] { return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)]; }
function props(node: any): any {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(text).join("") : node.textContent ?? "";
}
async function update(action: () => void) {
  await act(async () => { action(); await flushMicrotasks(); await flushMicrotasks(); });
}

test("audit D04: late pin completion refreshes user entries into selected dream scope", async () => {
  const pinRead = deferred<ReturnType<typeof entry>>();
  const listCalls: string[] = [];
  const saveCalls: any[] = [];
  Object.assign(window, { codeshell: {
    listMemory: async (_level: string, scope: "user" | "dream") => { listCalls.push(scope); return [entry(scope)]; },
    readMemory: async () => pinRead.promise,
    saveMemory: async (input: any) => { saveCalls.push(input); },
  } });
  const { MemoryStoreView } = await import("../../../packages/desktop/src/renderer/settings/MemorySection");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container); roots.push({ root, container });
  await update(() => root.render(<MemoryStoreView level="project" cwd="/owned-fixture" />));
  const button = (key: string) => nodes(container).find((node) => node.tagName === "BUTTON" && (props(node)["aria-label"] === key || text(node) === key));
  expect(text(container)).toContain("Owned user entry");
  await update(() => props(button("settingsX.memory.pin")).onClick());
  expect(saveCalls).toEqual([]);
  const dreamButton = button("settingsX.memory.scopeDreamLabel");
  expect(props(dreamButton).disabled).toBe(false);
  await update(() => props(dreamButton).onClick());
  expect(text(container)).toContain("Owned dream entry");
  expect(text(container)).not.toContain("Owned user entry");
  await update(() => pinRead.resolve(entry("user")));
  const after = text(container);
  console.log("D04", JSON.stringify({ listCalls, savedScopes: saveCalls.map((call) => call.scope), afterContainsUser: after.includes("Owned user entry"), afterContainsDream: after.includes("Owned dream entry") }));
  expect(listCalls).toEqual(["user", "dream", "user"]);
  expect(saveCalls.map((call) => call.scope)).toEqual(["user"]);
  expect(after).toContain("Owned user entry");
  expect(after).not.toContain("Owned dream entry");
  expect(props(button("settingsX.memory.scopeDreamLabel")).variant).toBeUndefined();
  // All bridge operations are memory-only stubs; no disk mutation or IPC runs.
  expect(deniedFetches).toBe(0);
});
