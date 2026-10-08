import { describe, expect, test } from "bun:test";
import type { TaskInboxRecordV1 } from "../../preload/task-inbox-api";
import {
  groupTaskInboxRecords,
  taskInboxOpenTarget,
  TASK_INBOX_GROUPS,
} from "./taskInboxViewModel";
import { openTaskInboxRecord, type TaskInboxNavigationAdapter } from "./taskInboxNavigation";

export function record(id: string, patch: Partial<TaskInboxRecordV1> = {}): TaskInboxRecordV1 {
  return {
    schemaVersion: 1,
    taskKey: `session:${id}`,
    source: "session",
    sourceId: id,
    title: `任务 ${id}`,
    status: "running",
    artifacts: [],
    capabilities: ["open"],
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_001_000,
    sourceRevision: "r1",
    ...patch,
  };
}
const filters = { source: "", status: "", project: "", search: "" };

describe("task inbox presentation", () => {
  test("attention is first and interrupted items remain actionable, with stable newest-first order", () => {
    const rows = [
      record("running"),
      record("paused", { status: "paused" }),
      record("interrupted", { status: "interrupted", updatedAt: 1_800_000_002_000 }),
      record("failed", { status: "failed" }),
      record("done", { status: "done" }),
      record("cancelled", { status: "cancelled" }),
    ];
    const grouped = groupTaskInboxRecords(rows, filters);
    expect(TASK_INBOX_GROUPS).toEqual(["waiting", "running", "failed", "done"]);
    expect(grouped.waiting.map((row) => row.sourceId)).toEqual(["interrupted", "paused"]);
    expect(grouped.running).toHaveLength(1);
    expect(grouped.failed).toHaveLength(1);
    expect(grouped.done).toHaveLength(2);
  });
  test("source, status, workspace fallback, and title search intersect", () => {
    const rows = [
      record("a", {
        source: "background-job",
        status: "waiting",
        workspacePath: "/work/one",
        title: "Build Report",
      }),
      record("b", {
        source: "background-job",
        status: "waiting",
        workspacePath: "/work/two",
        title: "Build Report",
      }),
      record("c", { workspacePath: "/work/one", title: "Build Report" }),
    ];
    const grouped = groupTaskInboxRecords(rows, {
      source: "background-job",
      status: "waiting",
      project: "/work/one",
      search: "  REPORT  ",
    });
    expect(grouped.waiting.map((row) => row.sourceId)).toEqual(["a"]);
  });
  test("source navigation prioritizes original session and retains specific fallback IDs", () => {
    expect(
      taskInboxOpenTarget(record("a", { sessionId: "engine-a", automationId: "cron-a" })),
    ).toEqual({ kind: "session", sessionId: "engine-a" });
    expect(taskInboxOpenTarget(record("mimi", { source: "mimi-delegation" }))).toEqual({
      kind: "mimi",
      taskId: "mimi",
    });
    expect(taskInboxOpenTarget(record("cron", { source: "automation" }))).toEqual({
      kind: "automation",
      automationId: "cron",
    });
    expect(taskInboxOpenTarget(record("run", { source: "legacy-run" }))).toEqual({
      kind: "run",
      runId: "run",
    });
  });
});

function adapter(overrides: Partial<TaskInboxNavigationAdapter> = {}) {
  const calls: unknown[][] = [];
  const value: TaskInboxNavigationAdapter = {
    sessionIndices: {},
    selectSession: (...args) => {
      calls.push(["session", ...args]);
    },
    listDiskSessions: async () => ({ sessions: [] }),
    openDiskSession: async (row) => {
      calls.push(["disk", row]);
    },
    openMimi: (id) => {
      calls.push(["mimi", id]);
    },
    openAutomation: (id) => {
      calls.push(["automation", id]);
    },
    openRun: (id) => {
      calls.push(["run", id]);
    },
    ...overrides,
  };
  return { value, calls };
}

