import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// No actual transport is required. Install guards before Main/Core imports.
const restores: Array<() => void> = [];
let denied = 0;
function deny(target: any, key: string) {
  const old = target[key];
  target[key] = () => { denied++; throw new Error("Network denied by round10 fixture"); };
  restores.push(() => { target[key] = old; });
}
for (const [target, key] of [[globalThis, "fetch"], [http, "request"], [http, "get"], [https, "request"], [https, "get"], [net, "connect"], [net, "createConnection"], [tls, "connect"]] as const) deny(target, key);
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const source = (file: string) => pathToFileURL(join(repo, file)).href;
const { ensureMiniDom, flushMicrotasks, renderHook } = await import(source("packages/web/src/test-utils/renderHook.tsx"));
const { useRemoteApp } = await import(source("packages/web/src/hooks/useRemoteApp.ts"));
const { useDesktopController } = await import(source("packages/web/app/DesktopApp.tsx"));
const { SessionManager } = await import("@cjhyy/code-shell-core");
const { SessionOutputJournal, SessionOutputCoverageStore } = await import("@cjhyy/code-shell-core/internal");
const { SessionSnapshotStore } = await import(source("packages/desktop/src/main/SessionSnapshotStore.ts"));
const { MobileOutputRecovery } = await import(source("packages/desktop/src/main/mobile-remote/output-recovery.ts"));

class Storage {
  values = new Map([ ["cs.deviceId", "device"], ["cs.deviceSecret", "fixture-secret"], ["cs.deviceName", "Fixture"] ]);
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
class Socket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0; sent: any[] = [];
  onopen: any; onclose: any; onerror: any; onmessage: any;
  constructor(readonly url: string) { Socket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(event: any) { this.onmessage?.({data: JSON.stringify(event)}); }
}
const cleanup: Array<() => void | Promise<void>> = [];
function property(target: object, key: string, value: any) {
  const old = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  cleanup.push(() => { if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key); });
}
async function flush() { for (let n = 0; n < 8; n++) await flushMicrotasks(); }
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const observations: any[] = [];
afterAll(() => {
  writeFileSync(fileURLToPath(new URL("./modern-intent-observations.json", import.meta.url)), JSON.stringify({guard: {negativeProbes: 3, denied, unexpected: denied - 3}, observations}, null, 2));
  for (const fn of restores.reverse()) fn();
});

async function fixture() {
  ensureMiniDom(); Socket.instances = [];
  property(globalThis, "WebSocket", Socket);
  property(globalThis, "localStorage", new Storage());
  property(window, "location", {origin: "http://fixture.invalid", pathname: "/mobile/", search: ""});
  property(window, "history", {replaceState() {}});
  property(window, "fetch", globalThis.fetch);
  const directory = mkdtempSync(join(tmpdir(), "codeshell-round10-journal-"));
  cleanup.push(() => rmSync(directory, {recursive: true, force: true}));
  const manager = new SessionManager(directory);
  const session = manager.create(directory, "fixture", "fixture", "native");
  manager.startSessionRun(session.state, "previous-run");
  let writer = new SessionOutputJournal(directory, "native", "previous-run", session.transcript.getEvents()[0].id);
  const snapshots = new SessionSnapshotStore({maxPerSession: 2, coverage: new SessionOutputCoverageStore(() => directory)});
  function publish(event: any) {
    const decorated = {...event, outputCursor: writer.append(event)};
    return {type: "session.stream", sessionId: "native", epoch: snapshots.epoch, ...snapshots.append("native", decorated)};
  }
  publish({type: "stream_request_start", turnNumber: 1});
  publish({type: "text_delta", text: "previous answer"});
  publish({type: "turn_complete", reason: "completed"});
  manager.updateSessionState("native", {status: "completed"}, "previous-run");
  const hook = await renderHook(() => {
    const app = useRemoteApp();
    return {app, controller: useDesktopController(app, undefined, () => {})};
  });
  cleanup.push(() => hook.unmount());
  let current = Socket.instances[0];
  const replies: any[] = [];
  const service = new MobileOutputRecovery({
    root: () => directory,
    authority: async () => "mounted-project-incarnation",
    snapshot: () => snapshots.get("native"),
    reply: (_viewer: string, event: any) => { replies.push(event); current.message(event); },
  });
  const indices = new Map<Socket, number>();
  async function pump() {
    for (let round = 0; round < 100; round++) {
      const pending = current.sent.slice(indices.get(current) ?? 0);
      indices.set(current, current.sent.length);
      if (!pending.length) break;
      await act(async () => {
        for (const frame of pending) {
          if (["session.select", "session.outputJournal", "session.recovery.cancel"].includes(frame.type))
            await service.handle({...frame, deviceId: "device", viewerId: `tab-${Socket.instances.indexOf(current)}`});
        }
        await flush();
      });
    }
  }
  async function authenticate() {
    await act(async () => {
      current.open(); current.message({type: "auth.ok", device: {id: "device", name: "Fixture"}, capabilities: {outputJournal: 1}});
      await flush();
    });
  }
  await authenticate();
  await act(async () => { hook.result.current.controller.selectSession("native"); await flush(); });
  await pump();
  expect(hook.result.current.app.chat.run).toBe("completed");
  async function reconnect() {
    service.revoke(`tab-${Socket.instances.indexOf(current)}`);
    await act(async () => { window.dispatchEvent(new Event("online")); await flush(); });
    current = Socket.instances.at(-1)!;
    await authenticate();
    await pump();
  }
  return {hook, socket: () => current, publish, pump, reconnect, replies,
    state: () => manager.readSessionState("native"),
    finishRun: (id: string) => manager.updateSessionState("native", {status: "completed"}, id),
    nextRun: (id: string, clientMessageId: string) => { manager.startSessionRun(manager.readSessionState("native")!, id, clientMessageId); writer = new SessionOutputJournal(directory, "native", id); }};
}

