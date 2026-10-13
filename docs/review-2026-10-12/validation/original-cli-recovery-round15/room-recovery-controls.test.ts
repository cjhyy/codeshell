import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import tls from "node:tls";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded isolated HOME required");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const deny = () => { throw Error("NETWORK_FORBIDDEN_round15"); };
net.connect = net.createConnection = deny as any; tls.connect = deny as any;
const { RoomManager } = await import(`${repo}/packages/server/src/mobile-remote/room-manager.ts`);
const { TranscriptSubscriptionManager } = await import(`${repo}/packages/desktop/src/main/cc-room/transcript-subscriptions.ts`);
const { ApprovalBridge } = await import(`${repo}/packages/desktop/src/main/cc-room/approval-bridge.ts`);
let temporary = ""; const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); if (temporary) rmSync(temporary, { recursive: true, force: true }); temporary = ""; });
function temp() { temporary = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-room-recovery-round15-"))); return temporary; }
function fakeAgent(meta: any, emit: any) {
  return { mode: meta.permissionMode, started: false, sent: [] as string[], controls: [] as any[], emit,
    start() { this.started = true; }, stop() { this.started = false; }, isRunning() { return this.started; },
    send(value: string) { if (!this.started) return false; this.sent.push(value); return true; },
    respondControl(...args: any[]) { this.controls.push(args); } };
}

test("CONTROL close/reopen and changed-mode restart reject old-agent output and approvals; persisted room identity resumes after manager recreation", async () => {
  const root = temp(), agents: any[] = [], resolved: any[] = [];
  const bridge = new ApprovalBridge({ timeoutMs: 1000, onPush() {}, onResolve: (...args: any[]) => resolved.push(args) });
  const pending: Promise<any>[] = [];
  const manager = new RoomManager({ rootDir: join(root, "rooms"), onMessage() {},
    createAgent: (meta: any, emit: any) => { const a = fakeAgent(meta, emit); agents.push(a); return a; },
    onApprovalRequest: (id: string, req: any) => { pending.push(bridge.request(id, req.requestId, req).then((d: any) => manager.respondApproval(id, req.requestId, d))); },
    onRoomEnded: (id: string) => bridge.cancelRoom(id),
  }); cleanup.push(() => manager.closeAll());
  const first = manager.openForSession("owned-thread", root, "default", "claude-code");
  agents[0].emit({ type: "approval_request", requestId: "old-control", toolName: "Read", input: { path: "owned.txt" } });
  expect(resolved).toHaveLength(0);
  manager.close(first.roomId); await Promise.all(pending);
  expect(resolved).toHaveLength(1); expect(agents[0].controls).toHaveLength(0); expect(manager.isOpen(first.roomId)).toBe(false);
  const afterClose = manager.getMessages(first.roomId).length;
  const reopened = manager.openForSession("owned-thread", root, "default", "claude-code");
  expect(reopened.roomId).toBe(first.roomId); expect(agents).toHaveLength(2);
  for (const ev of [{ type: "text", text: "stale" }, { type: "exit", code: 0 }, { type: "approval_request", requestId: "late", toolName: "Read", input: {} }]) agents[0].emit(ev);
  expect(manager.getMessages(first.roomId)).toHaveLength(afterClose); expect(manager.isOpen(first.roomId)).toBe(true); expect(resolved).toHaveLength(1);
  expect(manager.respondApproval(first.roomId, "old-control", { behavior: "allow" })).toBe(false);
  manager.openForSession("owned-thread", root, "acceptEdits", "claude-code");
  expect(agents).toHaveLength(3); expect(agents[1].isRunning()).toBe(false); expect(agents[2].mode).toBe("acceptEdits");
  expect(manager.send(first.roomId, "owned subsequent prompt")).toBe(true); expect(agents[2].sent).toEqual(["owned subsequent prompt"]);
  manager.closeAll();
  const restoredAgents: any[] = [];
  const restored = new RoomManager({ rootDir: join(root, "rooms"), onMessage() {}, createAgent: (meta: any, emit: any) => { const a = fakeAgent(meta, emit); restoredAgents.push(a); return a; } });
  cleanup.push(() => restored.closeAll());
  const again = restored.openForSession("owned-thread", root, "acceptEdits", "claude-code");
  expect(again.roomId).toBe(first.roomId); expect(restored.listRooms()).toHaveLength(1); expect(restoredAgents).toHaveLength(1); expect(restoredAgents[0].mode).toBe("acceptEdits");
  expect(restored.getMessages(first.roomId).some((m: any) => m.text === "owned subsequent prompt")).toBe(true);
  console.log(JSON.stringify({ control: "room-close-mode-restore", oldAgentEventsIgnored: true, pendingApprovalCancelledBeforeNewAgent: true, sameRoomRestoredFromDisk: true, actualCliSpawned: false }));
});

test("CONTROL viewer disconnect releases only its subscription, final room close drains output, and resubscribe obtains stable history without duplicate pushes", () => {
  const root = temp(), file = join(root, "owned.jsonl");
  writeFileSync(file, ""); const starts: string[] = [], stops: string[] = [], pushes: any[] = []; let cursor = 0;
  const follower = new TranscriptSubscriptionManager({ resolveFile: () => file, pollIntervalMs: 60_000,
    onStart: id => starts.push(id), onStop: id => stops.push(id), roomCursor: () => cursor,
    onMessages: (_id, messages) => { pushes.push(...messages); cursor += messages.length; } }); cleanup.push(() => follower.closeAll());
  const req = (subscriberId: string) => ({ subscriberId, roomId: "owned-room", cwd: root, sessionId: "owned-thread", kind: "claude-code" as const, limit: 50 });
  expect(follower.subscribe(req("mobile:viewer-a")).active).toBe(true);
  expect(follower.subscribe(req("mobile:viewer-b")).active).toBe(true);
  expect(starts).toEqual(["owned-room"]);
  follower.unsubscribeSubscriber("mobile:viewer-a"); expect(stops).toEqual([]);
  appendFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "final owned bytes" }] } }) + "\n");
  follower.endRoom("owned-room"); expect(pushes).toEqual([{ from: "agent", type: "text", text: "final owned bytes" }]); expect(stops).toEqual(["owned-room"]);
  const snapshot = follower.subscribe(req("mobile:viewer-a-reconnected"));
  expect(snapshot.active).toBe(true); expect(snapshot.messages.map((m: any) => m.text)).toEqual(["final owned bytes"]); expect(snapshot.roomCursor).toBe(1); expect(pushes).toHaveLength(1);
  follower.unsubscribe("mobile:viewer-a-reconnected", "different-room"); expect(stops).toHaveLength(1);
  follower.unsubscribeSubscriber("mobile:viewer-a-reconnected"); expect(stops).toHaveLength(2);
  console.log(JSON.stringify({ control: "viewer-disconnect-and-room-reopen", perViewerRelease: true, finalBytesDrained: true, stableSnapshotWithoutLiveDuplicate: true, actualWatcherOnOwnedFile: true }));
});

