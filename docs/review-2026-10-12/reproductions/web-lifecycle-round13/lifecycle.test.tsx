import { afterAll, afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import childProcess from "node:child_process";

if (!process.env.CODE_SHELL_TEST_HOME) throw new Error("guarded HOME required");

// This fixture uses no real transport. All network origins and native child
// creation are denied BEFORE product modules can import Core/Main dependencies.
const guards: Array<() => void> = [];
let denied = 0;
function deny(target: any, key: string) {
  const original = target[key];
  target[key] = () => { denied++; throw new Error(`round13 forbidden ${key}`); };
  guards.push(() => { target[key] = original; });
}
for (const [target, key] of [
  [globalThis, "fetch"], [http, "request"], [http, "get"],
  [https, "request"], [https, "get"], [net, "connect"],
  [net, "createConnection"], [tls, "connect"],
  [childProcess, "spawn"], [childProcess, "spawnSync"],
  [childProcess, "exec"], [childProcess, "execFile"],
  [childProcess, "execSync"], [childProcess, "execFileSync"], [childProcess, "fork"],
] as const) deny(target, key);
const source = (file: string) => pathToFileURL(join(process.cwd(), file)).href;
const { act } = await import(source("node_modules/react/index.js"));
const { ensureMiniDom, flushMicrotasks, renderHook } = await import(source("packages/web/src/test-utils/renderHook.tsx"));
const { useRemoteSocket } = await import(source("packages/web/src/hooks/useRemoteSocket.ts"));
const { useRemoteApp } = await import(source("packages/web/src/hooks/useRemoteApp.ts"));
const { useDesktopController } = await import(source("packages/web/app/DesktopApp.tsx"));
const { DesktopChatControls } = await import(source("packages/web/app/DesktopControls.tsx"));
const { ProtocolClient } = await import(source("packages/web/app/protocol.ts"));
const { TranscriptSubscriptionManager } = await import(source("packages/desktop/src/main/cc-room/transcript-subscriptions.ts"));

const cleanup: Array<() => void | Promise<void>> = [];
const observations: any[] = [];
function property(target: object, key: string, value: any) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  cleanup.push(() => { if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key); });
}
class Storage {
  values = new Map([["cs.deviceId", "device"], ["cs.deviceSecret", "fixture-secret"], ["cs.deviceName", "Fixture"]]);
  getItem(k: string) { return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { this.values.set(k, v); }
  removeItem(k: string) { this.values.delete(k); }
}
class Socket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0; sent: any[] = [];
  onopen: any = null; onclose: any = null; onerror: any = null; onmessage: any = null;
  constructor(readonly url: string) {
    if (url !== "ws://127.0.0.1:51313/ws") throw new Error(`Unexpected mock origin ${url}`);
    Socket.instances.push(this);
  }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({code}); }
  message(value: any) { this.onmessage?.({data: JSON.stringify(value)}); }
}
function browser() {
  ensureMiniDom(); Socket.instances = [];
  property(globalThis, "WebSocket", Socket);
  property(globalThis, "localStorage", new Storage());
  property(window, "location", { origin: "http://127.0.0.1:51313", pathname: "/mobile/", search: "" });
  property(window, "history", { replaceState() {} });
  property(document, "visibilityState", "visible");
}
async function flush() { for (let i = 0; i < 4; i++) await flushMicrotasks(); }
async function step(fn: () => void | Promise<void>) { await act(async () => { await fn(); await flush(); }); }
function auth(socket: Socket) { socket.open(); socket.message({type: "auth.ok", device: {id: "device", name: "Fixture"}}); }
const room = {id: "room-A", name: "CLI A", cwd: "/repo", kind: "codex", permissionMode: "default", open: true, status: "running", createdAt: 1, lastActiveAt: 1};
async function openRoom(hook: any, socket: Socket) {
  await step(() => { auth(socket); socket.message({type: "room.list.ok", rooms: [room]}); });
  await step(() => hook.result.current.app.openCcSession("thread-A", "/repo", "default"));
  await step(() => socket.message({type: "ccRoom.opened", roomId: "room-A", sessionId: "thread-A", status: "running"}));
  await step(() => socket.message({type: "ccRoom.transcriptSubscribed", roomId: "room-A", sessionId: "thread-A", active: true, messages: [{role: "user", text: "initial"}], hasMore: false, totalCount: 1, roomCursor: 5}));
  await step(() => socket.message({type: "room.history.ok", roomId: "room-A", messages: [], latestSeq: 5}));
}
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
afterAll(() => {
  writeFileSync(fileURLToPath(new URL("./observations.json", import.meta.url)), JSON.stringify({denied, nativeChildrenCreated: 0, observations}, null, 2));
  for (const fn of guards.reverse()) fn();
});

