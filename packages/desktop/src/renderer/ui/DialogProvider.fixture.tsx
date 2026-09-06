// A fresh process loads real Radix primitives; other renderer suites replace
// the shared Dialog module globally and cannot verify its Escape propagation.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
// The minimal DOM does not schedule animation frames; keep that browser API
// local to this isolated fixture instead of changing the production component.
window.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(performance.now()), 0) as unknown as number;
window.cancelAnimationFrame = (id) => clearTimeout(id);
Object.defineProperty(HTMLInputElement.prototype, "select", {
  configurable: true,
  value() {
    this.selectionStart = 0;
    this.selectionEnd = this.value?.length ?? 0;
  },
});
const { DialogProvider, useAlert, useConfirm, usePrompt } = await import("./DialogProvider");
const scenario = process.argv[2];
let api: {
  alert: ReturnType<typeof useAlert>;
  confirm: ReturnType<typeof useConfirm>;
  prompt: ReturnType<typeof usePrompt>;
};
const results: unknown[][] = [];

function Harness() {
  api = { alert: useAlert(), confirm: useConfirm(), prompt: usePrompt() };
  return <button type="button">Dialog opener</button>;
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
function dialog() {
  const result = nodes(document.body).find((node) => props(node).role === "dialog");
  assert.ok(result, "Expected an actual Radix dialog");
  return result;
}
function input() {
  return nodes(dialog()).find((node) => node.tagName === "INPUT");
}
function button(label: string) {
  const found = nodes(dialog()).find((node) => node.tagName === "BUTTON" && textOf(node) === label);
  assert.ok(found, `Missing dialog button: ${label}`);
  return found;
}
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
}
async function escape(extra = {}) {
  await update(() => {
    document.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape", ...extra }),
    );
  });
}
async function enter(extra = {}) {
  await update(() => {
    props(input()).onKeyDown({
      key: "Enter",
      nativeEvent: { isComposing: false },
      preventDefault() {},
      ...extra,
    });
  });
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
try {
  await update(() => {
    root.render(
      <DialogProvider>
        <Harness />
      </DialogProvider>,
    );
  });

  if (scenario.startsWith("escape-")) {
    const kind = scenario.slice("escape-".length) as "confirm" | "alert" | "prompt";
    await update(() => {
      void api[kind]({ title: "First dialog", message: "First request" }).then((value) =>
        results.push(["first", value]),
      );
      void api[kind]({ title: "Second dialog", message: "Second request" }).then((value) =>
        results.push(["second", value]),
      );
    });
    const cancelled = kind === "confirm" ? false : kind === "prompt" ? null : undefined;
    await escape({ isComposing: true });
    await escape({ keyCode: 229 });
    assert.deepEqual(results, [], "IME Escape must retain the current dialog and its queue");
    await escape();
    assert.deepEqual(
      results,
      [["first", cancelled]],
      "One Escape must resolve only the active request",
    );
    assert.ok(textOf(dialog()).includes("Second dialog"), "The queued request must remain visible");
    await escape();
    assert.deepEqual(results, [
      ["first", cancelled],
      ["second", cancelled],
    ]);
    assert.ok(!nodes(document.body).some((node) => props(node).role === "dialog"));
  } else if (scenario === "prompt-ime") {
    await update(() => {
      void api
        .prompt({ title: "Prompt", message: "Name", defaultValue: "草稿" })
        .then((value) => results.push(["prompt", value]));
    });
    await enter({ nativeEvent: { isComposing: true } });
    assert.deepEqual(results, [], "IME Enter must not submit the prompt");
    await enter({ keyCode: 229 });
    assert.deepEqual(results, [], "IME keyCode fallback must not submit the prompt");
    await escape({ isComposing: true });
    assert.deepEqual(results, [], "IME Escape must not cancel the prompt");
    await escape({ keyCode: 229 });
    assert.deepEqual(results, [], "IME Escape fallback must not cancel the prompt");
    await update(() => props(input()).onCompositionStart?.());
    await enter();
    await escape();
    assert.deepEqual(results, [], "An active composition must ignore plain Enter and Escape");
    await update(() => props(input()).onCompositionEnd?.());
    await enter();
    assert.deepEqual(results, [["prompt", "草稿"]], "Enter submits after composition ends");
  } else if (scenario === "prompt-draft") {
    const sharedOptions = { title: "Repeated prompt", message: "Name", defaultValue: "original" };
    await update(() => {
      void api.prompt(sharedOptions).then((value) => results.push(["first", value]));
      void api.prompt(sharedOptions).then((value) => results.push(["second", value]));
      void api
        .prompt({ title: "Third prompt", message: "Name", defaultValue: "third default" })
        .then((value) => results.push(["third", value]));
    });
    await update(() => props(input()).onChange({ target: { value: "first draft" } }));
    await update(() => props(input()).onCompositionStart?.());
    await update(() => props(button("确定")).onClick());
    assert.deepEqual(results, [["first", "first draft"]]);
    assert.equal(
      props(input()).value,
      "original",
      "Repeated options still start a fresh prompt draft",
    );
    await update(() => props(input()).onChange({ target: { value: "second draft" } }));
    await update(() => props(button("取消")).onClick());
    assert.equal(
      props(input()).value,
      "third default",
      "A queued prompt must use its own default value",
    );
    await enter();
    assert.deepEqual(results, [
      ["first", "first draft"],
      ["second", null],
      ["third", "third default"],
    ]);
  } else if (scenario === "stale-close") {
    await update(() => {
      void api
        .confirm({ title: "First", message: "First request" })
        .then((value) => results.push(["first", value]));
      void api
        .confirm({ title: "Second", message: "Second request" })
        .then((value) => results.push(["second", value]));
    });
    const closeFirst = props(button("取消")).onClick;
    await update(() => {
      closeFirst();
      closeFirst();
    });
    assert.deepEqual(
      results,
      [["first", false]],
      "A repeated close callback cannot resolve the next request",
    );
    assert.ok(textOf(dialog()).includes("Second"));
    await escape();
  } else {
    throw new Error(`Unknown scenario: ${scenario}`);
  }
} finally {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  document.body.removeChild(container);
}
