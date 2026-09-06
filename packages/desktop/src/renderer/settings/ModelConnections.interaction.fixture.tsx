// Fresh process: renderer suites elsewhere mock Dialog/Select modules globally.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
window.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number;
window.cancelAnimationFrame = (id) => clearTimeout(id);
const scenario = process.argv[2];
const en = scenario.endsWith("-en");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => (en ? "en" : "zh"), setItem() {} },
});
const { TextConnectionsPanel } = await import("./TextConnectionsPanel");
const { DialogProvider } = await import("../ui/DialogProvider");
const { ToastProvider } = await import("../ui/ToastProvider");
const fakeKey = "synthetic-test-key";
const primary = {
  id: "primary",
  catalogId: "fixture-provider",
  tag: "text",
  model: "fixture-model",
};
const secondary = { ...primary, id: "secondary", credentialId: "existing" };
let stored: Record<string, any> = {
  modelConnections: [primary, secondary],
  credentials: [{ id: "existing", catalogId: "fixture-provider", apiKey: "synthetic-existing" }],
  defaults: { text: "primary" },
};
const writes: Array<{ patch: Record<string, any>; resolve: () => void; reject: () => void }> = [];
let catalogReads = 0;
let releaseStaleCatalog: (() => void) | undefined;
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    getModelCatalog: async () => {
      if (++catalogReads === 2 && scenario === "save-late-readback") {
        await new Promise<void>((resolve) => {
          releaseStaleCatalog = resolve;
        });
      }
      return [
        {
          id: "fixture-provider",
          tag: "text",
          displayName: "Fixture Provider",
          needsKey: true,
          modelPresets: [{ value: "fixture-model" }],
        },
      ];
    },
    getSettings: async () => structuredClone(stored),
    updateSettings: (_scope: string, patch: Record<string, any>) =>
      new Promise<void>((resolve, reject) => {
        writes.push({
          patch: structuredClone(patch),
          resolve: () => {
            stored = { ...stored, ...patch };
            resolve();
          },
          reject: () => reject(new Error(`Persistence failed: ${fakeKey}`)),
        });
      }),
  },
});
function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
}
function card(id = "primary") {
  return nodes(container).find(
    (node) => node.tagName === "ARTICLE" && textOf(node).includes(`#${id}`),
  );
}
function form() {
  return nodes(container).find((node) => node.tagName === "FIELDSET");
}
function input(id = "primary") {
  return nodes(card(id)).find(
    (node) => node.tagName === "INPUT" && ["password", "text"].includes(props(node).type),
  );
}
function button(parent: any, label: string) {
  const found = nodes(parent).find((node) => node.tagName === "BUTTON" && textOf(node) === label);
  assert.ok(found, `Missing action: ${label}`);
  return found;
}
async function click(node: any) {
  await update(() => props(node).onClick());
}
async function typeKey(value: string) {
  const original = input();
  assert.ok(original);
  original.focus();
  for (let end = 1; end <= value.length; end += 1) {
    await update(() => props(original).onChange({ target: { value: value.slice(0, end) } }));
    assert.ok(input() === original, "New key input must remain mounted across credential binding");
    assert.ok(
      props(original).value === value.slice(0, end),
      "Every typed character stays in the draft",
    );
    assert.ok(document.activeElement === original, "Typing must preserve keyboard focus");
  }
}
async function chooseCredential(id: string, value: string) {
  const select = nodes(card(id)).find(
    (node) =>
      node.tagName === "SELECT" &&
      nodes(node).some((option) => props(option).value === "__simple_select_empty__"),
  );
  assert.ok(select, "The credential selector is available");
  await update(() =>
    props(select).onChange({ target: { value: value || "__simple_select_empty__" } }),
  );
}
async function confirmDelete() {
  await click(button(card(), en ? "Delete" : "删除"));
  const dialog = nodes(document.body).find((node) => props(node).role === "dialog");
  assert.ok(dialog, "Deletion still requires the real confirmation dialog");
  await click(button(dialog, en ? "OK" : "确定"));
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
try {
  await update(() =>
    root.render(
      <DialogProvider>
        <ToastProvider>
          <form>
            <TextConnectionsPanel scope="user" activeProjectPath={null} />
          </form>
        </ToastProvider>
      </DialogProvider>,
    ),
  );
  assert.ok(card() && card("secondary"));
  if (scenario === "key-typing") {
    await typeKey(fakeKey);
    assert.equal(writes.length, 0, "Typing does not persist credentials");
    const keyInput = input();
    const eye = nodes(card()).find((node) => props(node)["aria-label"] === "显示 key");
    assert.ok(eye);
    await click(eye);
    assert.ok(
      input() === keyInput && props(keyInput).type === "text",
      "Visibility toggle keeps the editable input",
    );
    await update(() => props(keyInput).onChange({ target: { value: "" } }));
    assert.ok(
      input() === keyInput && props(keyInput).value === "",
      "Clearing a draft keeps the field usable",
    );
    await typeKey(fakeKey);
  } else if (["key-paste-save", "key-typing-save", "save-other-card"].includes(scenario)) {
    if (scenario === "key-paste-save") {
      await update(() => props(input()).onChange({ target: { value: fakeKey } }));
    } else await typeKey(fakeKey);
    assert.ok(input(), "A new credential remains editable before committing");
    await click(button(card(scenario === "save-other-card" ? "secondary" : "primary"), "保存"));
    await update(() => writes[0].resolve());
    assert.ok(!input(), "Any successful panel save ends the new credential edit session");
    const committedId = stored.modelConnections.find(
      (entry: any) => entry.id === "primary",
    ).credentialId;
    await chooseCredential("secondary", committedId);
    await click(button(card("secondary"), "保存"));
    await update(() => writes[1].resolve());
    assert.ok(
      stored.modelConnections.every((entry: any) => entry.credentialId === committedId),
      "A second connection can reuse the committed credential",
    );
    assert.ok(!input() && !input("secondary"), "Neither sharing connection can edit a saved key");
    assert.ok(
      stored.credentials.find((entry: any) => entry.id === committedId).apiKey === fakeKey,
      "Sharing a credential leaves its complete value unchanged",
    );
  } else if (scenario === "credential-switch") {
    await typeKey(fakeKey);
    await chooseCredential("primary", "existing");
    assert.ok(!input(), "Choosing an existing credential ends new key editing");
    await chooseCredential("primary", "fixture-provider-key");
    assert.ok(!input(), "Choosing the draft credential again does not resume its old edit session");
  } else if (scenario === "save-late-readback") {
    await typeKey(fakeKey);
    await click(button(card(), "保存"));
    assert.equal(
      props(form()).disabled,
      true,
      "All cards are locked during the shared settings write",
    );
    await update(() => writes[0].resolve());
    assert.equal(
      props(form()).disabled,
      false,
      "The form unlocks after the final current readback",
    );
    assert.ok(releaseStaleCatalog, "The earlier automatic refresh is still pending");
    assert.ok(!input(), "A committed credential is no longer editable");
    await chooseCredential("primary", "");
    const nextDraft = fakeKey + "-after-save";
    await update(() => props(input()).onChange({ target: { value: nextDraft } }));
    await update(() => releaseStaleCatalog!());
    assert.ok(
      props(input()).value === nextDraft,
      "A delayed earlier refresh cannot erase edits made after save completed",
    );
  } else if (scenario.startsWith("save-retry")) {
    await typeKey(fakeKey);
    await click(button(card(), en ? "Save" : "保存"));
    assert.equal(writes.length, 1);
    assert.equal(props(form()).disabled, true);
    assert.ok(input(), "Pending save keeps the draft visible");
    await update(() => writes[0].reject());
    assert.equal(props(form()).disabled, false, "Failed save unlocks the retained draft for retry");
    assert.ok(textOf(container).includes(en ? "Your edits are kept" : "编辑内容已保留"));
    assert.ok(
      !textOf(container).includes(fakeKey),
      "Failure feedback must not echo credential data",
    );
    assert.ok(props(input()).value === fakeKey, "Failed save retains the complete key draft");
    const revised = fakeKey + "-revised";
    await update(() => props(input()).onChange({ target: { value: revised } }));
    await click(button(card(), en ? "Save" : "保存"));
    assert.equal(writes.length, 2);
    const primaryWrite = writes[1].patch.modelConnections.find(
      (entry: any) => entry.id === "primary",
    );
    const keyWrite = writes[1].patch.credentials.find(
      (entry: any) => entry.id === primaryWrite.credentialId,
    );
    assert.ok(
      keyWrite.apiKey === revised,
      "Retry persists the latest draft, not the failed snapshot",
    );
    assert.ok(
      writes[1].patch.credentials.find((entry: any) => entry.id === "existing").apiKey ===
        "synthetic-existing",
      "Editing a new key leaves existing credentials unchanged",
    );
    await update(() => writes[1].resolve());
    assert.ok(textOf(container).includes(en ? "Saved" : "已保存"));
    assert.ok(!input(), "Successful retry ends editing only after persistence succeeds");
  } else if (scenario.startsWith("delete-retry")) {
    await confirmDelete();
    assert.equal(writes.length, 1);
    assert.equal(props(form()).disabled, true, "Pending deletion locks other cards too");
    assert.ok(card(), "Pending delete must not remove the record prematurely");
    assert.ok(
      textOf(card()).includes(en ? "Current" : "当前"),
      "Pending delete retains the current selection",
    );
    await update(() => writes[0].reject());
    assert.equal(props(form()).disabled, false, "Failed deletion restores card interaction");
    assert.ok(
      card() && textOf(card()).includes(en ? "Current" : "当前"),
      "Failed delete preserves the record and default",
    );
    assert.ok(
      textOf(container).includes(
        en ? "Could not remove the model connection" : "删除失败，模型连接已保留",
      ),
    );
    assert.ok(!textOf(container).includes(fakeKey), "Delete failure must not echo credential data");
    await confirmDelete();
    assert.equal(writes.length, 2);
    await update(() => writes[1].resolve());
    assert.ok(
      !card() && card("secondary"),
      "Successful retry removes only the selected connection",
    );
    assert.ok(stored.defaults.text === "secondary", "The existing next-default rule stays intact");
    assert.ok(stored.credentials.length === 1, "Removing a connection retains its credentials");
  } else throw new Error(`Unknown scenario: ${scenario}`);
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
