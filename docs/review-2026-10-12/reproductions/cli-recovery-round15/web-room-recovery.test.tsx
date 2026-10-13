import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import net from "node:net";
import tls from "node:tls";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded isolated HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => { throw Error("NETWORK_FORBIDDEN_round15"); };
net.connect = net.createConnection = deny as any; tls.connect = deny as any;
const { ensureMiniDom, flushMicrotasks, renderHook } = await import(`${repo}/packages/web/src/test-utils/renderHook.tsx`);
const { useRemoteApp } = await import(`${repo}/packages/web/src/hooks/useRemoteApp.ts`);
class MemoryStorage {
  values = new Map<string, string>();
  getItem(k: string) { return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { this.values.set(k, v); }
  removeItem(k: string) { this.values.delete(k); }
}
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3; static instances: FakeWebSocket[] = [];
  readyState = 0; sent: string[] = []; onopen: any; onmessage: any; onclose: any; onerror: any;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(value: any) { this.onmessage?.({ data: JSON.stringify(value) }); }
  frames() { return this.sent.map(s => JSON.parse(s)); }
}
let hook: any; const restores: Array<() => void> = [];
function define(target: any, key: string, value: any) {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => { if (previous) Object.defineProperty(target, key, previous); else Reflect.deleteProperty(target, key); });
}
async function settle() { await flushMicrotasks(); await new Promise(r => setTimeout(r, 0)); await flushMicrotasks(); }
async function run(f: () => void) { await act(async () => { f(); await settle(); }); }
async function fixture() {
  ensureMiniDom(); FakeWebSocket.instances = [];
  const storage = new MemoryStorage(); storage.setItem("cs.deviceId", "owned-device"); storage.setItem("cs.deviceSecret", "owned-fixture-secret"); storage.setItem("cs.deviceName", "Fixture");
  define(globalThis, "localStorage", storage); define(globalThis, "WebSocket", FakeWebSocket);
  define(window, "location", { origin: "http://127.0.0.1:9", search: "", pathname: "/mobile" });
  define(window, "history", { replaceState() {} });
  hook = await renderHook(() => useRemoteApp());
  const ws = FakeWebSocket.instances[0];
  await run(() => { ws.open(); ws.message({ type: "auth.ok", device: { id: "owned-device", name: "Fixture" } }); ws.message({ type: "room.projects.ok", projects: [{ path: "/owned-A", name: "A" }, { path: "/owned-B", name: "B" }] }); ws.message({ type: "room.list.ok", rooms: [{ id: "owned-room", name: "Owned Room", cwd: "/owned-A", kind: "claude-code", permissionMode: "default", open: true, createdAt: 1, lastActiveAt: 1 }] }); });
  return ws;
}
afterEach(async () => { await hook?.unmount(); hook = undefined; for (const f of restores.splice(0).reverse()) f(); FakeWebSocket.instances = []; });

