import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogEntry } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
// MiniDom does not model native connectivity; focus ownership uses it when an
// editor or dialog is removed. Keep this browser property local to the fixture.
Object.defineProperty(HTMLElement.prototype, "isConnected", {
  configurable: true,
  get() {
    return document.body.contains(this);
  },
});
window.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number;
window.cancelAnimationFrame = (id) => clearTimeout(id);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => "zh", setItem() {} },
});
const { ModelCatalogPanel } = await import("./ModelCatalogPanel");
const { DialogProvider } = await import("../ui/DialogProvider");
const { ToastProvider } = await import("../ui/ToastProvider");
const scenario = process.argv[2];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const makeEntry = (displayName = "Catalog Test"): CatalogEntry => ({
  id: "catalog-test",
  tag: "text",
  adapterKind: "openai",
  displayName,
  description: "Synthetic catalog",
  defaultBaseUrl: "https://example.invalid/v1",
  needsKey: true,
  modelPresets: [{ value: "fixture-model" }],
});
let stored = [makeEntry()];
let origin = scenario === "reset-retry" ? "user-override-of-builtin" : "user";
let readFailure = false;
let originFailure = scenario === "origins-retry";
let deferredRead: ReturnType<typeof deferred<CatalogEntry[]>> | undefined =
  scenario === "load-retry" ? deferred() : undefined;
