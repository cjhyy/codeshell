import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const evidence = fileURLToPath(new URL("./", import.meta.url));
const isolation = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
isolation.installLocalNetworkGuard("http://127.0.0.1:9");
const { act } = await import(repo + "/node_modules/react/index.js");
const { ensureMiniDom, flushMicrotasks, renderHook } = await import(repo + "/packages/web/src/test-utils/renderHook.tsx");
const { useRemoteSocket } = await import(repo + "/packages/web/src/hooks/useRemoteSocket.ts");
const { ProtocolClient } = await import(repo + "/packages/web/app/protocol.ts");
const { DesktopApp } = await import(repo + "/packages/web/app/DesktopApp.tsx");
const { AuthGate } = await import(repo + "/packages/web/app/AuthGate.tsx");
const observations: any[] = [];
const nativeFetch = globalThis.fetch, nativeWebSocket = globalThis.WebSocket;
let restorers: Array<() => void> = [];
class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
class Socket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0; sent: any[] = [];
  onopen: any; onmessage: any; onclose: any; onerror: any;
  constructor(readonly url: string) {
    if (new URL(url.replace("ws:", "http:")).origin !== "http://127.0.0.1:9") throw new Error("non-fixture socket");
    Socket.instances.push(this);
  }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  receive(body: any) { this.onmessage?.({ data: JSON.stringify(body) }); }
}
function property(target: any, key: string, value: any) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restorers.push(() => old ? Object.defineProperty(target, key, old) : Reflect.deleteProperty(target, key));
}
function browser() {
  ensureMiniDom(); Socket.instances = [];
  const storage = new MemoryStorage(); storage.setItem("cs.deviceId", "fixture-device"); storage.setItem("cs.deviceSecret", "fixture-secret"); storage.setItem("cs.deviceName", "fixture-browser");
  property(globalThis, "localStorage", storage); property(globalThis, "sessionStorage", new MemoryStorage());
  property(globalThis, "WebSocket", Socket);
  property(window, "location", { origin: "http://127.0.0.1:9", pathname: "/mobile/", search: "", hash: "", href: "http://127.0.0.1:9/mobile/" });
  property(window, "history", { replaceState() {} }); property(document, "visibilityState", "visible");
  return storage;
}
function leaves(element: any): any[] {
  if (element == null || typeof element === "boolean") return [];
  if (Array.isArray(element)) return element.flatMap(leaves);
  if (typeof element !== "object") return [element];
  return [element, ...leaves(element.props?.children)];
}
function text(element: any) { return leaves(element).filter((v) => typeof v === "string").join(" "); }
function button(element: any, label: string) { return leaves(element).find((el) => el?.type === "button" && text(el) === label); }
async function settle() { await flushMicrotasks(); await Bun.sleep(2); await flushMicrotasks(); }
function fakeFetch(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://127.0.0.1:9");
    if (url.origin !== "http://127.0.0.1:9") throw new Error("non-fixture fetch");
    return handler(url.pathname, init);
  }) as any;
}
afterEach(() => {
  globalThis.fetch = nativeFetch; globalThis.WebSocket = nativeWebSocket;
  for (const restore of restorers.splice(0).reverse()) restore();
  writeFileSync(evidence + "/browser-recovery-observed.json", JSON.stringify(observations, null, 2));
});

test("paired socket reconnects on focus with retained credentials, ignores late old frames, and stops on logout", async () => {
  const storage = browser(); const hook = await renderHook(() => useRemoteSocket({}));
  const first = Socket.instances[0];
  await act(async () => { first.open(); first.receive({ type: "auth.ok", device: { id: "fixture-device", name: "Fixture" } }); await settle(); });
  const generation = hook.result.current.connectionGeneration;
  await act(async () => { first.close(); window.dispatchEvent(new Event("focus")); await settle(); });
  const next = Socket.instances[1];
  expect(next.sent).toEqual([]);
  await act(async () => { next.open(); next.receive({ type: "auth.ok", device: { id: "fixture-device", name: "Fixture" } }); await settle(); });
  expect(next.sent[0]).toMatchObject({ type: "auth.device", deviceId: "fixture-device", secretHash: "fixture-secret" });
  expect(hook.result.current.connectionGeneration).toBeGreaterThan(generation);
  await act(async () => { first.receive({ type: "auth.failed", message: "late stale frame" }); await settle(); });
  expect(hook.result.current.status).toBe("online");
  expect(hook.result.current.send({ type: "session.list" }, generation)).toBe(false);
  await act(async () => { hook.result.current.logout(); window.dispatchEvent(new Event("focus")); await settle(); });
  expect(hook.result.current.status).toBe("unpaired"); expect(storage.getItem("cs.deviceId")).toBeNull(); expect(Socket.instances).toHaveLength(2);
  await hook.unmount();
  observations.push({ test: "paired focus reconnect", retainedCredentials: true, generationFence: true, lateFrameIgnored: true, logoutStopsReconnect: true });
});

