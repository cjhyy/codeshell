import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptSubscriptionManager } from "./transcript-subscriptions.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("TranscriptSubscriptionManager", () => {
  test("takes an atomic snapshot, tails appended Codex lines, and ref-counts viewers", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-tail-"));
    roots.push(root);
    const file = join(root, "rollout.jsonl");
    writeFileSync(
      file,
      line({ type: "session_meta", payload: { id: "thread-1", cwd: "/repo" } }) +
        line({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "initial" }],
          },
        }),
    );

    const pushed: unknown[][] = [];
    const starts: string[] = [];
    const stops: string[] = [];
    let cursor = 7;
    const manager = new TranscriptSubscriptionManager({
      resolveFile: () => file,
      onStart: (roomId) => starts.push(roomId),
      onStop: (roomId) => stops.push(roomId),
      roomCursor: () => cursor,
      onMessages: (_roomId, messages) => {
        pushed.push(messages);
        cursor += messages.length;
      },
    });

    const first = manager.subscribe({
      subscriberId: "desktop:1",
      roomId: "room-1",
      cwd: "/repo",
      sessionId: "thread-1",
      kind: "codex",
      limit: 50,
    });
    expect(first.active).toBe(true);
    expect(first.messages.map((message) => message.text)).toEqual(["initial"]);
    expect(first.roomCursor).toBe(7);
    expect(starts).toEqual(["room-1"]);

    appendFileSync(
      file,
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "streamed" }],
        },
      }) + line({ type: "event_msg", payload: { type: "task_complete" } }),
    );

    // A second viewer shares the existing follower. subscribe() drains the
    // just-appended bytes synchronously, making the test independent of timers.
    const second = manager.subscribe({
      subscriberId: "mobile:1",
      roomId: "room-1",
      cwd: "/repo",
      sessionId: "thread-1",
      kind: "codex",
      limit: 50,
    });
    expect(starts).toHaveLength(1);
    expect(pushed.flat()).toEqual([
      { from: "agent", type: "text", text: "streamed" },
      { from: "agent", type: "turn_end", reason: "completed" },
    ]);
    expect(second.messages.at(-1)?.text).toBe("streamed");
    expect(second.roomCursor).toBe(9);

    manager.unsubscribe("desktop:1", "room-1");
    expect(stops).toEqual([]);
    manager.unsubscribe("mobile:1", "room-1");
    expect(stops).toEqual(["room-1"]);
    manager.closeAll();
  });

  test("buffers a partial JSONL write until its newline arrives", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-tail-partial-"));
    roots.push(root);
    const file = join(root, "claude.jsonl");
    writeFileSync(file, "");
    const pushed: unknown[][] = [];
    const manager = new TranscriptSubscriptionManager({
      resolveFile: () => file,
      onStart() {},
      onStop() {},
      roomCursor: () => 0,
      onMessages: (_roomId, messages) => pushed.push(messages),
    });
    manager.subscribe({
      subscriberId: "desktop:1",
      roomId: "room-1",
      cwd: "/repo",
      sessionId: "session-1",
      kind: "claude-code",
      limit: 50,
    });

    const json = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "split write" }] },
    });
    appendFileSync(file, json.slice(0, 20));
    manager.subscribe({
      subscriberId: "mobile:1",
      roomId: "room-1",
      cwd: "/repo",
      sessionId: "session-1",
      kind: "claude-code",
      limit: 50,
    });
    expect(pushed).toEqual([]);

    appendFileSync(file, `${json.slice(20)}\n`);
    manager.subscribe({
      subscriberId: "desktop:2",
      roomId: "room-1",
      cwd: "/repo",
      sessionId: "session-1",
      kind: "claude-code",
      limit: 50,
    });
    expect(pushed.flat()).toEqual([{ from: "agent", type: "text", text: "split write" }]);
    manager.closeAll();
  });

  test("drains final bytes when the room process ends before the next poll", () => {
    const root = mkdtempSync(join(tmpdir(), "cc-tail-exit-"));
    roots.push(root);
    const file = join(root, "claude.jsonl");
    writeFileSync(file, "");
    const pushed: unknown[][] = [];
    const manager = new TranscriptSubscriptionManager({
      resolveFile: () => file,
      onStart() {},
      onStop() {},
      roomCursor: () => 0,
      onMessages: (_roomId, messages) => pushed.push(messages),
      pollIntervalMs: 60_000,
    });
    manager.subscribe({
      subscriberId: "desktop:1",
      roomId: "room-1",
      cwd: "/repo",
      sessionId: "session-1",
      kind: "claude-code",
      limit: 50,
    });
    appendFileSync(
      file,
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "final output" }] },
      }),
    );

    manager.endRoom("room-1");
    expect(pushed.flat()).toEqual([{ from: "agent", type: "text", text: "final output" }]);
  });
});
