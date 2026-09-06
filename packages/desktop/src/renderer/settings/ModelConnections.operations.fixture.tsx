// Run in a fresh process to keep renderer module mocks isolated.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
window.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number;
window.cancelAnimationFrame = (id) => clearTimeout(id);
const operation = process.argv[2];
const en = process.argv[3] === "en";
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => (en ? "en" : "zh"), setItem() {} },
});
const { useModelConnections } = await import("./useModelConnections");
const { useRefreshOnSettingsChange } = await import("./useSettingsResource");
const { DialogProvider } = await import("../ui/DialogProvider");
const { ToastProvider } = await import("../ui/ToastProvider");
const catalog = [{ id: "fixture", tag: "text", displayName: "Fixture", needsKey: true }];
let stored: Record<string, any> = {
  modelConnections: [
    { id: "first", catalogId: "fixture", tag: "text", model: "one", credentialId: "shared" },
    { id: "second", catalogId: "fixture", tag: "text", model: "two", credentialId: "shared" },
    { id: "image", catalogId: "fixture", tag: "image", model: "image", credentialId: "shared" },
  ],
  credentials: [{ id: "shared", catalogId: "fixture", apiKey: "synthetic-preserved" }],
  defaults: { text: "first", auxText: "first", image: "image" },
};
const writes: Array<{ patch: Record<string, any>; resolve(): void; reject(): void }> = [];
let reads = 0;
let releaseStale: (() => void) | undefined;
const errorData = "synthetic-secret-error-detail";
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    getModelCatalog: async () => {
      if (++reads === 2) await new Promise<void>((resolve) => (releaseStale = resolve));
      return catalog;
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
          reject: () => reject(new Error(errorData)),
        });
      }),
  },
});
let current: ReturnType<typeof useModelConnections>;
function Harness() {
  current = useModelConnections("user", undefined, "text");
  useRefreshOnSettingsChange(() => void current.load(), [current.load]);
  return null;
}
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
async function answer(confirm: boolean) {
  const label = en ? (confirm ? "OK" : "Cancel") : confirm ? "确定" : "取消";
  const button = nodes(document.body).find(
    (node) => node.tagName === "BUTTON" && textOf(node) === label,
  );
  assert.ok(button, "Credential deletion requires confirmation");
  await update(() => props(button).onClick());
}
function begin() {
  if (operation === "add") return current.addFromTemplate(current.catalog[0]);
  if (operation === "default") return current.setDefaultInstance("second");
  if (operation === "aux") return current.setAux("second");
  return current.removeCredential("shared");
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
try {
  await update(() =>
    root.render(
      <DialogProvider>
        <ToastProvider>
          <Harness />
        </ToastProvider>
      </DialogProvider>,
    ),
  );
  assert.equal(current!.instances.length, 2);
  if (operation === "credential") {
    await update(() => void begin());
    await answer(false);
    assert.equal(writes.length, 0, "Cancelling never writes");
    assert.equal(current!.pending, false, "Cancellation unlocks the panel");
  }
  await update(() => current.patch("first", { model: "unsaved-model" }));
  await update(() => void begin());
  if (operation === "credential") await answer(true);
  assert.equal(current!.pending, true, "Every settings operation locks the panel while pending");
  assert.equal(writes.length, 1);
  await update(() => {
    void begin();
    void current.saveInstance("first");
  });
  assert.equal(writes.length, 1, "Shared mutation lock rejects duplicate or competing writes");
  assert.equal(current!.instances.length, 2, "Adding does not expose an unpersisted card");
  assert.equal(current!.defaultId, "first", "Default stays committed until persistence succeeds");
  assert.equal(current!.auxId, "first", "Aux selection stays committed until persistence succeeds");
  await update(() => writes[0].reject());
  assert.equal(current!.pending, false);
  assert.equal(current!.instances[0].model, "unsaved-model", "Failure preserves edits");
  assert.equal(current!.credentials.length, 1, "Failed deletion retains the shared credential");
  assert.equal(current!.credentialCommitRevision, 0, "Failure does not commit key drafts");
  const feedback = textOf(document.body);
  assert.ok(!feedback.includes(errorData), "Feedback never includes raw persistence error data");
  assert.ok(feedback.includes(en ? "try again" : "重试"), "Failure offers a localized retry");
  await update(() => void begin());
  if (operation === "credential") await answer(true);
  assert.equal(writes.length, 2);
  await update(() => writes[1].resolve());
  assert.equal(current!.pending, false, "Final readback finishes before unlocking");
  assert.ok(releaseStale, "The automatic older read remains delayed");
  if (operation === "add") {
    assert.equal(current!.instances.length, 3);
    assert.equal(stored.modelConnections.length, 4, "Other model tags are preserved");
  } else if (operation === "default") assert.equal(current!.defaultId, "second");
  else if (operation === "aux") {
    assert.equal(current!.auxId, "second");
    assert.deepEqual(Object.keys(writes[1].patch), ["defaults"], "Aux writes only defaults");
  } else {
    assert.equal(current!.credentials.length, 0);
    assert.ok(
      stored.modelConnections.every((entry: any) => !entry.credentialId),
      "Deletion detaches all shared references across tags",
    );
  }
  await update(() => current.patch("first", { model: "edited-after-success" }));
  await update(() => releaseStale!());
  assert.equal(
    current!.instances[0].model,
    "edited-after-success",
    "A delayed earlier read cannot overwrite later edits",
  );
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