test("Hub transport treats revoke as explicit auth loss and transport failure as retryable", async () => {
  browser(); const client = new ProtocolClient("ws://127.0.0.1:9/ws"); let lost = 0; client.onAuthLost(() => lost++);
  client.connect(); const first = Socket.instances[0]; first.open(); first.close(4401);
  expect(lost).toBe(1); await Bun.sleep(850); expect(Socket.instances).toHaveLength(1);
  client.connect(); const second = Socket.instances[1]; second.open(); second.close(1006);
  await Bun.sleep(850); expect(Socket.instances).toHaveLength(3); expect(lost).toBe(1);
  client.close(); observations.push({ test: "hub protocol close", authCloseStopsRetry: true, transportCloseRetries: true });
});

test("Desktop initial HTTP handshake failure renders an actionable retry and retry succeeds", async () => {
  browser(); let handshakes = 0;
  fakeFetch((path) => {
    if (path === "/api/v1/desktop/session") return ++handshakes === 1 ? Response.json({ error: "synthetic temporary service failure" }, { status: 503 }) : Response.json({ authenticated: true, session: { id: "http-owner", username: "device", deviceName: "Fixture" } });
    if (path === "/api/v1/configuration") return Response.json({ workspace: { path: "/fixture", settingsScope: "local", skillDirectories: [] }, defaults: {}, connections: [], catalog: [], skills: [], mcpServers: [], restartRequired: false });
    return Response.json({});
  });
  const hook = await renderHook(() => DesktopApp()); const ws = Socket.instances[0];
  await act(async () => { ws.open(); ws.receive({ type: "auth.ok", device: { id: "fixture-device", name: "Fixture" } }); await settle(); });
  expect(text(hook.result.current)).toContain("桌面连接需要重试");
  expect(text(hook.result.current)).toContain("synthetic temporary service failure");
  expect(button(hook.result.current, "重新配对")).toBeDefined();
  await act(async () => { button(hook.result.current, "重试").props.onClick(); await settle(); });
  expect(handshakes).toBe(2); expect((hook.result.current as any).type.name).toBe("Workbench");
  await hook.unmount(); observations.push({ test: "desktop handshake retry UI", errorVisible: true, retryWorks: true, noQrRequired: true });
});

test("Desktop HTTP cookie expiry triggers a new handshake while retaining the current unsent draft", async () => {
  browser(); let handshakes = 0, expireNextConfig = false;
  fakeFetch((path) => {
    if (path === "/api/v1/desktop/session") return Response.json({ authenticated: true, session: { id: `owner-${++handshakes}`, username: "device", deviceName: "Fixture" } });
    if (path === "/api/v1/configuration") {
      if (expireNextConfig) { expireNextConfig = false; return Response.json({ error: "session expired" }, { status: 401 }); }
      return Response.json({ workspace: { path: "/fixture", settingsScope: "local", skillDirectories: [] }, defaults: {}, connections: [], catalog: [], skills: [], mcpServers: [], restartRequired: false });
    }
    return Response.json({});
  });
  const hook = await renderHook(() => DesktopApp()); const ws = Socket.instances[0];
  await act(async () => { ws.open(); ws.receive({ type: "auth.ok", device: { id: "fixture-device", name: "Fixture" } }); await settle(); });
  await act(async () => { (hook.result.current as any).props.controller.setDraft("retained during cookie renewal"); await settle(); });
  expireNextConfig = true;
  await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); });
  expect(handshakes).toBe(2); expect((hook.result.current as any).type.name).toBe("Workbench");
  expect((hook.result.current as any).props.controller.draft).toBe("retained during cookie renewal");
  expect(Socket.instances).toHaveLength(1); await hook.unmount();
  observations.push({ test: "desktop cookie expiry UI", handshakeRetried: true, draftRetained: true, wsRePairNotNeeded: true });
});

test("Hub auth gate gives a login instruction after revocation, recovers a newly shared cookie on focus, and preserves active view on temporary check failure", async () => {
  browser(); let authenticated = true, unavailable = false;
  fakeFetch((path) => {
    if (path !== "/api/v1/auth/status") return Response.json({});
    if (unavailable) return Response.json({ error: "temporary service restart" }, { status: 503 });
    return Response.json({ initialized: true, authenticated, ...(authenticated ? { session: { id: "new-cookie-owner", username: "owner", deviceName: "browser" } } : {}) });
  });
  const hook = await renderHook(() => AuthGate({ setupToken: "" }));
  expect((hook.result.current as any).type.name).toBe("ProjectsGate");
  unavailable = true; await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); });
  expect((hook.result.current as any).type.name).toBe("ProjectsGate");
  unavailable = false; authenticated = false;
  await act(async () => { (hook.result.current as any).props.onAuthLost(); await settle(); });
  expect(text(hook.result.current)).toContain("登录已过期或此设备已被撤销，请重新登录。");
  expect(text(hook.result.current)).toContain("登录工作空间");
  authenticated = true; await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); });
  expect((hook.result.current as any).type.name).toBe("ProjectsGate");
  await hook.unmount(); observations.push({ test: "hub auth UI", revokeGuidance: true, newSharedCookieFocusRecovery: true, temporaryFailurePreservesActiveView: true });
});
