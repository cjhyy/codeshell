// Per-process widget mocks stay isolated from the other settings tests.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { MemoryScope, RendererMemoryEntryFull, SaveMemoryInput } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
let deniedFetches = 0;
globalThis.fetch = (() => {
  deniedFetches++;
  throw new Error("Memory pin renderer fixture denies fetch");
}) as unknown as typeof fetch;
const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.HOME && process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));

mock.module("../i18n/I18nProvider", () => ({
  useT: () => ({ t: (key: string) => key, lang: "zh" }),
}));
mock.module("../ui/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
mock.module("./ProfileMemoryPromotionDialog", () => ({ ProfileMemoryPromotionDialog: () => null }));
mock.module("./ProjectPicker", () => ({ ProjectPicker: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const scenario = process.argv[2];
const pinRead = deferred<RendererMemoryEntryFull>();
const pinSave = deferred<void>();
const pinRefresh = deferred<RendererMemoryEntryFull[]>();
const listCalls: MemoryScope[] = [];
const readCalls: MemoryScope[] = [];
const saveCalls: SaveMemoryInput[] = [];
let pinStarted = false;
let userPinned = false;
function entry(scope: MemoryScope): RendererMemoryEntryFull {
  return {
    id: `mem-${scope}`,
    name: `Owned ${scope} entry`,
    description: `Owned ${scope} description`,
    type: "project",
    content: `Owned ${scope} body`,
    fileName: `${scope}.md`,
    scope,
    level: "project",
    origin: scope === "user" ? "manual" : "dream",
    pinned: scope === "user" && userPinned,
  };
}
Object.assign(window, {
  codeshell: {
    listMemory: async (_level: string, scope: MemoryScope) => {
      listCalls.push(scope);
      if (scenario === "late-refresh-selected" && scope === "user" && listCalls.length === 2)
        return pinRefresh.promise;
      return [entry(scope)];
    },
    readMemory: async (_level: string, scope: MemoryScope) => {
      readCalls.push(scope);
      if (
        pinStarted &&
        scope === "user" &&
        ["late-read", "late-read-error", "return-to-original-scope"].includes(scenario)
      )
        return pinRead.promise;
      return entry(scope);
    },
    saveMemory: async (input: SaveMemoryInput) => {
      saveCalls.push(structuredClone(input));
      if (["late-save", "late-save-error"].includes(scenario)) await pinSave.promise;
      userPinned = input.pinned === true;
    },
  },
});
const { MemoryStoreView } = await import("./MemorySection");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const nodes = (node: any): any[] => [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(text).join("") : (node.textContent ?? "");
}
function button(label: string, startsWith = false) {
  const found = nodes(container).find(
    (node) =>
      node.tagName === "BUTTON" &&
      (props(node)["aria-label"] === label ||
        (startsWith ? text(node).startsWith(label) : text(node) === label)),
  );
  assert.ok(found, `Expected rendered button: ${label}`);
  return found;
}
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function click(label: string, startsWith = false) {
  const control = button(label, startsWith);
  assert.notEqual(props(control).disabled, true, "The user must be able to click this control");
  await update(() => props(control).onClick());
}
try {
  await update(() => root.render(<MemoryStoreView level="project" cwd="/owned-fixture" />));
  assert.ok(text(container).includes("Owned user entry"));
  if (scenario === "late-refresh-selected") await click("Owned user entry", true);
  pinStarted = true;
  await click("settingsX.memory.pin");
  assert.equal(
    readCalls.filter((scope) => scope === "user").length,
    scenario === "late-refresh-selected" ? 2 : 1,
  );

  if (scenario === "same-scope") {
    assert.deepEqual(listCalls, ["user", "user"]);
    assert.ok(button("settingsX.memory.unpin"));
  } else {
    await click("settingsX.memory.scopeDreamLabel");
    assert.ok(text(container).includes("Owned dream entry"));
    assert.ok(!text(container).includes("Owned user entry"));
    if (scenario === "late-refresh-selected") {
      await click("Owned dream entry", true);
      assert.ok(text(container).includes("Owned dream body"));
    }
    if (scenario === "return-to-original-scope") await click("settingsX.memory.scopeUserLabel");
    const listsBeforeCompletion = [...listCalls];
    const readsBeforeCompletion = [...readCalls];
    await update(() => {
      if (["late-read", "return-to-original-scope"].includes(scenario))
        pinRead.resolve(entry("user"));
      else if (scenario === "late-save") pinSave.resolve();
      else if (scenario === "late-read-error") pinRead.reject(new Error("Owned old read failed"));
      else if (scenario === "late-save-error") pinSave.reject(new Error("Owned old save failed"));
      else if (scenario === "late-refresh-selected") pinRefresh.resolve([entry("user")]);
      else throw new Error("Unknown memory pin scenario");
    });
    assert.deepEqual(listCalls, listsBeforeCompletion, "Old pin must not refresh another view");
    assert.deepEqual(readCalls, readsBeforeCompletion, "Old pin must not reopen another selection");
    const currentScope = scenario === "return-to-original-scope" ? "user" : "dream";
    assert.ok(text(container).includes(`Owned ${currentScope} entry`));
    assert.ok(!text(container).includes("Owned old read failed"));
    assert.ok(!text(container).includes("Owned old save failed"));
    if (scenario === "late-refresh-selected")
      assert.ok(text(container).includes("Owned dream body"));
  }
  assert.equal(saveCalls.length, scenario === "late-read-error" ? 0 : 1);
  for (const saved of saveCalls) {
    assert.equal(saved.scope, "user");
    assert.equal(saved.cwd, "/owned-fixture");
    assert.equal(saved.id, "mem-user");
    assert.equal(saved.pinned, true);
  }
  assert.equal(deniedFetches, 0);
  assert.deepEqual(unhandled, []);
  console.log(
    JSON.stringify({
      scenario,
      passed: true,
      listCalls,
      readCalls,
      savedScopes: saveCalls.map((saved) => saved.scope),
      deniedFetches,
      unhandled,
    }),
  );
} finally {
  await act(async () => root.unmount());
  container.parentNode?.removeChild(container);
}