test("CONTROL synchronous failed start is retired and same-mode retry works; room kinds do not share an external identity", () => {
  const root = temp(), agents: any[] = []; let fail = true;
  const manager = new RoomManager({ rootDir: join(root, "rooms"), onMessage() {}, createAgent: (meta: any, emit: any) => {
    const a = fakeAgent(meta, emit); if (fail) a.start = () => { throw Error("owned synchronous start rejection"); }; agents.push(a); return a;
  } }); cleanup.push(() => manager.closeAll());
  expect(() => manager.openForSession("same-id", root, "default", "claude-code")).toThrow("owned synchronous start rejection");
  expect(manager.isOpen(manager.listRooms()[0].id)).toBe(false);
  fail = false;
  const c = manager.openForSession("same-id", root, "default", "claude-code"), x = manager.openForSession("same-id", root, "default", "codex");
  expect(c.status).toBe("running"); expect(x.status).toBe("running"); expect(c.roomId).not.toBe(x.roomId); expect(agents).toHaveLength(3);
  expect(manager.getRoom(c.roomId).kind).toBe("claude-code"); expect(manager.getRoom(x.roomId).kind).toBe("codex");
  console.log(JSON.stringify({ control: "synchronous-start-retry", retrySameModeWorks: true, kindIdentitySeparated: true, distinctFromR18AsyncError: true }));
});