test("normal: acknowledged task does not restore a resendable draft after reconnect", async () => {
  expect(() => globalThis.fetch("https://denied.invalid")).toThrow("Network denied");
  expect(() => http.get("http://denied.invalid")).toThrow("Network denied");
  expect(() => net.connect(1, "127.0.0.1")).toThrow("Network denied");
  const f = await fixture();
  await act(async () => { f.hook.result.current.controller.setDraft("accepted task"); await flush(); });
  await act(async () => { expect(f.hook.result.current.controller.send()).toBe(true); await flush(); });
  const frame = f.socket().sent.find(frame => frame.type === "chat.send");
  await act(async () => { f.socket().message({type: "chat.accepted", sessionId: "native", clientMessageId: frame.clientMessageId, cwd: null}); await flush(); });
  expect(f.hook.result.current.controller.draft).toBe("");
  await act(async () => { f.socket().close(); await flush(); });
  await f.reconnect();
  expect(f.hook.result.current.controller.draft).toBe("");
  observations.push({case: "ACK before disconnect", restoredDraft: false});
});

test("confirmed: journal recovery with matching input identity does not reconcile a lost mobile ACK", async () => {
  const f = await fixture();
  await act(async () => { f.hook.result.current.controller.setDraft("execute exactly once"); await flush(); });
  await act(async () => { expect(f.hook.result.current.controller.send()).toBe(true); await flush(); });
  const first = f.socket().sent.find(frame => frame.type === "chat.send");
  expect(first.sessionId).toBe("native");
  expect(first.clientMessageId).toBeString();
  // The producer has accepted this request, but the transport closes before its
  // admission ACK reaches this tab. No selective loss on a live ordered socket.
  await act(async () => { f.socket().close(); await flush(); });
  expect(f.hook.result.current.controller.draft).toBe("execute exactly once");
  f.nextRun("accepted-offline-run", first.clientMessageId);
  for (const event of [
    {type: "session_user_message", text: "execute exactly once"},
    {type: "stream_request_start", turnNumber: 1, messageId: "offline-reply"},
    {type: "text_delta", text: "completed exactly once"},
    {type: "turn_complete", reason: "completed"},
  ]) f.publish({...event, runId: "accepted-offline-run", clientMessageId: first.clientMessageId});
  f.finishRun("accepted-offline-run");
  expect(f.state().status).toBe("completed");
  expect(f.state().clientMessageId).toBe(first.clientMessageId);
  await f.reconnect();
  expect(f.replies.some(event => event.type === "session.outputJournal" && event.page.complete)).toBe(true);
  expect(f.hook.result.current.app.chat.run).toBe("completed");
  expect(f.hook.result.current.app.chat.items.some((item: any) => item.kind === "user" && item.clientMessageId === first.clientMessageId && item.text === "execute exactly once")).toBe(true);
  expect(f.hook.result.current.app.chat.items.some((item: any) => item.kind === "assistant" && item.text === "completed exactly once")).toBe(true);
  expect(f.hook.result.current.controller.draft).toBe("execute exactly once");
  expect(f.hook.result.current.controller.uncertain).toBe(false);
  await act(async () => { expect(f.hook.result.current.controller.send()).toBe(true); await flush(); });
  const retry = f.socket().sent.filter(frame => frame.type === "chat.send").at(-1);
  expect(retry.clientMessageId).not.toBe(first.clientMessageId);
  await act(async () => { f.socket().message({type: "chat.accepted", sessionId: "native", clientMessageId: retry.clientMessageId, cwd: null}); await flush(); });
  observations.push({case: "disconnect before ACK, completion while offline, modern journal recovery", matchingInputRecovered: true, completedOutputRecovered: true, restoredDraft: true, uncertain: false, retryUsesDifferentId: true});
  expect(denied).toBe(3);
});
