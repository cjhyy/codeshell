import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";

if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("maintained guarded HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
let networkCalls = 0, subprocessCalls = 0;
const denyNetwork = () => { networkCalls++; throw Error("browser-round21 network forbidden"); };
net.connect = net.createConnection = denyNetwork as any;
tls.connect = denyNetwork as any;
const denySubprocess = () => { subprocessCalls++; throw Error("browser-round21 subprocess forbidden"); };
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) (childProcess as any)[key] = denySubprocess;

const handlers = new Map<string, any>();
const ipcCalls: any[] = [];
let currentOwner = 71, known = true, sender = 71;
let api: any;
mock.module("electron", () => ({
  contextBridge: { exposeInMainWorld: (_key: string, value: any) => { api = value; } },
  webUtils: { getPathForFile: () => "" },
  ipcRenderer: {
    on() { return this; }, removeListener() { return this; },
    send() { throw Error("unexpected owned IPC send"); },
    async invoke(channel: string, payload: any) {
      ipcCalls.push({ channel, payload });
      if (channel === "ports:probe") return [];
      const callback = handlers.get(channel);
      if (!callback) throw Error("unexpected IPC: " + channel);
      return callback({ sender: { id: sender } }, payload);
    },
  },
}));
const React = (await import(repo + "/packages/desktop/node_modules/react")).default;
const { act } = React;
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client");
const { ensureMiniDom, flushMicrotasks } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { BrowserPanel } = await import(repo + "/packages/desktop/src/renderer/panels/BrowserPanel.tsx");
const { ToastProvider } = await import(repo + "/packages/desktop/src/renderer/ui/ToastProvider.tsx");
const { ChromeExtensionBackend } = await import(repo + "/packages/desktop/src/main/browser-runtime/chrome-extension-runtime.ts");
const { assertDesktopSessionId } = await import(repo + "/packages/desktop/src/main/session-validation.ts");
await import(repo + "/packages/desktop/src/preload/index.ts");

// Production Main authority helper and Chrome IPC callbacks, unchanged. The
// live-session/owner directory and Electron transport are owned host adapters;
// no complete Main, AgentBridge, native relay or Chrome process is started.
const mainSource = readFileSync(repo + "/packages/desktop/src/main/index.ts", "utf8");
const authorityStart = mainSource.indexOf("function assertRendererSessionAccess(");
const authorityEnd = mainSource.indexOf("function requireRendererBrowserPartition(", authorityStart);
const callsStart = mainSource.indexOf('ipcMain.handle(\n  "browser-runtime:chrome-begin-pairing",');
const callsEnd = mainSource.indexOf('\nipcMain.handle("credentials:cookieDomains"', callsStart);
if (authorityStart < 0 || authorityEnd < authorityStart || callsStart < 0 || callsEnd < callsStart) throw Error("maintained Main source markers changed");
const mainCode = new Bun.Transpiler({ loader: "ts" }).transformSync(mainSource.slice(authorityStart, authorityEnd) + "\n" + mainSource.slice(callsStart, callsEnd));
writeFileSync(import.meta.dir + "/codeshell-review-20261012-browser-lifecycle-round21-main.js", mainCode);
const bindMain = new Function("ipcMain", "bridge", "assertDesktopSessionId", "chromeExtensionRuntimeService", "chromeNativeRegistration", "app", "join", "process", mainCode);

ensureMiniDom();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
const nodes = (node: any): any[] => [node, ...Array.from(node?.childNodes ?? []).flatMap(nodes)];
const props = (node: any): any => { const key = Object.keys(node ?? {}).find(k => k.startsWith("__reactProps$")); return key ? node[key] : {}; };
const textOf = (node: any): string => node?.nodeType === 3 ? node.nodeValue ?? "" : Array.from(node?.childNodes ?? []).map(textOf).join("") || node?.textContent || "";
const tick = async () => { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); };
async function until(check: () => boolean, label: string) { const end = Date.now() + 6500; while (!check()) { if (Date.now() > end) throw Error(label); await act(tick); } }
const sessionId = "owned-browser-round21";
const tab = { id: 23, url: "http://127.0.0.1:9/owned-unloaded-page", title: "Owned memory tab" };
const receipts: any[] = [];
const fixtures: any[] = [];

