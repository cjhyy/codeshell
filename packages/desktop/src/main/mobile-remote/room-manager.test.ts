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
    expect(msgs.map((m) => `${m.from}:${m.type}`)).toEqual([
      "user:text",
      "agent:text",
      "agent:turn_end",
    ]);
    // seq strictly increasing
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(msgs[1]!.text).toBe("reply to: hello");
    // every persisted message was pushed to the phone
    expect(pushed.filter((p) => p.roomId === room.id)).toHaveLength(3);
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
    const msgs = mgr.getMessages(room.id, 0);
    expect(msgs[0]).toMatchObject({ from: "agent", type: "tool", tool: "Bash", summary: "ls" });
    expect(msgs[1]).toMatchObject({ from: "agent", type: "tool_result", summary: "out", isError: false });
  });
});