let readCount = 0;
const writes: Array<{
  kind: "save" | "delete";
  entry?: CatalogEntry;
  result: ReturnType<typeof deferred<{ ok: boolean; error?: string }>>;
}> = [];
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    getModelCatalog: () => {
      readCount++;
      if (deferredRead) return deferredRead.promise;
      return readFailure
        ? Promise.reject(new Error("Synthetic read failure"))
        : Promise.resolve(structuredClone(stored));
    },
    getCatalogOrigins: async () => {
      if (originFailure) throw new Error("Synthetic origins failure");
      return { "catalog-test": origin };
    },
    saveCatalogEntry: (entry: CatalogEntry) => {
      const result = deferred<{ ok: boolean; error?: string }>();
      writes.push({ kind: "save", entry: structuredClone(entry), result });
      return result.promise;
    },
    deleteCatalogEntry: (id: string) => {
      assert.equal(id, "catalog-test");
      const result = deferred<{ ok: boolean; error?: string }>();
      writes.push({ kind: "delete", result });
      return result.promise;
    },
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
async function update(fn: () => void) {
  await act(async () => {
    fn();
    await flushMicrotasks();
  });
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
let unmounted = false;
const all = () => nodes(container);
const buttons = (label: string, parent: any = container) =>
  nodes(parent).filter((node) => node.tagName === "BUTTON" && textOf(node) === label);
const button = (label: string, parent?: any) => {
  const result = buttons(label, parent)[0];
  assert.ok(result, `Missing action: ${label}`);
  return result;
};
const fieldset = () => all().find((node) => node.tagName === "FIELDSET");
const card = () => all().find((node) => node.tagName === "ARTICLE");
const nameInput = () =>
  all()
    .filter((node) => node.tagName === "LABEL" && textOf(node) === "显示名")
    .flatMap((label) => nodes(label))
    .find((node) => node.tagName === "INPUT");
const click = (node: any) => update(() => props(node).onClick());
const change = (node: any, value: string) =>
  update(() => props(node).onChange({ target: { value } }));
const refresh = () => update(() => window.dispatchEvent(new Event("codeshell:settings-changed")));
const openEditor = async () => {
  const trigger = nodes(card()).find(
    (node) => node.tagName === "BUTTON" && textOf(node).includes("Catalog Test"),
  );
  assert.ok(trigger);
  await click(trigger);
};
async function remove() {
  const action = button(origin === "user" ? "删除" : "重置为内置");
  action.focus();
  await click(action);
  const dialog = nodes(document.body).find((node) => props(node).role === "dialog");
  assert.ok(dialog, "Template deletion retains the real confirmation step");
  await click(button("确定", dialog));
  // Radix schedules its close-focus cleanup after unmount. Finish that real
  // provider work before settling the deliberately delayed persistence call.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushMicrotasks();
  });
}
async function failWrite(index: number, reject: boolean) {
  await update(() =>
    reject
      ? writes[index].result.reject(new Error("Synthetic backend detail must not appear"))
      : writes[index].result.resolve({
          ok: false,
          error: "Synthetic backend detail must not appear",
        }),
  );
  assert.ok(!textOf(container).includes("Synthetic backend detail"));
  assert.equal(props(fieldset()).disabled, false);
}
try {
  await update(() =>
    root.render(
      <ToastProvider>
        <DialogProvider>
          <ModelCatalogPanel scope="user" activeProjectPath={null} />
        </DialogProvider>
      </ToastProvider>,
    ),
  );
  if (scenario === "load-retry" || scenario === "origins-retry") {
    if (deferredRead) {
      assert.ok(textOf(container).includes("正在读取模型模板"));
      assert.ok(!textOf(container).includes("还没有模板"));
      assert.equal(props(button("新建 provider")).disabled, true);
      const pendingRead = deferredRead;
      deferredRead = undefined;
      await update(() => pendingRead.reject(new Error("Synthetic read failure")));
    }
    assert.ok(textOf(container).includes("无法读取模型模板"));
    assert.ok(!card(), "A partial catalog/origin result must not become editable");
    assert.ok(!textOf(container).includes("还没有模板"));
    originFailure = false;
    const retry = button("重新读取");
    readFailure = true;
    retry.focus();
    await update(() => {
      props(retry).onClick();
      document.body.focus();
    });
    assert.ok(
      document.activeElement === retry,
      "A failed retry returns focus after its button is re-enabled",
    );
    readFailure = false;
    retry.focus();
    await click(retry);
    assert.ok(card());
    assert.equal(props(button("新建 provider")).disabled, false);
    assert.equal(
      document.activeElement,
      button("新建 provider"),
      "Successful keyboard retry restores a stable action",
    );
  } else if (scenario === "refresh-race") {
    await openEditor();
    await change(nameInput(), "Unsaved draft");
    readFailure = true;
    await refresh();
    assert.ok(card() && textOf(container).includes("刷新失败"));
    assert.equal(props(nameInput()).value, "Unsaved draft");
    readFailure = false;
    const oldRead = deferred<CatalogEntry[]>();
    deferredRead = oldRead;
    await refresh();
    deferredRead = undefined;
    stored = [makeEntry("Latest snapshot")];
    await refresh();
    await update(() => oldRead.resolve([makeEntry("Outdated snapshot")]));
    assert.ok(textOf(card()).includes("Latest snapshot"));
    assert.ok(!textOf(card()).includes("Outdated snapshot"));
    assert.equal(props(nameInput()).value, "Unsaved draft");
    // A retry that finishes while the user works elsewhere must not steal focus.
    readFailure = true;
    await refresh();
    readFailure = false;
    deferredRead = deferred();
    const retry = button("重新读取");
    retry.focus();
    await click(retry);
    nameInput().focus();
    const focused = nameInput();
    const currentRead = deferredRead;
    deferredRead = undefined;
    await update(() => currentRead.resolve(stored));
    assert.equal(document.activeElement, focused);
  } else if (scenario === "save-retry") {
    await openEditor();
    await change(nameInput(), "Kept draft");
    const olderRead = deferred<CatalogEntry[]>();
    deferredRead = olderRead;
    await refresh();
    deferredRead = undefined;
    const save = button("保存");
    save.focus();
    await update(() => {
      props(save).onClick();
      props(save).onClick();
    });
    assert.equal(writes.length, 1, "Synchronous duplicate saves must be ignored");
    assert.equal(props(fieldset()).disabled, true);
    let prevented = 0;
    props(fieldset()).onPointerDownCapture({
      preventDefault: () => prevented++,
      stopPropagation: () => prevented++,
    });
    assert.equal(prevented, 2, "Pending captures pointerdown before Radix can open portals");
    const countBefore = readCount;
    await refresh();
    assert.equal(readCount, countBefore, "A background read does not race a pending mutation");
    document.body.focus(); // A disabled native fieldset blurs its focused button.
    await failWrite(0, false);
    assert.ok(document.activeElement === save, "Failed save restores its original keyboard action");
    assert.ok(textOf(container).includes("保存失败，编辑内容已保留"));
    assert.equal(props(nameInput()).value, "Kept draft");
    await update(() => olderRead.resolve([makeEntry("Outdated snapshot")]));
    assert.ok(!textOf(card()).includes("Outdated snapshot"));
    await click(button("保存"));
    await failWrite(1, true);
    await change(nameInput(), "Latest retry draft");
    await click(button("保存"));
    assert.equal(writes[2].entry?.displayName, "Latest retry draft");
    stored = [writes[2].entry!];
    readFailure = true;
    await update(() => writes[2].result.resolve({ ok: true }));
    assert.ok(!nameInput(), "Only a successful mutation closes the editor");
    assert.ok(textOf(card()).includes("Latest retry draft"));
    assert.ok(
      document.activeElement?.tagName === "BUTTON" &&
        textOf(document.activeElement).includes("Latest retry draft"),
      "Successful save restores focus to the collapsed template",
    );
    assert.ok(
      textOf(container).includes("刷新失败"),
      "Post-save read failure remains visible without reverting the saved card",
    );
  } else if (scenario === "save-external-focus") {
    await openEditor();
    const save = button("保存");
    save.focus();
    await click(save);
    const external = document.createElement("input");
    document.body.appendChild(external);
    external.focus();
    await update(() => writes[0].result.resolve({ ok: true }));
    assert.ok(
      document.activeElement === external,
      "Completing a save must not steal focus from another input",
    );
    document.body.removeChild(external);
  } else if (scenario === "cancel-focus") {
    await openEditor();
    const cancel = button("取消");
    cancel.focus();
    await click(cancel);
    assert.ok(
      document.activeElement?.tagName === "BUTTON" &&
        textOf(document.activeElement).includes("Catalog Test"),
    );
  } else if (scenario === "cancel-refresh") {
    await openEditor();
    const remove = button("删除");
    remove.focus();
    await click(remove);
    const dialog = nodes(document.body).find((node) => props(node).role === "dialog");
    assert.ok(dialog);
    stored = [makeEntry("External update during confirmation")];
    const beforeRefresh = readCount;
    await refresh();
    assert.equal(readCount, beforeRefresh);
    await click(button("取消", dialog));
    assert.equal(
      readCount,
      beforeRefresh + 1,
      "Cancelling confirmation resumes the queued refresh",
    );
    assert.ok(textOf(card()).includes("External update during confirmation"));
    assert.equal(
      props(nameInput()).value,
      "Catalog Test",
      "Resuming a read does not replace the editing draft",
    );
    assert.equal(writes.length, 0);
  } else if (scenario === "delete-retry" || scenario === "reset-retry") {
    await openEditor();
    await change(nameInput(), "Unsaved template draft");
    await remove();
    assert.equal(writes.length, 1);
    assert.equal(props(fieldset()).disabled, true);
    assert.ok(card() && nameInput(), "Pending removal retains both template and draft");
    document.body.focus();
    await failWrite(0, false);
    assert.ok(
      document.activeElement === button(origin === "user" ? "删除" : "重置为内置"),
      "Failed removal restores its original keyboard action",
    );
    assert.ok(textOf(container).includes("模板和编辑内容已保留"));
    assert.equal(props(nameInput()).value, "Unsaved template draft");
    await remove();
    await failWrite(1, true);
    assert.equal(props(nameInput()).value, "Unsaved template draft");
    await remove();
    stored = scenario === "delete-retry" ? [] : [makeEntry("Restored built-in")];
    origin = "builtin";
    await update(() => writes[2].result.resolve({ ok: true }));
    assert.ok(!nameInput());
    if (scenario === "delete-retry") {
      assert.ok(!card() && textOf(container).includes("还没有模板"));
      assert.ok(
        document.activeElement === button("新建 provider"),
        `Deletion returns focus to a surviving action, got ${document.activeElement?.tagName}: ${textOf(document.activeElement).slice(0, 60)}`,
      );
    } else {
      assert.ok(textOf(card()).includes("Restored built-in"));
      assert.ok(
        document.activeElement?.tagName === "BUTTON" &&
          textOf(document.activeElement).includes("Restored built-in"),
      );
    }
  } else if (scenario === "unmount") {
    await openEditor();
    await click(button("保存"));
    const countBefore = readCount;
    await update(() => root.unmount());
    unmounted = true;
    await update(() => writes[0].result.resolve({ ok: true }));
    assert.equal(
      readCount,
      countBefore,
      "An unmounted editor does not refresh or raise notifications after its write",
    );
    assert.equal(container.childNodes.length, 0);
  } else throw new Error("Unknown catalog regression scenario");
} finally {
  if (!unmounted) await update(() => root.unmount());
  document.body.removeChild(container);
}