async function fixture() {
  handlers.clear(); ipcCalls.length = 0; currentOwner = sender = 71; known = true;
  let connected = true;
  const nativeCalls: any[] = [];
  const backend = new ChromeExtensionBackend({ server: {
    start: async () => ({ listening: true, connected, statePath: "/tmp/owned-in-memory" }),
    stop: async () => { connected = false; },
    status: () => ({ listening: true, connected, statePath: "/tmp/owned-in-memory" }),
    request: async (type: string, payload: any) => {
      nativeCalls.push({ type, payload });
      if (!connected) throw Error("owned Native transport disconnected");
      if (type === "tab.get") return { ...tab };
      if (type === "tab.detach") return { detached: true };
      if (type === "browser.action") return { ok: true, code: "OK" };
      throw Error("unexpected Native request");
    },
  } });
  bindMain({ handle: (channel: string, callback: any) => handlers.set(channel, callback) }, {
    hasKnownSession: (id: string) => known && id === sessionId,
    panelOwnerWebContentsId: () => currentOwner,
  }, assertDesktopSessionId, backend, { installed: true, extensionPath: "/tmp/owned-extension-descriptor" }, {}, () => { throw Error("unused installation fallback"); }, process);
  handlers.set("browser-runtime:handoff-status", (_event, id) => ({ granted: false, sessionId: id }));
  // NewTabLanding's port discovery is a deliberately empty owned Host seam;
  // no TCP probe or actual webview is created in this Chrome-only UI path.
  handlers.set("ports:probe", () => []);
  Object.assign(window, { codeshell: api });
  await backend.handleExtensionMessage({ type: "hello", protocolVersion: 2 });
  const container = document.createElement("div") as any;
  const root = createRoot(container);
  const f = { backend, container, root, nativeCalls, disconnect() { connected = false; }, async reconnect() { connected = true; await backend.handleExtensionMessage({ type: "hello", protocolVersion: 2 }); } };
  fixtures.push(f);
  await act(async () => { root.render(React.createElement(ToastProvider, null, React.createElement(BrowserPanel, { cwd: null, engineSessionId: sessionId, showPopout: false }))); await tick(); });
  await until(() => ipcCalls.some(c => c.channel === "browser-runtime:chrome-status"), "initial status poll");
  return f;
}
function button(f: any, label: string) { return nodes(f.container).find(n => n.tagName === "BUTTON" && props(n)["aria-label"] === label); }
const connectLabel = "连接已登录的 Chrome 标签";
const revokeLabel = "断开 Chrome Runtime";
async function click(f: any, label: string) {
  const node = button(f, label);
  if (!node || props(node).disabled) throw Error("missing enabled button: " + label);
  await act(async () => { props(node).onClick(); await tick(); });
}
async function grantFromUi(f: any, grantId: string) {
  await click(f, connectLabel);
  await until(() => Boolean(f.backend.status(sessionId).pairing), "UI creates pairing");
  const pairing = f.backend.status(sessionId).pairing!;
  expect(textOf(f.container)).toContain(pairing.code);
  await f.backend.handleExtensionMessage({ type: "pairing.grant", code: pairing.code, grantId, tab });
  await until(() => textOf(f.container).includes("Browser Runtime 正在使用已登录的 Chrome 标签：Owned memory tab"), "actual poll commits accepted grant");
  return pairing.code;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await act(async () => { f.root.unmount(); await tick(); }); await f.backend.stop(); }
  expect(networkCalls).toBe(0); expect(subprocessCalls).toBe(0);
});
afterAll(() => writeFileSync(import.meta.dir + "/codeshell-review-20261012-browser-lifecycle-round21-observations.json", JSON.stringify({ baseline: repo, realChrome: false, realElectron: false, realNativeRelay: false, realModel: false, realWorker: false, networkCalls, subprocessCalls, receipts }, null, 2)));

