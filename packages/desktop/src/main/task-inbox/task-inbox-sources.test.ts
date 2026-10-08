import { describe, expect, test } from "bun:test";
import { createPetLongTask, transitionPetLongTask } from "@cjhyy/code-shell-pet";
import type { DiskSessionMeta } from "@cjhyy/code-shell-server/storage";
import type { AutomationSummary } from "../automation-service.js";
import type {
  DesktopPetProjectionSnapshot,
  DesktopPetSession,
} from "../pet/pet-state-aggregator.js";
import {
  createTaskInboxSources,
  type TaskInboxSourcesDeps,
  type TaskInboxBackgroundEntry,
} from "./task-inbox-sources.js";

const disk = (overrides: Partial<DiskSessionMeta> = {}): DiskSessionMeta => ({
  id: "session-a",
  engineSessionId: "session-a",
  cwd: "/project",
  title: "Work",
  updatedAt: 100,
  origin: "desktop",
  status: "active",
  ...overrides,
});
const live = (overrides: Partial<DesktopPetSession> = {}): DesktopPetSession => ({
  agentSessionId: "session-a",
  runState: "running",
  queueDepth: 0,
  lastActivityAt: 100,
  pendingDecisionCount: 0,
  freshness: { source: "worker", observedAt: 100, workerState: "active" },
  ...overrides,
});
const projection = (sessions: DesktopPetSession[]): DesktopPetProjectionSnapshot => ({
  version: 1,
  generation: 1,
  workerState: "active",
  sessions,
  pending: [],
  observedAt: 100,
  workMemorySegments: [],
});
const automation = (overrides: Partial<AutomationSummary> = {}): AutomationSummary => ({
  id: "cron-a",
  name: "Daily",
  schedule: "0 9 * * *",
  prompt: "private prompt",
  enabled: true,
  cwd: "/project",
  projectId: "project-a",
  rootId: null,
  timezone: null,
  permissionLevel: null,
  lastRun: null,
  nextRun: 1000,
  runCount: 0,
  createdAt: 50,
  lastRunId: null,
  once: false,
  resumeSessionId: "session-a",
  templateSource: null,
  ...overrides,
});
const base = (overrides: Partial<TaskInboxSourcesDeps> = {}): TaskInboxSourcesDeps => ({
  diskSessions: async () => [disk()],
  native: { hasLiveWorker: () => false, isSessionRunning: () => false, cancel: async () => false },
  ...overrides,
});
const read = (sources: ReturnType<typeof createTaskInboxSources>, source: string) =>
  sources.readers.find((reader) => reader.source === source)!.read();
const adapter = (sources: ReturnType<typeof createTaskInboxSources>, source: string) =>
  sources.adapters.find((entry) => entry.source === source)!;

