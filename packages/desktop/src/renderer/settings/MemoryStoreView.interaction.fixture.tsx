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
const readNames: string[] = [];
const saveCalls: SaveMemoryInput[] = [];
let pinStarted = false;
let userPinned = false;
function entry(scope: MemoryScope, second = false): RendererMemoryEntryFull {
  return {
    id: `mem-${scope}${second ? "-b" : ""}`,
    name: `Owned ${scope} entry${second ? " B" : ""}`,
    description: `Owned ${scope} description`,
    type: "project",
    content: `Owned ${scope} body${second ? " B" : ""}`,
    fileName: `${scope}${second ? "-b" : ""}.md`,
    scope,
    level: "project",
    origin: scope === "user" ? "manual" : "dream",
    pinned: scope === "user" && !second && userPinned,
  };
}
Object.assign(window, {
  codeshell: {
    listMemory: async (_level: string, scope: MemoryScope) => {
      listCalls.push(scope);
      if (scenario === "late-refresh-selected" && scope === "user" && listCalls.length === 2)
        return pinRefresh.promise;
      return scenario === "same-scope-selection-change"
        ? [entry(scope), entry(scope, true)]
        : [entry(scope)];
    },
    readMemory: async (_level: string, scope: MemoryScope, name: string) => {
      readCalls.push(scope);
      readNames.push(name);
      if (
        pinStarted &&
        scope === "user" &&
        !name.endsWith(" B") &&
        [
          "late-read",
          "late-read-error",
          "return-to-original-scope",
          "same-scope-selection-change",
          "same-scope-draft",
          "same-scope-open-draft",
          "same-scope-close",
        ].includes(scenario)
      )
        return pinRead.promise;
      return entry(scope, name.endsWith(" B"));
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
  const selectedBeforePin = [
    "late-refresh-selected",
    "same-scope-selected",
    "same-scope-selection-change",
    "same-scope-draft",
    "same-scope-open-draft",
    "same-scope-close",
  ].includes(scenario);
  if (selectedBeforePin) await click("Owned user entry", true);
  if (scenario === "same-scope-open-draft") await click("settingsX.memory.edit");
  pinStarted = true;
  await click("settingsX.memory.pin");
  assert.equal(
    readCalls.filter((scope) => scope === "user").length,
    selectedBeforePin ? (scenario === "same-scope-selected" ? 3 : 2) : 1,
  );

  if (["same-scope", "same-scope-selected"].includes(scenario)) {
    assert.deepEqual(listCalls, ["user", "user"]);
    assert.ok(button("settingsX.memory.unpin"));
    if (scenario === "same-scope-selected") assert.ok(text(container).includes("Owned user body"));
  } else if (
    [
      "same-scope-selection-change",
      "same-scope-draft",
      "same-scope-open-draft",
      "same-scope-close",
    ].includes(scenario)
  ) {
    if (scenario === "same-scope-selection-change") {
      await click("Owned user entry B", true);
      assert.ok(text(container).includes("Owned user body B"));
    } else if (scenario === "same-scope-close") {
      await click("close");
      assert.ok(text(container).includes("settingsX.memory.emptyDetail"));
    } else {
      if (scenario === "same-scope-draft") await click("settingsX.memory.edit");
      const textarea = nodes(container).find((node) => node.tagName === "TEXTAREA");
      assert.ok(textarea, "The selected entry's editor must be reachable while pin is pending");
      await update(() => props(textarea).onChange({ target: { value: "Owned unsaved draft" } }));
    }
    const readsBeforeCompletion = [...readNames];
    await update(() => pinRead.resolve(entry("user")));
    assert.deepEqual(listCalls, ["user", "user"], "The successful pin still refreshes its list");
    if (scenario === "same-scope-selection-change") {
      assert.ok(
        text(container).includes("Owned user body B"),
        "Pin must preserve the new selection",
      );
    } else if (scenario === "same-scope-close") {
      assert.ok(
        text(container).includes("settingsX.memory.emptyDetail"),
        "Pin must not reopen closed details",
      );
    } else {
      const textarea = nodes(container).find((node) => node.tagName === "TEXTAREA");
      assert.ok(textarea, "Pin must not close the editor");
      assert.equal(props(textarea).value, "Owned unsaved draft", "Pin must preserve unsaved text");
    }
    assert.deepEqual(readNames, readsBeforeCompletion, "Pin must not reload the prior selection");
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
      readNames,
      savedScopes: saveCalls.map((saved) => saved.scope),
      deniedFetches,
      unhandled,
    }),
  );
} finally {
  await act(async () => root.unmount());
  container.parentNode?.removeChild(container);
}