test("idle Chrome disconnect survives real Panel status polls as active; formal owner gates reject other senders", async () => {
  const f = await fixture();
  sender = 72;
  await expect(api.beginChromeBrowserRuntimePairing({ sessionId })).rejects.toThrow("another window");
  expect(f.backend.status(sessionId).pairing).toBeUndefined();
  sender = 71; known = false;
  await expect(api.beginChromeBrowserRuntimePairing({ sessionId })).rejects.toThrow("live CodeShell task");
  known = true;
  await grantFromUi(f, "owned-grant-round21-0001");
  expect(f.backend.status(sessionId).connected).toBe(true);
  expect(button(f, revokeLabel)).toBeDefined();
  const before = ipcCalls.filter(c => c.channel === "browser-runtime:chrome-status").length;
  f.disconnect();
  await until(() => ipcCalls.filter(c => c.channel === "browser-runtime:chrome-status").length >= before + 2, "two actual 2s status polls after idle disconnect");
  const status = f.backend.status(sessionId);
  expect(status.connected).toBe(false);
  expect(status.granted?.grantId).toBe("owned-grant-round21-0001");
  expect(status.error).toBeUndefined();
  expect(textOf(f.container)).toContain("Browser Runtime 正在使用已登录的 Chrome 标签：Owned memory tab");
  expect(button(f, revokeLabel)).toBeDefined();
  expect(button(f, connectLabel)).toBeUndefined();
  expect(nodes(f.container).filter(n => props(n).role === "alert")).toHaveLength(0);
  expect(f.nativeCalls.filter(c => c.type === "browser.action")).toHaveLength(0);
  receipts.push({ case: "idle-disconnected", status, actualStatusPollsAfterDisconnect: ipcCalls.filter(c => c.channel === "browser-runtime:chrome-status").length - before, activeBanner: textOf(f.container).includes("Browser Runtime 正在使用"), connectButton: Boolean(button(f, connectLabel)), nativeActionCount: 0 });
});

test("explicit revoke then fresh pairing recovers through actual UI, preload and Main callbacks", async () => {
  const f = await fixture();
  const oldCode = await grantFromUi(f, "owned-grant-round21-0002");
  f.disconnect();
  await click(f, revokeLabel);
  await until(() => Boolean(button(f, connectLabel)), "revoke exposes connect");
  expect(f.backend.status(sessionId).granted).toBeUndefined();
  expect(textOf(f.container)).not.toContain("Browser Runtime 正在使用");
  const blocked = JSON.parse((await f.backend.dispatch(sessionId, { action: "navigate", url: tab.url }))!);
  expect(blocked).toMatchObject({ ok: false, code: "NEEDS_HUMAN", retryable: false });
  expect(blocked.detail).toContain("Reauthorize");
  expect(f.nativeCalls.filter(c => c.type === "browser.action")).toHaveLength(0);
  await f.reconnect();
  const newCode = await grantFromUi(f, "owned-grant-round21-0003");
  expect(newCode).not.toBe(oldCode);
  const status = f.backend.status(sessionId);
  expect(status).toMatchObject({ connected: true, granted: { grantId: "owned-grant-round21-0003", tabId: 23 } });
  const tabs = JSON.parse((await f.backend.dispatch(sessionId, { action: "listTabs" }))!);
  expect(tabs).toEqual([{ tabId: "23", url: tab.url, title: tab.title, active: true }]);
  expect(button(f, revokeLabel)).toBeDefined();
  receipts.push({ case: "explicit-revoke-repair", status, rejectedOldAction: blocked, freshListTabs: tabs, chromeProtocol: "owned authenticated-transport adapter", fullDesktop: false });
});

test("an action after idle disconnect correctly closes the old grant and the following Panel poll clears active UI", async () => {
  const f = await fixture();
  await grantFromUi(f, "owned-grant-round21-0004");
  f.disconnect();
  expect(f.backend.status(sessionId).granted).toBeDefined();
  const result = JSON.parse((await f.backend.dispatch(sessionId, { action: "navigate", url: tab.url }))!);
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("Chrome connection ended");
  expect(f.backend.status(sessionId).granted).toBeUndefined();
  expect(f.nativeCalls.filter(c => c.type === "browser.action")).toHaveLength(0);
  await until(() => Boolean(button(f, connectLabel)), "action-triggered invalidation reaches Panel poll");
  expect(textOf(f.container)).not.toContain("Browser Runtime 正在使用");
  const again = JSON.parse((await f.backend.dispatch(sessionId, { action: "navigate", url: tab.url }))!);
  expect(again).toMatchObject({ ok: false, code: "NEEDS_HUMAN", retryable: false });
  expect(again.detail).toContain("Chrome connection ended");
  receipts.push({ case: "action-fails-closed", first: result, subsequent: again, activeBannerAfterPoll: false, nativeActionCount: 0 });
});
