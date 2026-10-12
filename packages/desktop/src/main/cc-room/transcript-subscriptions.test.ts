import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCodexRecentHistory,
  parseRecentHistory,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import { TranscriptSubscriptionManager } from "./transcript-subscriptions.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("TranscriptSubscriptionManager", () => {
  for (const kind of ["claude-code", "codex"] as const)
    test(`${kind} late viewers retain parser grouping after recent-ring eviction`, () => {
      const root = mkdtempSync(join(tmpdir(), "cc-tail-recent-"));
      roots.push(root);
      const file = join(root, "transcript.jsonl");
      const tool = (id: number) =>
        kind === "codex"
          ? line({
              type: "response_item",
              payload: {
                type: "function_call",
                call_id: `call-${id}`,
                name: "exec_command",
                arguments: JSON.stringify({ command: `inspect-${id}` }),
              },
            })
          : line({
              type: "assistant",
              message: {
                content: [
                  {
                    type: "tool_use",
                    id: `call-${id}`,
                    name: "Bash",
                    input: { command: `inspect-${id}` },
                  },
                ],
              },
            });
      const turn = (id: number) =>
        kind === "codex"
          ? line({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: `user-${id}` }],
              },
            }) +
            line({
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: `assistant-${id}` }],
              },
            }) +
            tool(id) +
            line({
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: `call-${id}`,
                output: `result-${id}`,
              },
            })
          : line({ type: "user", message: { content: `user-${id}` } }) +
            line({
              type: "assistant",
              message: {
                content: [
                  { type: "text", text: `assistant-${id}` },
                  {
                    type: "tool_use",
                    id: `call-${id}`,
                    name: "Bash",
                    input: { command: `inspect-${id}` },
                  },
                ],
              },
            }) +
            line({
              type: "user",
              message: {
                content: [
                  { type: "tool_result", tool_use_id: `call-${id}`, content: `result-${id}` },
                ],
              },
            });
      let raw = Array.from({ length: 270 }, (_, id) => turn(id)).join("");
      writeFileSync(file, raw);
      const parse = kind === "codex" ? parseCodexRecentHistory : parseRecentHistory;
      const open = () =>
        new TranscriptSubscriptionManager({
          resolveFile: () => file,
          onStart() {},
          onStop() {},
          roomCursor: () => 0,
          onMessages() {},
          pollIntervalMs: 60_000,
        });
      const target = {
        roomId: "room",
        cwd: "/repo",
        sessionId: "session",
        kind,
        subscriberId: "first",
        limit: 500,
      };
      const manager = open();
      const cold = open();
      try {
        const initial = manager.subscribe(target);
        expect(initial.messages).toEqual(parse(raw, 500).messages);
        expect(initial.messages).toHaveLength(500);
        expect(initial.totalCount).toBe(540);
        expect(initial.hasMore).toBe(true);
        // The first incremental tool must join the preceding Codex assistant,
        // including when that assistant was parsed by the earlier capture.
        const suffix = tool(999) + Array.from({ length: 20 }, (_, id) => turn(id + 270)).join("");
        appendFileSync(file, suffix);
        raw += suffix;
        const late = manager.subscribe({ ...target, subscriberId: "late", limit: 7 });
        expect({
          messages: late.messages,
          totalCount: late.totalCount,
          hasMore: late.hasMore,
        }).toEqual(parse(raw, 7));
        expect(late.messages.some((message) => message.tools?.length)).toBe(true);
        const fullRing = manager.subscribe({ ...target, subscriberId: "full", limit: 500 });
        const restarted = cold.subscribe(target);
        expect(fullRing.messages).toEqual(parse(raw, 500).messages);
        expect(restarted.messages).toEqual(fullRing.messages);
        expect(restarted.totalCount).toBe(fullRing.totalCount);
        const smallest = manager.subscribe({ ...target, subscriberId: "small", limit: 1 });
        expect({
          messages: smallest.messages,
          totalCount: smallest.totalCount,
          hasMore: smallest.hasMore,
        }).toEqual(parse(raw, 1));
      } finally {
        manager.closeAll();
        cold.closeAll();
      }
    });

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
    expect(pushed.flat()).toMatchObject([
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
    expect(pushed.flat()).toMatchObject([{ from: "agent", type: "text", text: "split write" }]);
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
    expect(pushed.flat()).toMatchObject([{ from: "agent", type: "text", text: "final output" }]);
  });
});