describe("task inbox authoritative sources", () => {
  test("crash recovery treats unowned active Sessions as interrupted; durable completion wins", async () => {
    const sources = createTaskInboxSources(
      base({
        diskSessions: async () => [
          disk(),
          disk({ id: "done", engineSessionId: "done", status: "completed" }),
        ],
      }),
    );
    expect((await read(sources, "session")).map((row) => [row.status, row.capabilities])).toEqual([
      ["interrupted", ["open"]],
      ["done", ["open"]],
    ]);
  });

  test("live pending decision outranks running and disconnect removes cancellation", async () => {
    let connected = true;
    const sources = createTaskInboxSources(
      base({
        sessionProjection: () => projection([live({ pendingDecisionCount: 1 })]),
        native: {
          hasLiveWorker: () => connected,
          isSessionRunning: () => connected,
          cancel: async () => true,
        },
      }),
    );
    const row = (await read(sources, "session"))[0]!;
    expect(row.status).toBe("waiting");
    expect(row.capabilities).toContain("cancel");
    connected = false;
    const result = await adapter(sources, "session").act(row, "cancel");
    expect(result.status).toBe("stale");
    expect(result.record?.capabilities).toEqual(["open"]);
  });

  test("source scans share one disk/catalog read; revisions ignore observedAt/version", async () => {
    let reads = 0;
    let observedAt = 100;
    const sources = createTaskInboxSources(
      base({
        diskSessions: async () => {
          reads++;
          await Promise.resolve();
          return [disk()];
        },
        sessionProjection: () => ({ ...projection([live()]), version: observedAt, observedAt }),
        native: {
          hasLiveWorker: () => true,
          isSessionRunning: () => true,
          cancel: async () => true,
        },
      }),
    );
    const [rows] = await Promise.all([read(sources, "session"), read(sources, "external-runtime")]);
    expect(reads).toBe(1);
    observedAt = 200;
    expect((await read(sources, "session"))[0]!.sourceRevision).toBe(rows[0]!.sourceRevision);
  });

  test("external allocation without active turn is not shown running; interrupt keeps caller ownership", async () => {
    const calls: unknown[] = [];
    const sources = createTaskInboxSources(
      base({
        sessionProjection: () =>
          projection([live({ external: { cli: "codex", cwd: "/project" } })]),
        external: {
          hasSession: () => true,
          interrupt: async (...args) => {
            calls.push(args);
          },
        },
      }),
    );
    const row = (await read(sources, "external-runtime"))[0]!;
    expect(await read(sources, "session")).toEqual([]);
    expect(row.status).toBe("running");
    expect(
      (await adapter(sources, "external-runtime").act(row, "cancel", { webContentsId: 7 })).status,
    ).toBe("ok");
    expect(calls).toEqual([["session-a", 7]]);
    const idle = createTaskInboxSources(
      base({ external: { hasSession: () => true, interrupt: async () => {} } }),
    );
    expect((await read(idle, "external-runtime"))[0]!.status).toBe("interrupted");
  });

  test("external real turn and approval status remain visible with Pet disabled", async () => {
    let pending = false;
    const sources = createTaskInboxSources(
      base({
        external: {
          hasSession: () => true,
          isSessionRunning: () => true,
          hasPending: () => pending,
          interrupt: async () => {},
        },
      }),
    );
    expect((await read(sources, "external-runtime"))[0]!.status).toBe("running");
    pending = true;
    const waiting = (await read(sources, "external-runtime"))[0]!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.capabilities).toContain("cancel");
  });

  test("new normal terminal supersedes an older durable background yield", async () => {
    const sources = createTaskInboxSources(
      base({
        diskSessions: async () => [
          disk({ status: "completed", completionKind: "background_wait" }),
        ],
        sessionProjection: () =>
          projection([live({ runState: "terminal", terminal: { status: "completed", at: 200 } })]),
      }),
    );
    expect((await read(sources, "session"))[0]!.status).toBe("done");
  });

  test("automation schedule controls are distinct from execution Session cancel and refuse stale state", async () => {
    let job = automation();
    const calls: string[] = [];
    const sources = createTaskInboxSources(
      base({
        automations: {
          list: () => [job],
          get: () => job,
          pause: () => {
            calls.push("pause");
            job = { ...job, enabled: false };
            return true;
          },
          resume: () => {
            calls.push("resume");
            job = { ...job, enabled: true };
            return true;
          },
          runNow: () => {
            calls.push("run-now");
            return true;
          },
        },
      }),
    );
    const row = (await read(sources, "automation"))[0]!;
    expect(row.status).toBe("queued");
    expect(row.sessionId).toBeUndefined();
    expect(row.summary).toBe("0 9 * * *");
    expect(row.capabilities).toEqual(["open", "pause", "retry"]);
    expect((await adapter(sources, "automation").act(row, "cancel")).status).toBe("unavailable");
    const paused = await adapter(sources, "automation").act(row, "pause");
    expect(paused.record?.status).toBe("paused");
    expect((await adapter(sources, "automation").act(row, "retry")).status).toBe("stale");
    expect((await adapter(sources, "automation").act(paused.record!, "retry")).status).toBe("ok");
    expect(calls).toEqual(["pause", "run-now"]);
  });

  test("Mimi verification resumes authoritative interrupted task and retry creates a new attempt", async () => {
    let task = transitionPetLongTask(
      createPetLongTask({
        id: "task-a",
        originClientMessageId: "client-a",
        objective: "Check result",
        workspacePath: "/project",
        sessionId: "session-a",
        at: 50,
      }),
      { kind: "interrupted", at: 100, reason: "Verify the result" },
    );
    const calls: unknown[] = [];
    const sources = createTaskInboxSources(
      base({
        mimi: {
          snapshot: () => ({ revision: task.revision, observedAt: task.updatedAt, tasks: [task] }),
          get: () => task,
          control: async (request) => {
            calls.push(request);
            task = transitionPetLongTask(
              task,
              request.action === "retry"
                ? { kind: "retrying", at: 101 }
                : { kind: "resumed", at: 101 },
            );
            return { ok: true, task };
          },
        },
      }),
    );
    const row = (await read(sources, "mimi-delegation"))[0]!;
    expect(row.capabilities).toContain("verify");
    expect((await adapter(sources, "mimi-delegation").act(row, "verify")).status).toBe("ok");
    expect(calls).toEqual([{ taskId: "task-a", action: "resume" }]);
    task = transitionPetLongTask(task, { kind: "interrupted", at: 102, reason: "Retry" });
    const latest = (await read(sources, "mimi-delegation"))[0]!;
    const retried = await adapter(sources, "mimi-delegation").act(latest, "retry");
    expect(retried.record!.attempt).toBe(latest.attempt! + 1);
    expect(retried.record!.taskKey).not.toBe(latest.taskKey);
    expect(await adapter(sources, "mimi-delegation").reread(latest)).toBeUndefined();
  });

  test("background capabilities require actual control; subagent opens its child Session", async () => {
    const entries: TaskInboxBackgroundEntry[] = [
      {
        kind: "subagent",
        agentId: "agent-a",
        childSessionId: "child-a",
        runtimeGeneration: 2,
        description: "Research",
        status: "running",
        startedAt: 40,
        canCancel: true,
        sourceSession: { sessionId: "session-a" },
      },
      {
        kind: "job",
        jobId: "job-a",
        description: "Remote job",
        status: "running",
        startedAt: 50,
        canCancel: false,
        sourceSession: { sessionId: "session-a" },
      },
      {
        kind: "shell",
        shell: {
          shellId: "shell-a",
          sessionId: "session-a",
          command: "build",
          cwd: "/project",
          status: "exited",
          startedAt: 20,
          exitedAt: 30,
          exitCode: 1,
        },
        sourceSession: { sessionId: "session-a" },
      },
    ];
    let scans = 0;
    const calls: unknown[] = [];
    const sources = createTaskInboxSources(
      base({
        background: {
          available: () => true,
          list: async () => {
            scans++;
            await Promise.resolve();
            return entries;
          },
          cancel: async (...args) => {
            calls.push(args);
            return true;
          },
        },
      }),
    );
    const [agents, jobs, shells] = await Promise.all([
      read(sources, "subagent"),
      read(sources, "background-job"),
      read(sources, "background-shell"),
    ]);
    expect(scans).toBe(1);
    expect(agents[0]!.sessionId).toBe("child-a");
    expect(agents[0]!.parentSessionId).toBe("session-a");
    expect(agents[0]!.capabilities).toContain("cancel");
    expect(jobs[0]!.capabilities).toEqual(["open"]);
    expect(shells[0]!.status).toBe("failed");
    expect(
      (await adapter(sources, "subagent").act(agents[0]!, "cancel", { webContentsId: 7 })).status,
    ).toBe("ok");
    expect(calls).toEqual([[entries[0], { webContentsId: 7 }]]);
  });

  test("legacy active Run snapshot remains read-only interrupted history", async () => {
    const sources = createTaskInboxSources(
      base({
        runs: {
          list: async () => [
            {
              runId: "run-a",
              objective: "Old work",
              cwd: "/project",
              status: "running",
              createdAt: 10,
              updatedAt: 20,
              startedAt: 11,
              finishedAt: null,
              sessionId: null,
              error: null,
              summary: null,
            },
          ],
        },
      }),
    );
    const row = (await read(sources, "legacy-run"))[0]!;
    expect(row.status).toBe("interrupted");
    expect(row.capabilities).toEqual(["open"]);
    expect((await adapter(sources, "legacy-run").act(row, "cancel")).status).toBe("unavailable");
  });
});
