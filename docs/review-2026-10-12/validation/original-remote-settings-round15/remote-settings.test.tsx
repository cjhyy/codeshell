import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
const React = await import(repo + "/node_modules/react/index.js");
const { act } = React;
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client");
const { ensureMiniDom, flushMicrotasks } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { RemoteHostManager } = await import(repo + "/packages/server/src/mobile-remote/remote-host-manager.ts");
const { TrustedDeviceStore } = await import(repo + "/packages/server/src/mobile-remote/trusted-device-store.ts");
const { createDesktopRemoteServices } = await import(repo + "/packages/desktop/src/main/desktop-remote-services.ts");

// Only selector drawing/QR encoding are substitutes. The complete production
// settings component, its actions/effects and Main service/IPC remain real.
mock.module(repo + "/packages/desktop/src/renderer/components/ui/simple-select.tsx", () => ({
  SimpleSelect: (p: any) => React.createElement("select", { value: p.value, disabled: p.disabled, onChange: (e: any) => p.onChange(e.target.value) }, p.options.map((o: any) => React.createElement("option", { key: o.value, value: o.value }, o.label))),
}));
mock.module("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,b3duZWQ=" } }));
let bridge: any;
const ipcRenderer = {
  invoke: (...args: any[]) => bridge.invoke(...args),
  on: (channel: string, fn: any) => bridge.on(channel, fn),
  removeListener: (channel: string, fn: any) => bridge.removeListener(channel, fn),
};
mock.module("electron", () => ({ ipcRenderer }));
const { mobileRemoteApi } = await import(repo + "/packages/desktop/src/preload/mobile-remote-api.ts");
const { MobileRemoteSection } = await import(repo + "/packages/desktop/src/renderer/settings/AdvancedSections.tsx");
const { I18nProvider } = await import(repo + "/packages/desktop/src/renderer/i18n/I18nProvider.tsx");
const { DialogProvider } = await import(repo + "/packages/desktop/src/renderer/ui/DialogProvider.tsx");
const { ToastProvider } = await import(repo + "/packages/desktop/src/renderer/ui/ToastProvider.tsx");

let active: any;
afterEach(async () => { if (active) await active.cleanup(); active = undefined; });
function nodes(node: any): any[] { return [node, ...Array.from(node?.childNodes ?? []).flatMap(nodes)]; }
function props(node: any) { const key = Object.keys(node).find(k => k.startsWith("__reactProps$")); return key ? node[key] : {}; }
function text(node: any): string { return node.nodeType === 3 ? (node.nodeValue ?? node.textContent ?? "") : Array.from(node?.childNodes ?? []).map(text).join("") || (node.textContent ?? ""); }
const settle = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check()) { if (Date.now() > end) throw Error("remote settings did not settle"); await act(settle); } }

async function fixture() {
  ensureMiniDom();
  const memory = new Map<string, string>([["codeshell.uiLanguage", "zh"]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => memory.set(k, v), removeItem: (k: string) => memory.delete(k) } });
  Object.assign(document.documentElement, { classList: { contains: () => false } });
  const owned = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-remote-settings-")));
  const devices = new TrustedDeviceStore(join(owned, "devices.json"));
  const host = new RemoteHostManager({ devices, onClientEvent: () => { throw Error("no remote client allowed in settings fixture"); } });
  const hostStart = host.start.bind(host);
  // The production LAN address resolution is replaced only at bind boundary:
  // use real listener/stop/pairing with owned loopback, never expose a LAN port.
  host.start = (options: any) => hostStart({ ...options, host: "127.0.0.1" });
  const handlers = new Map<string, any>();
  const listeners = new Map<string, Set<any>>();
  const relayListeners = () => listeners.get("mobileRemote:relayStatusChanged") ?? new Set();
  const sent: any[] = [];
  const sender: any = { id: 901, mainFrame: {}, isDestroyed: () => false, send(channel: string, value: any) { sent.push({ channel, value }); for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, value); } };
  const event = { sender, senderFrame: sender.mainFrame };
  const windows = [{ isDestroyed: () => false, webContents: sender }];
  const services = createDesktopRemoteServices({
    ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any,
    userDataDir: owned, environmentDir: owned,
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "owned-test", encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } as any,
    windows: () => windows as any, openExternal: async () => { throw Error("no external navigation"); }, host,
    tunnel: { isRunning: () => false, isConnected: () => false, stop: async () => {} } as any,
    binary: { ensureBinary: async () => { throw Error("no cloudflared"); } } as any,
    passcode: { isSet: () => false } as any,
  });
  let statusCalls = 0;
  // Ancillary read-only Main calls use the same real store/status values.
  handlers.set("mobileRemote:listDevices", () => devices.listDevices());
  handlers.set("mobileRemote:passcodeStatus", () => ({ isSet: false }));
  handlers.set("mobileRemote:cloudflaredInstalled", () => false);
  handlers.set("mobileRemote:onlineDevices", () => host.onlineDeviceIds());
  bridge = {
    invoke: async (channel: string, ...args: any[]) => { if (channel === "mobileRemote:status") statusCalls++; return handlers.get(channel)(event, ...args); },
    on: (channel: string, fn: any) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(fn); },
    removeListener: (channel: string, fn: any) => listeners.get(channel)?.delete(fn),
  };
  const api: any = { mobileRemote: mobileRemoteApi };
  Object.defineProperty(window, "codeshell", { configurable: true, value: api });
  const views: any[] = [];
  const mount = async () => {
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container); const view = { container, root }; views.push(view);
    await act(async () => { root.render(<I18nProvider><DialogProvider><ToastProvider><MobileRemoteSection /></ToastProvider></DialogProvider></I18nProvider>); await settle(); });
    await until(() => nodes(container).some(n => n.tagName === "BUTTON" && /开启手机遥控/.test(text(n))));
    return view;
  };
  const click = async (view: any, label: RegExp) => {
    const button = nodes(view.container).find(n => n.tagName === "BUTTON" && label.test(text(n)));
    if (!button) throw Error("button not found " + label);
    if (props(button).disabled) throw Error("button disabled " + label);
    await act(async () => { await props(button).onClick({}); await settle(); });
  };
  const cleanup = async () => {
    for (const v of views) await act(async () => { v.root.unmount(); await settle(); });
    for (const v of views) if (v.container.parentNode) v.container.parentNode.removeChild(v.container);
    await services.mobileRemoteController.dispose();
    rmSync(owned, { recursive: true, force: true });
  };
  return active = { host, services, sent, views, relayListeners, handlers, event, mount, click, cleanup, statusCalls: () => statusCalls };
}