test("CONTROL reconnect retains opened room cwd/kind despite sidebar changes and deduplicates snapshot catchup", async () => {
  const ws = await fixture();
  await run(() => { hook.result.current.selectProject("/owned-A"); hook.result.current.setCcCliKind("codex"); });
  await run(() => hook.result.current.openCcSession("owned-thread", "/owned-A", "default"));
  expect(ws.frames()).toContainEqual({ type: "ccRoom.openSession", sessionId: "owned-thread", cwd: "/owned-A", mode: "default", kind: "codex" });
  await run(() => ws.message({ type: "ccRoom.opened", roomId: "owned-room", sessionId: "owned-thread", status: "running" }));
  await run(() => ws.message({ type: "ccRoom.transcriptSubscribed", roomId: "owned-room", sessionId: "owned-thread", active: true, messages: [], hasMore: false, totalCount: 0, roomCursor: 7 }));
  await run(() => { hook.result.current.selectProject("/owned-B"); hook.result.current.setCcCliKind("claude-code"); });
  await run(() => { ws.close(); window.dispatchEvent(new Event("online")); });
  const next = FakeWebSocket.instances[1]; expect(next).toBeDefined();
  await run(() => { next.open(); next.message({ type: "auth.ok", device: { id: "owned-device", name: "Fixture" } }); });
  expect(next.frames().filter(e => e.type === "ccRoom.subscribeTranscript")).toEqual([{ type: "ccRoom.subscribeTranscript", roomId: "owned-room", cwd: "/owned-A", sessionId: "owned-thread", limit: 150, kind: "codex" }]);
  const stale = { seq: 8, from: "agent", type: "text", text: "ignored-old-socket" };
  await run(() => ws.message({ type: "room.message", roomId: "owned-room", msg: stale }));
  expect(JSON.stringify(hook.result.current.chat)).not.toContain("ignored-old-socket");
  await run(() => next.message({ type: "ccRoom.transcriptSubscribed", roomId: "owned-room", sessionId: "owned-thread", active: true, messages: [{ role: "user", text: "restored owned history" }], hasMore: false, totalCount: 1, roomCursor: 7 }));
  const live = { seq: 8, from: "agent", type: "text", text: "owned catchup answer" };
  await run(() => { next.message({ type: "room.history.ok", roomId: "owned-room", messages: [live], latestSeq: 8 }); next.message({ type: "room.message", roomId: "owned-room", msg: live }); });
  const data = JSON.stringify(hook.result.current.chat);
  expect(data).toContain("restored owned history"); expect(data.match(/owned catchup answer/g)).toHaveLength(1);
  expect(hook.result.current.loading.roomHistory).toBe(false);
  console.log(JSON.stringify({ control: "cli-room-reconnect", openedCwdAndKindRetained: true, staleSocketIgnored: true, duplicateCatchupIgnored: true, actualHookWithFakeSocket: true }));
});

test("CONTROL leave unsubscribes without closing CLI, ignores old transcript reply, and reopening establishes a fresh subscription", async () => {
  const ws = await fixture();
  await run(() => { hook.result.current.selectProject("/owned-A"); hook.result.current.openCcSession("owned-thread", "/owned-A", "default"); });
  await run(() => ws.message({ type: "ccRoom.opened", roomId: "owned-room", sessionId: "owned-thread", status: "running" }));
  await run(() => hook.result.current.leaveRoom());
  expect(ws.frames()).toContainEqual({ type: "ccRoom.unsubscribeTranscript", roomId: "owned-room" });
  expect(ws.frames().some(e => e.type === "room.close")).toBe(false);
  expect(hook.result.current.activeRoom).toBeUndefined(); expect(hook.result.current.loading.roomHistory).toBe(false);
  await run(() => ws.message({ type: "ccRoom.transcriptSubscribed", roomId: "owned-room", sessionId: "owned-thread", active: true, messages: [{ role: "user", text: "stale closed view" }], hasMore: false, totalCount: 1, roomCursor: 5 }));
  expect(JSON.stringify(hook.result.current.chat)).not.toContain("stale closed view");
  const subscriptionCount = ws.frames().filter(e => e.type === "ccRoom.subscribeTranscript").length;
  await run(() => window.dispatchEvent(new Event("focus")));
  expect(ws.frames().filter(e => e.type === "ccRoom.subscribeTranscript")).toHaveLength(subscriptionCount);
  await run(() => hook.result.current.openCcSession("owned-thread", "/owned-A", "default"));
  await run(() => ws.message({ type: "ccRoom.opened", roomId: "owned-room", sessionId: "owned-thread", status: "running" }));
  expect(hook.result.current.activeRoom?.id).toBe("owned-room");
  expect(ws.frames().filter(e => e.type === "ccRoom.subscribeTranscript")).toHaveLength(subscriptionCount + 1);
  console.log(JSON.stringify({ control: "leave-and-reopen", unsubscribeOnly: true, oldTranscriptCannotNavigate: true, noClosedRoomResubscribeOnFocus: true, freshReopenSubscription: true, approvalCaseExcludedAsR62: true }));
});
