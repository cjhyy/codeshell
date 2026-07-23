import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTodoItem } from "@cjhyy/code-shell-pet/disclosure";
import { createPetTodoAggregator, type PetTodoCandidate } from "./pet-todo-aggregator";

function writeTodoTranscript(
  sessionDir: string,
  todos: Array<{ content: string; status: SessionTodoItem["status"]; activeForm?: string }>,
  timestamp?: number,
): string {
  const transcriptPath = join(sessionDir, "transcript.jsonl");
  const event = {
    type: "tool_use",
    ...(timestamp !== undefined ? { timestamp } : {}),
    data: { toolName: "TodoWrite", args: { todos } },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(event)}\n`);
  return transcriptPath;
}

function emptyTranscript(sessionDir: string): string {
  const transcriptPath = join(sessionDir, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: "message", data: { role: "assistant", content: [] } })}\n`,
  );
  return transcriptPath;
}

function candidate(
  overrides: Partial<PetTodoCandidate> & { agentSessionId: string },
): PetTodoCandidate {
  return { lastActivityAt: 0, ...overrides };
}

describe("createPetTodoAggregator", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pet-todo-aggregator-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("returns open-todo sessions and omits completed-only, no-TodoWrite, and missing candidates", async () => {
    const open = join(root, "session-open");
    mkdirSync(open);
    writeTodoTranscript(open, [
      {
        content: "wire the aggregator",
        status: "in_progress",
        activeForm: "Wiring the aggregator",
      },
      { content: "ship it", status: "completed" },
    ]);

    const done = join(root, "session-done");
    mkdirSync(done);
    writeTodoTranscript(done, [{ content: "already done", status: "completed" }]);

    const notodo = join(root, "session-notodo");
    mkdirSync(notodo);
    emptyTranscript(notodo);

    const aggregator = createPetTodoAggregator(root, () => [
      candidate({
        agentSessionId: "session-open",
        title: "Open work",
        workspaceDisplayName: "codeshell",
        lastActivityAt: 30,
      }),
      candidate({ agentSessionId: "session-done", lastActivityAt: 20 }),
      candidate({ agentSessionId: "session-notodo", lastActivityAt: 10 }),
      candidate({ agentSessionId: "session-missing", lastActivityAt: 5 }),
    ]);

    const result = await aggregator.collect();
    expect(result).toEqual([
      {
        sessionId: "session-open",
        title: "Open work",
        workspace: "codeshell",
        updatedAt: 30,
        todos: [
          {
            id: "1",
            subject: "wire the aggregator",
            activeForm: "Wiring the aggregator",
            status: "in_progress",
          },
        ],
      },
    ]);
  });

  test("keeps only pending and in_progress items", async () => {
    const dir = join(root, "session-a");
    mkdirSync(dir);
    writeTodoTranscript(dir, [
      { content: "pending one", status: "pending" },
      { content: "running one", status: "in_progress" },
      { content: "done one", status: "completed" },
    ]);

    const aggregator = createPetTodoAggregator(root, () => [
      candidate({ agentSessionId: "session-a", lastActivityAt: 1 }),
    ]);

    const [group] = await aggregator.collect();
    expect(group?.todos.map((todo) => todo.status)).toEqual(["pending", "in_progress"]);
  });

  test("serves cached todos while mtime is unchanged and re-reads on change", async () => {
    const dir = join(root, "session-a");
    mkdirSync(dir);
    const transcriptPath = writeTodoTranscript(dir, [{ content: "first", status: "pending" }]);
    const frozen = new Date("2026-01-01T00:00:00Z");
    utimesSync(transcriptPath, frozen, frozen);

    let calls = 0;
    const aggregator = createPetTodoAggregator(
      root,
      () => [candidate({ agentSessionId: "session-a", lastActivityAt: 1 })],
      {
        read: async () => {
          calls += 1;
          return [
            { id: "1", subject: `read ${calls}`, activeForm: `read ${calls}`, status: "pending" },
          ];
        },
      },
    );

    expect((await aggregator.collect())[0]?.todos[0]?.subject).toBe("read 1");
    // Same mtime -> served from cache, injected reader not called again.
    expect((await aggregator.collect())[0]?.todos[0]?.subject).toBe("read 1");
    expect(calls).toBe(1);

    const later = new Date("2026-01-02T00:00:00Z");
    utimesSync(transcriptPath, later, later);
    expect((await aggregator.collect())[0]?.todos[0]?.subject).toBe("read 2");
    expect(calls).toBe(2);
  });

  test("does not cache a failed read, so the next collect retries", async () => {
    const dir = join(root, "session-a");
    mkdirSync(dir);
    const transcriptPath = writeTodoTranscript(dir, [{ content: "x", status: "pending" }]);
    const frozen = new Date("2026-01-01T00:00:00Z");
    utimesSync(transcriptPath, frozen, frozen);

    let calls = 0;
    const aggregator = createPetTodoAggregator(
      root,
      () => [candidate({ agentSessionId: "session-a", lastActivityAt: 1 })],
      {
        read: async () => {
          calls += 1;
          if (calls === 1) throw new Error("boom");
          return [{ id: "1", subject: "recovered", activeForm: "recovered", status: "pending" }];
        },
      },
    );

    // First collect: reader throws -> session skipped, failure not cached.
    expect(await aggregator.collect()).toEqual([]);
    // Same mtime, but the retry must reach the reader again and succeed.
    expect((await aggregator.collect())[0]?.todos[0]?.subject).toBe("recovered");
    expect(calls).toBe(2);
    // Third collect (same mtime) served from cache — no further reader calls.
    await aggregator.collect();
    expect(calls).toBe(2);
  });

  test("sorts candidates by lastActivityAt and caps by maxSessions", async () => {
    const ids = ["session-a", "session-b", "session-c"];
    for (const id of ids) {
      const dir = join(root, id);
      mkdirSync(dir);
      writeTodoTranscript(dir, [{ content: id, status: "pending" }]);
    }
    const readOrder: string[] = [];
    const aggregator = createPetTodoAggregator(
      root,
      () => [
        candidate({ agentSessionId: "session-a", lastActivityAt: 10 }),
        candidate({ agentSessionId: "session-b", lastActivityAt: 30 }),
        candidate({ agentSessionId: "session-c", lastActivityAt: 20 }),
      ],
      {
        maxSessions: 2,
        read: async (sessionDir) => {
          readOrder.push(sessionDir);
          return [{ id: "1", subject: "x", activeForm: "x", status: "pending" }];
        },
      },
    );

    const result = await aggregator.collect();
    // Newest-first ordering, capped at 2: session-b (30) then session-c (20).
    expect(result.map((group) => group.sessionId)).toEqual(["session-b", "session-c"]);
    expect(readOrder).toEqual([join(root, "session-b"), join(root, "session-c")]);
  });

  test("falls back to the trailing session id when a candidate has no title", async () => {
    const dir = join(root, "abcdef0123456789");
    mkdirSync(dir);
    writeTodoTranscript(dir, [{ content: "x", status: "pending" }]);
    const aggregator = createPetTodoAggregator(root, () => [
      candidate({ agentSessionId: "abcdef0123456789", lastActivityAt: 1 }),
    ]);
    const [group] = await aggregator.collect();
    expect(group?.title).toBe("23456789");
    expect(group?.workspace).toBeUndefined();
  });
});