test("CANDIDATE LAN opened from another settings instance does not refresh the already-mounted observer; remount recovers", async () => {
  const f = await fixture(); const observer = await f.mount(); const actor = await f.mount();
  expect(text(observer.container)).toContain("已关闭");
  const beforeCalls = f.statusCalls(); const beforeEvents = f.sent.length;
  await f.click(actor, /开启手机遥控/);
  await until(() => f.host.status()?.mode === "lan" && text(actor.container).includes("http://127.0.0.1:"));
  expect(f.services.mobileRemoteController.status().running).toBe(true);
  expect(text(actor.container)).toContain("http://127.0.0.1:");
  expect(text(observer.container)).toContain("已关闭");
  const observerStart = nodes(observer.container).find(n => n.tagName === "BUTTON" && /开启手机遥控/.test(text(n)));
  const observerStop = nodes(observer.container).find(n => n.tagName === "BUTTON" && text(n) === "关闭");
  expect(props(observerStart).disabled).toBe(false);
  expect(props(observerStop).disabled).toBe(true);
  expect(f.sent.slice(beforeEvents).filter((x: any) => x.channel === "mobileRemote:relayStatusChanged")).toHaveLength(0);
  expect(f.statusCalls() - beforeCalls).toBe(1);
  await act(async () => { observer.root.unmount(); await settle(); });
  f.views.splice(f.views.indexOf(observer), 1); observer.container.parentNode.removeChild(observer.container);
  const recovered = await f.mount(); await until(() => text(recovered.container).includes("http://127.0.0.1:"));
  expect(text(recovered.container)).toContain("http://127.0.0.1:");
  expect(f.host.status()?.mode).toBe("lan");
  console.log(JSON.stringify({ actualHost: true, loopbackBindOnly: true, actualControllerAndIpc: true, actualSettingsComponent: true, twoUiInstancesInOneMiniDom: true, actualTwoElectronWindows: false, observerStaleAfterLanStart: true, remountRestoresState: true }));
});

test("CONTROL ordinary local LAN start and stop update their initiating UI and stop broadcast updates a mounted observer", async () => {
  const f = await fixture(); const observer = await f.mount(); const actor = await f.mount();
  await f.click(actor, /开启手机遥控/); await until(() => f.host.status()?.mode === "lan");
  await f.click(observer, /开启手机遥控/);
  expect(text(observer.container)).toContain("http://127.0.0.1:");
  await f.click(actor, /^关闭$/); await until(() => !f.host.status());
  expect(f.services.mobileRemoteController.status().running).toBe(false);
  expect(text(actor.container)).toContain("已关闭");
  expect(text(observer.container)).toContain("已关闭");
  expect(f.sent.some((x: any) => x.channel === "mobileRemote:relayStatusChanged")).toBe(true);
  expect(f.relayListeners().size).toBe(2);
});


test("CONTROL stale observer can click start to refresh idempotently; owner/frame guards still reject unrelated callers", async () => {
  const f = await fixture(); const observer = await f.mount(); const actor = await f.mount();
  await f.click(actor, /开启手机遥控/);
  const originalPort = f.host.status()!.port;
  expect(text(observer.container)).toContain("已关闭");
  await f.click(observer, /开启手机遥控/);
  expect(f.host.status()!.port).toBe(originalPort);
  expect(text(observer.container)).toContain("http://127.0.0.1:");
  expect(text(actor.container)).toContain("http://127.0.0.1:");
  expect(() => f.handlers.get("mobileRemote:status")({ ...f.event, senderFrame: {} })).toThrow("主窗口");
  expect(() => f.handlers.get("mobileRemote:stop")({ ...f.event, sender: { ...f.event.sender } })).toThrow("主窗口");
  expect(f.host.status()!.port).toBe(originalPort);
});