describe("task inbox original detail routing", () => {
  test("engine IDs resolve to the actual UI Session, including no-project bucket", async () => {
    const { value, calls } = adapter({
      sessionIndices: {
        __no_repo__: {
          activeSessionId: null,
          sessions: [
            { id: "ui-a", engineSessionId: "engine-a", title: "a", createdAt: 1, updatedAt: 2 },
          ],
        },
      },
    });
    expect(await openTaskInboxRecord(record("a", { sessionId: "engine-a" }), value)).toBe(true);
    expect(calls).toEqual([["session", null, "ui-a"]]);
  });
  test("Mimi hidden delegation sessions use their existing authoritative navigation resolver", async () => {
    const ids: string[] = [];
    const { value, calls } = adapter({
      openMimiSession: async (id) => {
        ids.push(id);
        return true;
      },
      listDiskSessions: async () => {
        throw new Error("Hidden sessions are not ordinary catalog entries");
      },
    });
    expect(
      await openTaskInboxRecord(
        record("mimi-task", { source: "mimi-delegation", sessionId: "hidden-engine" }),
        value,
      ),
    ).toBe(true);
    expect(ids).toEqual(["hidden-engine"]);
    expect(calls).toEqual([]);
  });
  test("external observer sessions use their persisted CLI locator instead of the native Session catalog", async () => {
    const locators: unknown[] = [];
    const { value, calls } = adapter({
      openExternalSession: async (target) => {
        locators.push(target);
        return true;
      },
      listDiskSessions: async () => {
        throw new Error("External CLI IDs are not native Session IDs");
      },
    });
    for (const cli of ["codex", "claude"] as const) {
      expect(
        await openTaskInboxRecord(
          record(`${cli}-observer`, {
            source: "external-runtime",
            externalCli: cli,
            sessionId: `${cli}-external-id`,
            workspacePath: "/external/project",
          }),
          value,
        ),
      ).toBe(true);
    }
    expect(locators).toEqual([
      { cli: "codex", cwd: "/external/project", sessionId: "codex-external-id" },
      { cli: "claude", cwd: "/external/project", sessionId: "claude-external-id" },
    ]);
    expect(calls).toEqual([]);
  });
  test("owned external runtimes without an external observer locator still open the native Session", async () => {
    const { value, calls } = adapter({
      sessionIndices: {
        project: {
          activeSessionId: null,
          sessions: [
            {
              id: "ui-owned",
              engineSessionId: "engine-owned",
              title: "owned",
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
      },
    });
    expect(
      await openTaskInboxRecord(
        record("owned", { source: "external-runtime", sessionId: "engine-owned" }),
        value,
      ),
    ).toBe(true);
    expect(calls).toEqual([["session", "project", "ui-owned"]]);
  });
  test("missing linked Sessions fall back to retained Run or Mimi source details", async () => {
    const { value, calls } = adapter({ openMimiSession: async () => false });
    expect(
      await openTaskInboxRecord(
        record("retained-run", { source: "legacy-run", sessionId: "deleted-run-session" }),
        value,
      ),
    ).toBe(true);
    expect(
      await openTaskInboxRecord(
        record("retained-mimi", { source: "mimi-delegation", sessionId: "missing-hidden-session" }),
        value,
      ),
    ).toBe(true);
    expect(calls).toEqual([
      ["run", "retained-run"],
      ["mimi", "retained-mimi"],
    ]);
  });
  test("disk pagination finds and imports the original Session metadata", async () => {
    const seen: unknown[] = [];
    const disk = {
      id: "ui-disk",
      engineSessionId: "engine-disk",
      cwd: "/real/workspace",
      title: "disk",
      updatedAt: 2,
    };
    const { value, calls } = adapter({
      listDiskSessions: async (query) => {
        seen.push(query);
        return query.cursor ? { sessions: [disk] } : { sessions: [], nextCursor: "page-2" };
      },
    });
    expect(await openTaskInboxRecord(record("disk", { sessionId: "engine-disk" }), value)).toBe(
      true,
    );
    expect(seen).toEqual([{ limit: 200 }, { limit: 200, cursor: "page-2" }]);
    expect(calls).toEqual([["disk", disk]]);
  });
  test("Mimi, automation, Runs preserve selected source identity and missing sessions fail closed", async () => {
    const { value, calls } = adapter();
    for (const [source, id] of [
      ["mimi-delegation", "m1"],
      ["automation", "cron1"],
      ["legacy-run", "run1"],
    ] as const)
      expect(await openTaskInboxRecord(record(id, { source }), value)).toBe(true);
    expect(calls).toEqual([
      ["mimi", "m1"],
      ["automation", "cron1"],
      ["run", "run1"],
    ]);
    expect(await openTaskInboxRecord(record("missing", { sessionId: "missing" }), value)).toBe(
      false,
    );
    expect(calls).toHaveLength(3);
  });
});
