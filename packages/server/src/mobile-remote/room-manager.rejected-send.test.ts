// A rejected send must leave no trace.
//
// RoomManager.send() used to append + broadcast the user message and only THEN
// call agent.send(), returning its result to the phone. CodexRoomAgent returns
// false while a previous turn is still running, so the phone got
// "房间未就绪或已关闭" while the same text was already in messages.jsonl and had
// been pushed to every other client — a message that looks delivered but was
// never handed to the agent. With attachments the handler also released the
// upload claim, leaving history pointing at an attachment that never existed.
//
// Acceptance is now decided first. Events the agent emits synchronously during
// send() are buffered and replayed after the user turn, so the reply can never
// precede the prompt it answers.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager, type RoomAgent, type RoomMeta } from "./room-manager";
import type { ResidentAgentEvent } from "./resident-agent.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Agent that accepts the first turn and rejects while that turn is "running". */
class BusyAfterFirstAgent implements RoomAgent {
  running = false;
  sent: string[] = [];
  private turnRunning = false;

  constructor(private readonly emit: (event: ResidentAgentEvent) => void) {}

  start(): void {
    this.running = true;
  }
  send(text: string): boolean {
    if (this.turnRunning) return false; // one turn at a time — the real behaviour
    this.turnRunning = true;
    this.sent.push(text);
    // Emit synchronously to prove ordering does not depend on async timing.
    this.emit({ type: "text", text: "reply to: " + text } as ResidentAgentEvent);
    return true;
  }
  isRunning(): boolean {
    return this.running;
  }
  stop(): void {
    this.running = false;
  }
}

function makeManager() {
  const pushed: Array<{ roomId: string; msg: { from: string; type: string } }> = [];
  const agents: BusyAfterFirstAgent[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rooms-reject-"));
  dirs.push(dir);
  let clock = 1000;
  const mgr = new RoomManager({
    rootDir: dir,
    now: () => clock++,
    createAgent: (_room: RoomMeta, onEvent: (event: ResidentAgentEvent) => void) => {
      const agent = new BusyAfterFirstAgent(onEvent);
      agents.push(agent);
      return agent;
    },
    onMessage: (roomId: string, msg: { from: string; type: string }) =>
      pushed.push({ roomId, msg }),
  } as never);
  return { mgr, pushed, agents };
}

describe("RoomManager rejected send", () => {
  test("a send the agent refuses is not persisted or broadcast", () => {
    const { mgr, pushed, agents } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });

    expect(mgr.send(room.id, "first")).toBe(true);
    const afterFirst = mgr.getMessages(room.id, 0).length;
    const pushedAfterFirst = pushed.length;

    // The agent is mid-turn, so this one is refused.
    expect(mgr.send(room.id, "should-not-persist")).toBe(false);

    const history = mgr.getMessages(room.id, 0);
    expect(history).toHaveLength(afterFirst);
    expect(history.some((m) => m.text === "should-not-persist")).toBe(false);
    // Nothing was pushed to the other clients either.
    expect(pushed).toHaveLength(pushedAfterFirst);
    // And the agent only ever saw the accepted turn.
    expect(agents[0]!.sent).toEqual(["first"]);
  });

  test("the accepted user turn still precedes the agent reply", () => {
    // Regression guard for the fix itself: buffering must not reorder the turn.
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.send(room.id, "hello");

    const kinds = mgr.getMessages(room.id, 0).map((m) => `${m.from}:${m.type}`);
    expect(kinds).toEqual(["system:room_created", "user:text", "agent:text"]);
  });

  test("seq stays monotonic across an accepted and a rejected send", () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    mgr.send(room.id, "one");
    mgr.send(room.id, "rejected");

    const seqs = mgr.getMessages(room.id, 0).map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // No gap left behind by the refused message.
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });
});
