// Isolated process: uses the real hook and providers without global module mocks.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => "zh", setItem() {} },
});
const { useModelConnections } = await import("./useModelConnections");
const { cacheGet } = await import("./settingsCache");
const { saveProjects } = await import("../projects");
saveProjects([
  {
    id: "project-fixture",
    name: "Fixture",
    path: "/synthetic-project",
    addedAt: 1,
    primaryRootId: "root-fixture",
    roots: [{ id: "root-fixture", path: "/synthetic-project", name: "Fixture", addedAt: 1 }],
  },
]);
const { DialogProvider } = await import("../ui/DialogProvider");
const { ToastProvider } = await import("../ui/ToastProvider");
const scenario = process.argv[2];
const readData = (id: string) => ({
  modelConnections: [{ id, catalogId: id, tag: "text", model: "model" }],
  credentials: [{ id: "credential", catalogId: id, apiKey: "synthetic-read-only" }],
  defaults: { text: id, auxText: id },
});
let nextId = "original";
let fail: "catalog" | "settings" | null = scenario === "initial-settings" ? "settings" : "catalog";
let hold = false;
let release: (() => void) | undefined;
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    getModelCatalog: async () => {
      const id = nextId;
      if (fail === "catalog") throw new Error("synthetic-private-read-error");
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return [{ id, tag: "text", displayName: id }];
    },
    getSettings: async () => {
      if (fail === "settings") throw new Error("synthetic-private-read-error");
      return readData(nextId);
    },
    getConfigurationSettings: async () => readData(nextId),
  },
});
let current: ReturnType<typeof useModelConnections>;
let projectPath: string | undefined;
function Harness() {
  current = useModelConnections(projectPath ? "project" : "user", projectPath, "text");
  return null;
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
}
const render = () =>
  root.render(
    <DialogProvider>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </DialogProvider>,
  );
const startRead = () => void current.load().catch(() => {});
let unmounted = false;
try {
  await update(render);
  await update(startRead);
  assert.equal(current!.loadFailed, true, "Initial read failures must be explicit");
  assert.equal(current!.hasLoaded, false, "Partial data never becomes an editable snapshot");
  assert.equal(current!.credentials.length, 0, "A failed catalog read cannot apply settings alone");
  fail = null;
  await update(startRead);
  assert.equal(current!.hasLoaded, true);
  assert.equal(current!.loadFailed, false);
  await update(() => current.patch("original", { model: "unsaved-draft" }));
  nextId = "replacement";
  fail = scenario === "initial-settings" ? "settings" : "catalog";
  await update(startRead);
  assert.equal(current!.loadFailed, true);
  assert.equal(current!.hasLoaded, true, "Refresh failure retains the complete snapshot");
  assert.equal(current!.catalog[0].id, "original");
  assert.equal(
    current!.instances[0].model,
    "unsaved-draft",
    "Refresh failure preserves local edits",
  );
  assert.equal(current!.defaultId, "original");
  assert.equal(current!.credentials[0].catalogId, "original");
  fail = null;
  hold = true;
  await update(startRead);
  assert.equal(current!.loading, true);
  assert.ok(release);
  if (scenario === "unmount") {
    await update(() => root.unmount());
    unmounted = true;
    await update(() => release!());
    assert.equal(
      cacheGet<any[]>("conn:text:user:")?.[0].id,
      "original",
      "Unmounted reads cannot update the snapshot cache",
    );
  } else {
    const staleLoad = current!.load;
    if (scenario === "scope") {
      projectPath = "/synthetic-project";
      await update(render);
      assert.equal(
        current!.hasLoaded,
        false,
        "A new scope cannot show the previous editable snapshot",
      );
    }
    hold = false;
    nextId = "latest";
    await update(startRead);
    await update(() => release!());
    assert.equal(current!.catalog[0].id, "latest");
    assert.equal(
      current!.instances[0].id,
      "latest",
      "An older request cannot replace the latest complete read",
    );
    assert.equal(current!.loading, false);
    if (scenario === "scope") {
      nextId = "wrong-scope";
      await update(() => void staleLoad());
      assert.equal(
        current!.instances[0].id,
        "latest",
        "A retained callback cannot read a departed scope",
      );
    }
  }
} finally {
  if (!unmounted) await update(() => root.unmount());
  document.body.removeChild(container);
}
