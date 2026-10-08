import { describe, expect, test } from "bun:test";
import { createTaskInboxActions } from "./task-inbox-actions.js";
import { mapTaskInboxRecord } from "./task-inbox-mappers.js";
import type { TaskInboxRecordV1 } from "./task-inbox-types.js";

const task = (overrides = {}) =>
  mapTaskInboxRecord({
    source: "session",
    sourceId: "s1",
    title: "Task",
    status: "running",
    capabilities: ["open", "cancel"],
    sourceRevision: "1",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
const request = { taskKey: "session:s1", action: "cancel" as const, expectedRevision: "1" };

describe("task inbox authority-checked actions", () => {
  test("re-reads state and rejects a stale revision before controller dispatch", async () => {
    let calls = 0;
    let published: TaskInboxRecordV1 | undefined;
    const actions = createTaskInboxActions({
      projector: {
        get: () => task(),
        ingest: (record) => {
          published = record as TaskInboxRecordV1;
          return { version: 1, records: [], errors: [] };
        },
      },
      adapters: [
        {
          source: "session",
          reread: () => task({ sourceRevision: "2", status: "done", capabilities: ["open"] }),
          act: () => {
            calls++;
            return { status: "ok" };
          },
        },
      ],
    });
    expect((await actions.act(request)).status).toBe("stale");
    expect(calls).toBe(0);
    expect(published?.sourceRevision).toBe("2");
  });
  test("source disappearance, unsupported state and malicious target input are structured", async () => {
    const projector = {
      get: () => task(),
      ingest: () => ({ version: 1, records: [], errors: [] }),
    };
    const missing = createTaskInboxActions({
      projector,
      adapters: [{ source: "session", reread: () => undefined, act: () => ({ status: "ok" }) }],
    });
    expect((await missing.act(request)).status).toBe("unavailable");
    const noCapability = createTaskInboxActions({
      projector,
      adapters: [
        {
          source: "session",
          reread: () => task({ capabilities: ["open"] }),
          act: () => {
            throw new Error("must not dispatch");
          },
        },
      ],
    });
    expect((await noCapability.act(request)).status).toBe("unavailable");
    expect((await noCapability.act({ ...request, command: "x" } as typeof request)).status).toBe(
      "rejected",
    );
  });
  test("serializes duplicate cancel, passes caller ownership context and dispatches once", async () => {
    let calls = 0;
    const contexts: unknown[] = [];
    const actions = createTaskInboxActions({
      projector: { get: () => task(), ingest: () => ({ version: 1, records: [], errors: [] }) },
      adapters: [
        {
          source: "session",
          reread: (_record, context) => {
            contexts.push(context);
            return task();
          },
          act: async (_record, _action, context) => {
            contexts.push(context);
            calls++;
            await Promise.resolve();
            return { status: "ok" };
          },
        },
      ],
    });
    const results = await Promise.all([
      actions.act(request, { webContentsId: 7 }),
      actions.act(request, { webContentsId: 7 }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
    expect(calls).toBe(1);
    expect(contexts.every((context) => JSON.stringify(context) === '{"webContentsId":7}')).toBe(
      true,
    );
  });
  test("legacy history never exposes a fake cancel even with malicious capabilities", async () => {
    let calls = 0;
    const record = {
      ...task({ source: "legacy-run" }),
      capabilities: ["open", "cancel"] as TaskInboxRecordV1["capabilities"],
    };
    const actions = createTaskInboxActions({
      projector: { get: () => record, ingest: () => ({ version: 1, records: [], errors: [] }) },
      adapters: [
        {
          source: "legacy-run",
          reread: () => record,
          act: () => {
            calls++;
            return { status: "ok" };
          },
        },
      ],
    });
    expect((await actions.act({ ...request, taskKey: record.taskKey })).status).toBe("unavailable");
    expect(calls).toBe(0);
  });
  test("projection write failure does not prevent or repeat an authoritative action", async () => {
    let calls = 0;
    const actions = createTaskInboxActions({
      projector: {
        get: () => task(),
        ingest: () => {
          throw new Error("disk full");
        },
      },
      adapters: [
        {
          source: "session",
          reread: () => task(),
          act: () => {
            calls++;
            return {
              status: "ok",
              record: task({ status: "cancelled", updatedAt: 3, sourceRevision: "2" }),
            };
          },
        },
      ],
    });
    expect((await actions.act(request)).status).toBe("ok");
    expect((await actions.act(request)).status).toBe("ok");
    expect(calls).toBe(1);
  });
  test("controller identity substitution and worker disconnect do not escape as exceptions", async () => {
    const projector = {
      get: () => task(),
      ingest: () => ({ version: 1, records: [], errors: [] }),
    };
    const substitute = createTaskInboxActions({
      projector,
      adapters: [
        {
          source: "session",
          reread: () => task({ sourceId: "other" }),
          act: () => ({ status: "ok" }),
        },
      ],
    });
    expect((await substitute.act(request)).status).toBe("rejected");
    const disconnected = createTaskInboxActions({
      projector,
      adapters: [
        {
          source: "session",
          reread: () => {
            throw new Error("worker disconnected");
          },
          act: () => ({ status: "ok" }),
        },
      ],
    });
    expect((await disconnected.act(request)).status).toBe("failed");
  });
  test("retry can publish a new attempt, and historical attempts remain openable", async () => {
    const previous = task({
      source: "mimi-delegation",
      sourceId: "m1",
      attempt: 0,
      status: "failed",
      capabilities: ["open", "retry"],
    });
    let published: TaskInboxRecordV1 | undefined;
    const actions = createTaskInboxActions({
      projector: {
        get: () => previous,
        ingest: (record) => {
          published = record as TaskInboxRecordV1;
          return { version: 1, records: [], errors: [] };
        },
      },
      adapters: [
        {
          source: "mimi-delegation",
          reread: () => previous,
          act: () => ({
            status: "ok",
            record: task({ source: "mimi-delegation", sourceId: "m1", attempt: 1 }),
          }),
        },
      ],
    });
    expect(
      (await actions.act({ taskKey: previous.taskKey, action: "retry", expectedRevision: "1" }))
        .status,
    ).toBe("ok");
    expect(published?.attempt).toBe(1);
    const historical = createTaskInboxActions({
      projector: { get: () => previous, ingest: () => ({ version: 1, records: [], errors: [] }) },
      adapters: [
        {
          source: "mimi-delegation",
          reread: () => undefined,
          act: (_record, action) => ({ status: action === "open" ? "ok" : "failed" }),
        },
      ],
    });
    expect(
      (await historical.act({ taskKey: previous.taskKey, action: "open", expectedRevision: "1" }))
        .status,
    ).toBe("ok");
  });
});
