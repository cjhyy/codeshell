import assert from "node:assert/strict";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { ComputerUseSettingsStatus } from "../../shared/computer-use";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
const scenario = process.argv[2];
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => (scenario === "english" ? "en" : "zh"), setItem() {} },
});
let visibility = "visible";
Object.defineProperty(document, "visibilityState", { get: () => visibility });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let current: ComputerUseSettingsStatus = {
  enabled: !["disabled", "enable-retry", "stale-read", "read-retry"].includes(scenario),
  active: false,
  driverAvailable: true,
  packaged: true,
  restartRequired: false,
  permissions: {
    supported: scenario !== "unsupported",
    accessibility: "denied",
    screenRecording: "denied",
    screenRequestAvailable: scenario !== "screen-settings-fallback",
    restartRequired: false,
  },
};
let reads = 0;
let writesFail = scenario === "enable-retry";
let readsFail = scenario === "read-retry";
const requests: string[] = [];
const settings: string[] = [];
const writes: boolean[] = [];
let restarts = 0;
const pending = deferred<ComputerUseSettingsStatus>();
const slowRead = deferred<ComputerUseSettingsStatus>();
const unhandled: string[] = [];
process.on("unhandledRejection", (error) => unhandled.push(String(error)));
Object.assign(window, {
  codeshell: {
    computerUse: {
      status: async () => {
        reads += 1;
        if (readsFail) throw new Error("synthetic read failure");
        if (scenario === "unmount") return pending.promise;
        if (scenario === "stale-read" && reads === 2) return slowRead.promise;
        return structuredClone(current);
      },
      setEnabled: async (enabled: boolean) => {
        writes.push(enabled);
        if (writesFail) throw new Error("synthetic write failure");
        current = { ...current, enabled, restartRequired: true };
        return structuredClone(current);
      },
      requestPermission: async (kind: "accessibility" | "screenRecording") => {
        requests.push(kind);
        return pending.promise;
      },
      openSettings: async (kind: string) => {
        settings.push(kind);
      },
      restart: async () => {
        restarts += 1;
      },
    },
  },
});
const { ComputerUseSettings } = await import("./ComputerUseSettings");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
let unmounted = false;
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
function button(label: string) {
  const node = nodes(container).find((n) => n.tagName === "BUTTON" && textOf(n) === label);
  assert.ok(node, `Missing action: ${label}`);
  return node;
}
function toggle() {
  const node = nodes(container).find((n) => props(n).role === "switch");
  assert.ok(node, "Feature switch should exist");
  return node;
}
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function click(label: string) {
  const node = button(label);
  assert.ok(!props(node).disabled, `Action is enabled: ${label}`);
  await update(() => props(node).onClick());
}
async function setEnabled() {
  await update(() => props(toggle()).onClick({ defaultPrevented: false, stopPropagation() {} }));
}
async function grant(kind: "accessibility" | "screenRecording") {
  current = {
    ...current,
    permissions: { ...current.permissions, [kind]: "granted", restartRequired: true },
  };
  await update(() => pending.resolve(structuredClone(current)));
}
try {
  await update(() => root.render(<ComputerUseSettings />));
  assert.deepEqual(requests, [], "Rendering never requests OS permissions");
  assert.deepEqual(settings, [], "Rendering never opens System Settings");
  assert.equal(restarts, 0, "Rendering never restarts the app");
  if (scenario === "disabled") {
    assert.equal(props(toggle())["aria-checked"], false);
    assert.equal(props(button("申请辅助功能权限")).disabled, true);
    assert.equal(props(button("申请屏幕录制权限")).disabled, true);
    assert.ok(textOf(container).includes("打开此页面不会自动弹出授权申请"));
  } else if (scenario.startsWith("request-") || scenario === "busy-focus") {
    const kind = scenario === "request-screen" ? "screenRecording" : "accessibility";
    const label = kind === "accessibility" ? "申请辅助功能权限" : "申请屏幕录制权限";
    const handler = props(button(label)).onClick;
    await update(() => {
      handler();
      handler();
    });
    assert.deepEqual(requests, [kind], "Same-frame double-click sends one request");
    assert.equal(props(toggle()).disabled, true, "A prompt locks the feature switch");
    if (scenario === "busy-focus") {
      await update(() => window.dispatchEvent(new Event("focus")));
      assert.equal(reads, 1, "Returning focus cannot race a pending permission request");
    }
    await grant(kind);
    assert.ok(textOf(container).includes("已授权"));
    assert.equal(restarts, 0, "An OS permission response never restarts automatically");
    assert.equal(props(toggle()).disabled, false);
    if (scenario === "busy-focus") assert.equal(reads, 2, "Recheck queued focus after request");
    await click("重启 CodeShell");
    assert.equal(restarts, 1);
  } else if (scenario === "screen-settings-fallback") {
    assert.ok(!textOf(container).includes("申请屏幕录制权限"));
    await click("打开屏幕录制设置");
    assert.deepEqual(settings, ["screenRecording"]);
    assert.deepEqual(requests, []);
  } else if (scenario === "enable-retry") {
    await setEnabled();
    assert.deepEqual(writes, [true]);
    assert.equal(props(toggle())["aria-checked"], false, "Failed persistence retains old state");
    assert.ok(nodes(container).some((n) => props(n).role === "alert"));
    writesFail = false;
    await setEnabled();
    assert.deepEqual(writes, [true, true]);
    assert.equal(props(toggle())["aria-checked"], true);
    assert.ok(textOf(container).includes("重启 CodeShell"));
    assert.deepEqual(requests, [], "Enabling never requests permissions automatically");
    assert.equal(restarts, 0);
  } else if (scenario === "stale-read") {
    const stale = structuredClone(current);
    await update(() => window.dispatchEvent(new Event("focus")));
    assert.equal(reads, 2);
    await setEnabled();
    assert.equal(props(toggle())["aria-checked"], true);
    await update(() => slowRead.resolve(stale));
    assert.equal(props(toggle())["aria-checked"], true, "Old reads cannot undo a saved toggle");
    assert.ok(textOf(container).includes("重启 CodeShell"));
  } else if (scenario === "refresh-on-return") {
    current.permissions.screenRecording = "granted";
    await update(() => window.dispatchEvent(new Event("focus")));
    assert.equal(reads, 2);
    assert.ok(textOf(container).includes("已授权"));
    visibility = "hidden";
    await update(() => document.dispatchEvent(new Event("visibilitychange")));
    assert.equal(reads, 2, "Hiding the app does not recheck permissions");
    visibility = "visible";
    await update(() => document.dispatchEvent(new Event("visibilitychange")));
    assert.equal(reads, 3);
  } else if (scenario === "unmount") {
    await update(() => root.unmount());
    unmounted = true;
    await update(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      pending.reject(new Error("synthetic late failure"));
    });
    assert.equal(reads, 1, "Unmount removes the permission recheck listeners");
  } else if (scenario === "unsupported") {
    assert.ok(textOf(container).includes("仅支持 macOS"));
    assert.ok(!nodes(container).some((n) => props(n).role === "switch"));
    assert.ok(!textOf(container).includes("申请辅助功能权限"));
  } else if (scenario === "read-retry") {
    assert.ok(nodes(container).some((n) => props(n).role === "alert"));
    readsFail = false;
    await click("重新检查");
    assert.equal(props(toggle())["aria-checked"], false);
    assert.ok(!nodes(container).some((n) => props(n).role === "alert"));
  } else if (scenario === "english") {
    assert.ok(textOf(container).includes("Computer use (preview)"));
    assert.ok(textOf(container).includes("Screen recording"));
    assert.ok(textOf(container).includes("Not granted"));
    assert.ok(!textOf(container).includes("settingsX.computerUse"));
  } else if (scenario === "scope") {
    // Scope behavior is checked on the real GeneralSection. Other app-global
    // sections are irrelevant to this card and would require unrelated bridges.
    mock.module("./PermissionSection", () => ({ PermissionSection: () => null }));
    mock.module("./CloudAccountSettings", () => ({ CloudAccountSettings: () => null }));
    mock.module("../updater/UpdaterBanner", () => ({ UpdaterSettingsRow: () => null }));
    const { GeneralSection } = await import("./GeneralSection");
    await update(() =>
      root.render(<GeneralSection scope="project" activeProjectPath="/fixture" />),
    );
    assert.ok(!textOf(container).includes("电脑操作（试用）"));
    const previousReads = reads;
    await update(() => root.render(<GeneralSection scope="user" activeProjectPath={null} />));
    assert.ok(textOf(container).includes("电脑操作（试用）"));
    assert.equal(reads, previousReads + 1);
  } else throw new Error(`Unknown scenario: ${scenario}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(unhandled, [], "All asynchronous bridge failures are handled");
} finally {
  if (!unmounted) await update(() => root.unmount());
  document.body.removeChild(container);
}