test("socket reconnect replaces one transport, rejects old generation, and unmount removes wake listeners", async () => {
  browser();
  const resync: string[] = [];
  const seen: any[] = [];
  const hook = await renderHook(() => useRemoteSocket({onResyncNeeded: (reason: string) => resync.push(reason), onServerEvent: (event: any) => seen.push(event)}));
  cleanup.push(() => hook.unmount());
  const first = Socket.instances[0];
  await step(() => auth(first));
  const generation = hook.result.current.connectionGeneration;
  const staleMessage = first.onmessage;
  await step(() => { first.close(); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
  // A second wake event while CONNECTING replaces that pending transport;
  // count open transports rather than treating this bounded churn as a leak.
  expect(Socket.instances).toHaveLength(3);
  expect(Socket.instances.slice(0, -1).every((ws) => ws.readyState === Socket.CLOSED)).toBe(true);
  const second = Socket.instances.at(-1)!;
  await step(() => { auth(second); staleMessage({data: JSON.stringify({type: "room.error", message: "stale"})}); });
  expect(hook.result.current.connectionGeneration).toBeGreaterThan(generation);
  expect(hook.result.current.send({type: "session.list"}, generation)).toBe(false);
  expect(seen.some((event) => event.message === "stale")).toBe(false);
  await step(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("pageshow")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(resync.slice(-3)).toEqual(["focus", "pageshow", "visible"]);
  await hook.unmount(); cleanup.pop();
  expect([second.onopen, second.onmessage, second.onerror, second.onclose]).toEqual([null, null, null, null]);
  const count = Socket.instances.length;
  const calls = resync.length;
  await step(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("pageshow")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(Socket.instances.length).toBe(count);
  expect(resync.length).toBe(calls);
  observations.push({case: "socket", transports: count, staleGenerationRejected: true, staleMessageIgnored: true, wakeListenersRemoved: true});
});

test("CC catchup deduplicates seq and late room data does not replace a selected native session", async () => {
  browser();
  const hook = await renderHook(() => ({app: useRemoteApp()}));
  cleanup.push(() => hook.unmount());
  const socket = Socket.instances[0];
  await openRoom(hook, socket);
  const msg = {seq: 6, from: "agent", type: "text", text: "catchup"};
  await step(() => socket.message({type: "room.history.ok", roomId: "room-A", messages: [msg], latestSeq: 6}));
  await step(() => socket.message({type: "room.message", roomId: "room-A", msg}));
  expect(hook.result.current.app.chat.items.filter((item: any) => item.text === "catchup")).toHaveLength(1);
  await step(() => hook.result.current.app.selectSession("native-B"));
  await step(() => {
    socket.message({type: "room.history.ok", roomId: "room-A", messages: [{...msg, seq: 7, text: "late A"}], latestSeq: 7});
    socket.message({type: "ccRoom.transcriptSubscribed", roomId: "room-A", sessionId: "thread-A", active: true, messages: [{role: "user", text: "old A"}], hasMore: false, totalCount: 1, roomCursor: 6});
    socket.message({type: "ccRoom.approvalRequest", roomId: "room-A", req: {requestId: "late-approval", toolName: "Read", input: {path: "/repo/a"}}});
  });
  expect(hook.result.current.app.activeSessionId).toBe("native-B");
  expect(hook.result.current.app.activeRoom).toBeUndefined();
  expect(hook.result.current.app.chat.items).toEqual([]);
  expect(hook.result.current.app.approvals).toEqual([]);
  expect(socket.sent).toContainEqual({type: "ccRoom.unsubscribeTranscript", roomId: "room-A"});
  observations.push({case: "room-to-native", duplicateSeqAppliedOnce: true, lateOldRoomHistoryAndApprovalIgnored: true});
});

test("Hub revoked transport rejects pending RPC and prevents reconnect; explicit re-connect uses new IDs", async () => {
  browser();
  const client = new ProtocolClient("ws://127.0.0.1:51313/ws");
  cleanup.push(() => client.close());
  let authLoss = 0; const notifications: string[] = [];
  client.onAuthLost(() => authLoss++);
  const off = client.onNotification((method: string) => notifications.push(method));
  client.connect(); const first = Socket.instances[0]; first.open();
  const pending = client.listSessions().catch((error: any) => error);
  const originalId = first.sent[0].id; const stale = first.onmessage;
  first.close(4401);
  expect((await pending).kind).toBe("transport");
  expect(authLoss).toBe(1);
  await Bun.sleep(850);
  expect(Socket.instances).toHaveLength(1);
  client.connect(); const second = Socket.instances[1]; second.open();
  const fresh = client.listSessions();
  expect(second.sent[0].id).not.toBe(originalId);
  stale({data: JSON.stringify({method: "serve/workerExit", params: {}})});
  expect(notifications).toEqual([]);
  second.message({id: second.sent[0].id, result: {type: "sessions", data: []}});
  expect(await fresh).toEqual({type: "sessions", data: []});
  off(); client.close();
  observations.push({case: "Hub-auth-loss", rejectedPending: true, noAutomaticReconnect: true, explicitReconnectUsesNewRequestId: true});
});

test("transcript viewer switch/unsubscribe preserves another viewer and late old-room unsubscribe", () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-round13-transcript-"));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const files = new Map(["A", "B"].map((id) => [id, join(root, `${id}.jsonl`)]));
  const line = (role: string, text: string) => JSON.stringify({type: "response_item", payload: {type: "message", role, content: [{type: role === "user" ? "input_text" : "output_text", text}]}}) + "\n";
  for (const [id, file] of files) writeFileSync(file, line("user", `initial ${id}`));
  const stops: string[] = []; const starts: string[] = []; const pushed: any[] = [];
  let cursor = 0;
  const manager = new TranscriptSubscriptionManager({resolveFile: (target: any) => files.get(target.roomId), onStart: (id: string) => starts.push(id), onStop: (id: string) => stops.push(id), roomCursor: () => cursor, onMessages: (id: string, messages: any[]) => {cursor += messages.length; pushed.push({id, messages});}});
  cleanup.push(() => manager.closeAll());
  const subscribe = (viewer: string, id: string) => manager.subscribe({subscriberId: viewer, roomId: id, cwd: root, sessionId: id, kind: "codex", limit: 150});
  expect(subscribe("mobile:1", "A").active).toBe(true);
  expect(subscribe("mobile:2", "A").active).toBe(true);
  expect(starts).toEqual(["A"]);
  subscribe("mobile:1", "B");
  expect(stops).toEqual([]);
  manager.unsubscribe("mobile:1", "A");
  appendFileSync(files.get("B")!, line("assistant", "B new"));
  expect(subscribe("mobile:3", "B").messages.at(-1)?.text).toBe("B new");
  expect(pushed[0].id).toBe("B");
  manager.unsubscribeSubscriber("mobile:2");
  expect(stops).toEqual(["A"]);
  manager.unsubscribeSubscriber("mobile:1");
  expect(stops).toEqual(["A"]);
  manager.unsubscribeSubscriber("mobile:3");
  expect(stops).toEqual(["A", "B"]);
  observations.push({case: "viewer-subscriptions", sharedRefCount: true, lateOldRoomUnsubscribeDoesNotReleaseCurrentRoom: true, allWatchersReleased: true});
});

function findElement(tree: any, predicate: (node: any) => boolean): any {
  if (tree == null || typeof tree !== "object") return undefined;
  if (predicate(tree)) return tree;
  for (const child of [tree.props?.children].flat(3)) { const found = findElement(child, predicate); if (found) return found; }
}
test("actual leave-CLI button without approval permits idle UI and ignores later old-room approvals", async () => {
  browser();
  const hook = await renderHook(() => {const app = useRemoteApp(); return {app, controller: useDesktopController(app, undefined, () => {})};});
  cleanup.push(() => hook.unmount());
  const socket = Socket.instances[0];
  await openRoom(hook, socket);
  const leave = findElement(DesktopChatControls({app: hook.result.current.app}), (node) => node.type === "button" && node.props.children === "离开 CLI 会话");
  await step(() => leave.props.onClick());
  expect(hook.result.current.app.activeRoom).toBeUndefined();
  expect(hook.result.current.app.approvals).toEqual([]);
  expect(hook.result.current.controller.running).toBe(false);
  await step(() => socket.message({type: "ccRoom.approvalRequest", roomId: "room-A", req: {requestId: "after-leave", toolName: "Read", input: {path: "/repo/a"}}}));
  expect(hook.result.current.app.approvals).toEqual([]);
  expect(hook.result.current.controller.running).toBe(false);
  observations.push({case: "leave-CLI-normal", noPriorApprovalDoesNotBlock: true, lateOldRoomApprovalIgnored: true});
});

test("actual leave-CLI button retains the old approval and blocks independent native send until reselection", async () => {
  browser();
  const hook = await renderHook(() => {const app = useRemoteApp(); return {app, controller: useDesktopController(app, undefined, () => {})};});
  cleanup.push(() => hook.unmount());
  const socket = Socket.instances[0];
  await openRoom(hook, socket);
  await step(() => socket.message({type: "session.list.ok", sessions: [{id: "native-B", title: "Native B", cwd: "/repo", updatedAt: 1}], activeSessionId: undefined}));
  await step(() => socket.message({type: "ccRoom.approvalRequest", roomId: "room-A", req: {requestId: "approval-A", toolName: "Read", description: "Read A", input: {path: "/repo/a"}}}));
  expect(hook.result.current.app.approvals).toHaveLength(1);
  expect(hook.result.current.app.activeRoom?.id).toBe("room-A");
  const tree = DesktopChatControls({app: hook.result.current.app});
  const leave = findElement(tree, (node) => node.type === "button" && node.props.children === "离开 CLI 会话");
  expect(typeof leave?.props.onClick).toBe("function");
  await step(() => leave.props.onClick());
  expect(hook.result.current.app.activeRoom).toBeUndefined();
  expect(hook.result.current.app.chat.items).toEqual([]);
  expect(hook.result.current.app.approvals[0]?.roomId).toBe("room-A");
  expect(hook.result.current.controller.running).toBe(true);
  await step(() => hook.result.current.controller.setDraft("independent native task"));
  expect(hook.result.current.controller.send()).toBe(false);
  expect(socket.sent.some((event) => event.type === "chat.send")).toBe(false);
  expect(hook.result.current.controller.sessions.some((item: any) => item.sessionId === "native-B")).toBe(true);
  await step(() => hook.result.current.controller.selectSession("native-B"));
  expect(hook.result.current.app.approvals).toEqual([]);
  expect(hook.result.current.controller.running).toBe(false);
  observations.push({case: "leave-CLI-approval", actualButtonCallback: true, roomAfterLeave: null, retainedApprovalRoom: "room-A", independentSendBlocked: true, reselectNativeClearsApproval: true, noRealResidentOrModel: true});
});
