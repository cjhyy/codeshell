import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RoomManager, type RoomAgent, type RoomMessage } from "./room-manager.js";
import type { ResidentAgentEvent } from "./resident-agent.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

class FakeAgent implements RoomAgent {
  running = false;
  sent: string[] = [];
  constructor(private readonly emit: (e: ResidentAgentEvent) => void) {}
  start() {
    this.running = true;
  }
  send(text: string) {
    this.sent.push(text);
    // simulate claude echoing a reply + turn end
    this.emit({ type: "text", text: "reply to: " + text });
    this.emit({ type: "turn_end", reason: "success" });
    return true;
  }
  isRunning() {
    return this.running;
  }
  stop() {
    this.running = false;
  }
}

function makeManager() {
  dir = mkdtempSync(join(tmpdir(), "rooms-"));
  const pushed: { roomId: string; msg: RoomMessage }[] = [];
  const agents: FakeAgent[] = [];
  let clock = 1000;
  const mgr = new RoomManager({
    rootDir: dir,
    now: () => clock++,
    createAgent: (_room, onEvent) => {
      const a = new FakeAgent(onEvent);
      agents.push(a);
      return a;
    },
    onMessage: (roomId, msg) => pushed.push({ roomId, msg }),
  });
  return { mgr, pushed, agents };
}

describe("RoomManager", () => {
  test("create / list / get a room", () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/Users/x/proj", permissionMode: "bypassPermissions" });
    expect(room.name).toBe("proj");
    expect(room.kind).toBe("claude-code");
    expect(mgr.listRooms()).toHaveLength(1);
    expect(mgr.getRoom(room.id)?.permissionMode).toBe("bypassPermissions");
  });

  test("send persists user msg + agent reply with monotonic seq", () => {
    const { mgr, pushed } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.send(room.id, "hello");

    const msgs = mgr.getMessages(room.id, 0);
    // createRoom writes a system:room_created audit anchor first.
    expect(msgs.map((m) => `${m.from}:${m.type}`)).toEqual([
      "system:room_created",
      "user:text",
      "agent:text",
      "agent:turn_end",
    ]);
    // seq strictly increasing from 1
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(msgs[2]!.text).toBe("reply to: hello");
    // every persisted message was pushed to the phone (incl. the audit anchor)
    expect(pushed.filter((p) => p.roomId === room.id)).toHaveLength(4);
  });

  test("getMessages(sinceSeq) returns only newer", () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.send(room.id, "a");
    const all = mgr.getMessages(room.id, 0);
    const after = mgr.getMessages(room.id, all[0]!.seq);
    expect(after.every((m) => m.seq > all[0]!.seq)).toBe(true);
    expect(after).toHaveLength(all.length - 1);
  });

  test("open starts agent once; isOpen reflects state; close stops", () => {
    const { mgr, agents } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    expect(mgr.open(room.id).status).toBe("running");
    expect(mgr.open(room.id).status).toBe("running");
    expect(agents).toHaveLength(1); // not started twice
    expect(mgr.isOpen(room.id)).toBe(true);
    mgr.close(room.id);
    expect(mgr.isOpen(room.id)).toBe(false);
  });

  test("open missing room reports missing", () => {
    const { mgr } = makeManager();
    expect(mgr.open("nope").status).toBe("missing");
  });

  test("pruneStaleRooms deletes rooms idle longer than maxAge", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let clock = 0;
    const mgr = new RoomManager({
      rootDir: dir,
      now: () => clock,
      createAgent: (_r, onEvent) => new FakeAgent(onEvent),
      onMessage: () => {},
    });
    clock = 1000;
    const old = mgr.createRoom({ cwd: "/repo/old" }); // lastActiveAt = 1000
    clock = 5000;
    const fresh = mgr.createRoom({ cwd: "/repo/fresh" }); // lastActiveAt = 5000

    clock = 6000;
    // maxAge 2000 → cutoff 4000: `old` (1000) is stale, `fresh` (5000) is not.
    const removed = mgr.pruneStaleRooms(2000);
    expect(removed).toEqual([old.id]);
    expect(mgr.getRoom(old.id)).toBeUndefined();
    expect(mgr.getRoom(fresh.id)).toBeDefined();
    expect(mgr.listRooms().map((r) => r.id)).toEqual([fresh.id]);
  });

  test("pruneStaleRooms never deletes a running room even if stale", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let clock = 0;
    const mgr = new RoomManager({
      rootDir: dir,
      now: () => clock,
      createAgent: (_r, onEvent) => new FakeAgent(onEvent),
      onMessage: () => {},
    });
    clock = 1000;
    const room = mgr.createRoom({ cwd: "/repo" }); // lastActiveAt = 1000
    mgr.open(room.id); // resident agent now running
    clock = 100000;
    const removed = mgr.pruneStaleRooms(1); // everything older than 99999 is stale
    expect(removed).toEqual([]);
    expect(mgr.getRoom(room.id)).toBeDefined();
  });

  test("agent text/tool events persist with correct shape", () => {
    dir = mkdtempSync(join(tmpdir(), "rooms-"));
    let emit!: (e: ResidentAgentEvent) => void;
    const mgr = new RoomManager({
      rootDir: dir,
      now: (() => {
        let c = 1;
        return () => c++;
      })(),
      createAgent: (_r, onEvent) => {
        emit = onEvent;
        return { start() {}, send: () => true, isRunning: () => true, stop() {} };
      },
      onMessage: () => {},
    });
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.open(room.id);
    emit({ type: "tool", tool: "Bash", summary: "ls" });
    emit({ type: "tool_result", summary: "out", isError: false });
    // index 0 is the room_created audit anchor; agent events follow.
    const msgs = mgr.getMessages(room.id, 0).filter((m) => m.type !== "room_created");
    expect(msgs[0]).toMatchObject({ from: "agent", type: "tool", tool: "Bash", summary: "ls" });
    expect(msgs[1]).toMatchObject({ from: "agent", type: "tool_result", summary: "out", isError: false });
  });
});
