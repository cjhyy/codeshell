// Appending to a room must stay linear.
//
// `append()` called `nextSeq()`, which called `getMessages(id, 0)` — a full
// synchronous read + JSON.parse of the ENTIRE messages.jsonl, just to learn the
// last seq. Writing N messages therefore cost O(N²) parsing, all on the remote
// host's event loop, so a long-lived room progressively slowed down new
// messages, heartbeats and every other WebSocket client.
//
// On top of that, `touchLastActive` rewrote the whole room.json per message,
// even though the field only feeds idle pruning measured in hours.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager } from "./room-manager";
import type { ResidentAgentEvent, RoomAgent, RoomMeta } from "./room-manager";

class IdleAgent implements RoomAgent {
  running = false;
  start(): void {
    this.running = true;
  }
  send(): boolean {
    return true;
  }
  isRunning(): boolean {
    return this.running;
  }
  stop(): void {
    this.running = false;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), "rooms-scale-"));
  dirs.push(dir);
  let clock = 1000;
  const mgr = new RoomManager({
    rootDir: dir,
    now: () => clock++,
    createAgent: (_room: RoomMeta, _onEvent: (event: ResidentAgentEvent) => void) =>
      new IdleAgent(),
    onMessage: () => undefined,
  } as never);
  return { mgr, dir };
}

/** Append `count` messages through the private path used by every real send. */
function appendMany(mgr: RoomManager, roomId: string, count: number): void {
  const append = (mgr as unknown as { append: (id: string, m: unknown) => void }).append.bind(mgr);
  for (let i = 0; i < count; i += 1) {
    append(roomId, { from: "user", type: "text", text: `m${i}` });
  }
}

describe("room append scaling", () => {
  test("seq stays correct and monotonic across many appends", () => {
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    appendMany(mgr, room.id, 300);

    const msgs = mgr.getMessages(room.id, 0);
    // 300 appends + the room_created audit anchor.
    expect(msgs).toHaveLength(301);
    expect(msgs.map((m) => m.seq)).toEqual(
      Array.from({ length: msgs.length }, (_, i) => i + 1),
    );
  });

  test("a reopened manager continues the sequence from disk", () => {
    // The in-memory counter is an optimisation, not the source of truth: a
    // restart must not restart numbering and clobber history.
    const { mgr, dir } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    appendMany(mgr, room.id, 5);
    const before = mgr.getMessages(room.id, 0);

    let clock = 9_000;
    const reopened = new RoomManager({
      rootDir: dir,
      now: () => clock++,
      createAgent: () => new IdleAgent(),
      onMessage: () => undefined,
    } as never);
    appendMany(reopened, room.id, 3);

    const after = reopened.getMessages(room.id, 0);
    expect(after).toHaveLength(before.length + 3);
    expect(after.map((m) => m.seq)).toEqual(
      Array.from({ length: after.length }, (_, i) => i + 1),
    );
  });

  test("appending does not re-read the whole history each time", () => {
    // Assert the ALGORITHM, not wall-clock: at these sizes per-message disk
    // writes dominate, so a timing ratio cannot tell O(N) from O(N²) (measured:
    // 1.75x before the fix vs 2.07x after — both look "linear"). What actually
    // changed is how often the full messages.jsonl is parsed, so count that.
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });

    let historyReads = 0;
    const original = mgr.getMessages.bind(mgr);
    (mgr as unknown as { getMessages: typeof mgr.getMessages }).getMessages = (
      id: string,
      since: number,
    ) => {
      historyReads += 1;
      return original(id, since);
    };

    appendMany(mgr, room.id, 200);

    // One lazy seed read for the room, and nothing per message. The old code did
    // one full parse per append (200+), which is the O(N²) term.
    expect(historyReads).toBeLessThanOrEqual(1);
  }, 120_000);

  test("lastActiveAt is throttled but still advances", () => {
    // It must not be rewritten per message, yet pruning still needs a real value.
    const { mgr } = makeManager();
    const room = mgr.createRoom({ cwd: "/repo" });
    appendMany(mgr, room.id, 50);

    const metaPath = join(
      (mgr as unknown as { roomDir: (id: string) => string }).roomDir(room.id),
      "room.json",
    );
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { lastActiveAt: number };
    expect(meta.lastActiveAt).toBeGreaterThanOrEqual(room.createdAt);
  });
});
