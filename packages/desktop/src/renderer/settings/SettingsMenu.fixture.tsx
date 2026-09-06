// A fresh process keeps Radix's browser initialization and portal state isolated
// from renderer suites which intentionally mock shared UI modules.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 240, bottom: 36, width: 240, height: 36 }) as DOMRect;
// Popper uses CSS custom properties; the shared minimal DOM only stores style keys.
const createElement = document.createElement.bind(document);
document.createElement = ((...args: Parameters<typeof document.createElement>) => {
  const element = createElement(...args);
  element.style.setProperty = (name: string, value: string | null) => {
    (element.style as unknown as Record<string, string>)[name] = value ?? "";
  };
  element.style.removeProperty = (name: string) => {
    const value = (element.style as unknown as Record<string, string>)[name] ?? "";
    delete (element.style as unknown as Record<string, string>)[name];
    return value;
  };
  element.style.getPropertyValue = (name: string) =>
    (element.style as unknown as Record<string, string>)[name] ?? "";
  return element;
}) as typeof document.createElement;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null },
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: clearTimeout,
});
const { SettingsMenu } = await import("./SettingsMenu");
function nodes(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(nodes)];
}
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as unknown as Record<string, any>)[key] : {};
}
function text(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? (node as Text).data ?? "";
  return node.childNodes.length
    ? Array.from(node.childNodes).map(text).join("")
    : (node.textContent ?? "");
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const actions: Array<{ page: string; focus: Element | null; pointerEvents: string }> = [];
const trigger = () =>
  nodes(container).find((node) => node.tagName === "BUTTON") as HTMLButtonElement;
const item = (label: string) =>
  nodes(document.body).find((node) => props(node).role === "menuitem" && text(node) === label)!;
const settle = async (action: () => void) => {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
};
const settleClose = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
  });
};
const record = (page: string) =>
  actions.push({
    page,
    focus: document.activeElement,
    pointerEvents: document.body.style.pointerEvents,
  });
const open = () =>
  settle(() =>
    props(trigger()).onKeyDown({ key: "Enter", defaultPrevented: false, preventDefault() {} }),
  );
const select = async (label: string) => {
  await settle(() => {
    const current = item(label);
    assert.ok(current, `Menu item exists: ${label}`);
    const before = actions.length;
    props(current).onClick({
      defaultPrevented: false,
      stopPropagation() {},
      currentTarget: current,
    });
    assert.equal(actions.length, before, "Navigation must wait for menu cleanup");
  });
  await settleClose();
};
try {
  await settle(() =>
    root.render(
      <SettingsMenu
        petWidgetVisible={false}
        onTogglePetWidget={() => {}}
        onNavigate={record}
        onOpenSettingsPage={() => record("settings")}
      />,
    ),
  );
  trigger().focus();
  await open();
  await select("打开设置…");
  assert.equal(actions[0]?.page, "settings");
  assert.equal(actions[0]?.focus, trigger());
  assert.notEqual(actions[0]?.pointerEvents, "none");
  await open();
  await settle(() =>
    props(item("活动记录")).onClick({
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    }),
  );
  await select("日志");
  assert.equal(actions[1]?.page, "logs");
  assert.equal(actions[1]?.focus, trigger());
  assert.notEqual(actions[1]?.pointerEvents, "none");
  await settleClose();
  assert.equal(actions.length, 2, "A close notification must navigate only once");
  await open();
  assert.equal(
    props(trigger())["aria-expanded"],
    true,
    "The settings trigger can reopen after navigation",
  );
  assert.equal(actions.length, 2, "Reopening does not repeat a previous action");
} finally {
  await settle(() => root.unmount());
  await settleClose();
  document.body.removeChild(container);
}
