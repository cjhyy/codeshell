import { describe, expect, test } from "bun:test";
import {
  deduplicateTaskInboxRecords,
  mapTaskInboxRecord,
  mapTaskInboxStatus,
  shouldReplaceTaskRecord,
  compareTaskInboxRecords,
} from "./task-inbox-mappers.js";
import {
  parseTaskInboxActionRequest,
  parseTaskInboxListQuery,
  parseTaskInboxRecord,
  TASK_SOURCES,
} from "./task-inbox-types.js";

const task = (overrides = {}) =>
  mapTaskInboxRecord({
    source: "session",
    sourceId: "s1",
    title: "Example task",
    status: "running",
    sourceRevision: "1",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });

describe("task inbox normalized model", () => {
  test.each(TASK_SOURCES)(
    "maps %s with a stable identity and controller capabilities",
    (source) => {
      const record = task({ source, capabilities: ["open", "cancel"] });
      expect(record.taskKey).toBe(`${source}:s1`);
      expect(record.capabilities).toEqual(source === "legacy-run" ? ["open"] : ["open", "cancel"]);
    },
  );
  test.each([
    ["completed", "done"],
    ["waiting_approval", "waiting"],
    ["blocked", "waiting"],
    ["finalizing", "running"],
    ["disabled", "paused"],
    ["enabled", "queued"],
    ["disconnected", "interrupted"],
  ])("normalizes %s into %s", (input, expected) =>
    expect(mapTaskInboxStatus(input)).toBe(expected),
  );
  test("automation run-now remains available while the schedule is enabled or paused", () => {
    for (const status of ["enabled", "disabled"])
      expect(
        task({ source: "automation", status, capabilities: ["open", "retry"] }).capabilities,
      ).toContain("retry");
  });
  test("strict parsers reject unknown fields, malformed identities and unsafe IPC input", () => {
    expect(() => parseTaskInboxRecord({ ...task(), command: "execute" })).toThrow();
    expect(() => parseTaskInboxRecord({ ...task(), taskKey: "session:other" })).toThrow();
    expect(() =>
      parseTaskInboxRecord({
        ...task(),
        artifacts: [{ kind: "file", label: "x", uri: "file:///x", secret: "x" }],
      }),
    ).toThrow();
    expect(() => parseTaskInboxListQuery({ limit: 201 })).toThrow();
    expect(() => parseTaskInboxListQuery({ source: "unknown" })).toThrow();
    expect(() =>
      parseTaskInboxActionRequest({
        taskKey: "session:s1",
        action: "cancel",
        expectedRevision: "1",
        sessionId: "other",
      }),
    ).toThrow();
    expect(() => parseTaskInboxRecord({ ...task(), sourceRevision: "" })).toThrow();
  });
  test("Mimi, automation execution and child associations each suppress their duplicate Session", () => {
    for (const source of [
      "mimi-delegation",
      "automation",
      "subagent",
      "external-runtime",
    ] as const) {
      const primary = task({ source, sourceId: "p1", sessionId: "s1" });
      expect(deduplicateTaskInboxRecords([task(), primary])).toEqual([primary]);
    }
    const definition = task({
      source: "automation",
      sourceId: "schedule",
      automationId: "schedule",
    });
    expect(
      deduplicateTaskInboxRecords([task({ automationId: "schedule" }), definition]),
    ).toHaveLength(2);
  });
  test("older running cannot roll back terminal; a newer turn may run again", () => {
    const terminal = task({ status: "done", updatedAt: 10 });
    expect(shouldReplaceTaskRecord(terminal, task({ updatedAt: 9 }))).toBe(false);
    expect(shouldReplaceTaskRecord(terminal, task({ updatedAt: 10 }))).toBe(false);
    expect(shouldReplaceTaskRecord(terminal, task({ updatedAt: 11 }))).toBe(true);
  });
  test("background tasks and legacy subagents do not hide their parent Session", () => {
    for (const source of ["background-shell", "background-job", "subagent"] as const) {
      const background = task({ source, sourceId: "job", sessionId: "s1", parentSessionId: "s1" });
      expect(deduplicateTaskInboxRecords([task(), background])).toHaveLength(2);
    }
  });
  test("the current attempt is the default card while old attempts remain in storage input", () => {
    const previous = task({ source: "mimi-delegation", attempt: 0, status: "failed" });
    const current = task({ source: "mimi-delegation", attempt: 1, updatedAt: 3 });
    expect(deduplicateTaskInboxRecords([previous, current])).toEqual([current]);
  });
  test("waiting and interrupted tasks sort above active, failure and completion", () => {
    const records = ["done", "running", "failed", "waiting", "interrupted"].map((status) =>
      task({ sourceId: status, status }),
    );
    expect(records.sort(compareTaskInboxRecords).map((row) => row.status)).toEqual([
      "interrupted",
      "waiting",
      "running",
      "failed",
      "done",
    ]);
  });
});
