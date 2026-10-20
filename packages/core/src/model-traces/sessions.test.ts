import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelTraceStore } from "./store.js";
import type { ModelTraceRecord } from "./types.js";

let directory: string;
let store: ModelTraceStore;
let now: number;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codeshell-trace-sessions-"));
  store = new ModelTraceStore({ storageDir: directory });
  now = Date.now();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function write(id: string, fields: Partial<ModelTraceRecord> = {}) {
  store.write({
    version: 1,
    id,
    traceId: "run-1",
    sessionId: "conversation-1",
    source: "desktop",
    purpose: "main",
    provider: "fixture",
    model: "fixture-model",
    startedAt: now,
    status: "completed",
    stream: false,
    inputState: "recorded",
    input: { systemPrompt: "private body", messages: [], tools: [], parameters: {} },
    outputState: "not-recorded",
    attempts: [],
    ...fields,
  });
}

test("all calls in the same session aggregate before paging, across executions and without body reads", () => {
  for (let i = 0; i < 515; i++)
    write(`call-${i}`, {
      traceId: i % 2 ? "run-2" : "run-1",
      startedAt: now - i,
      source: i % 2 ? "panel:fixture" : "desktop",
      model: i % 2 ? "second" : "fixture-model",
      status: i === 1 ? "failed" : i === 2 ? "running" : "completed",
    });
  write("old-request-finished-last", { startedAt: now - 1000, endedAt: now + 10 });
  write("other-session", { sessionId: "conversation-2", startedAt: now - 2000 });
  // The matching summary is sufficient even if its body becomes unreadable.
  writeFileSync(
    join(directory, "records", `${createHash("sha256").update("call-0").digest("hex")}.json`),
    "invalid-body",
  );
  const first = store.sessions({ limit: 1 });
  expect(first.total).toBe(2);
  expect(first.items).toEqual([
    {
      key: "session:conversation-1",
      sessionId: "conversation-1",
      latestRequestId: "old-request-finished-last",
      latestTraceId: "run-1",
      startedAt: now - 1000,
      updatedAt: now + 10,
      callCount: 516,
      traceCount: 2,
      sources: ["desktop", "panel:fixture"],
      models: ["fixture-model", "second"],
      callTypes: ["execution", "panel"],
      runningCount: 1,
      failedCount: 1,
    },
  ]);
  expect(first.items[0]).not.toHaveProperty("input");
  expect(first.items[0]).not.toHaveProperty("traceId");
  const second = store.sessions({ limit: 1, cursor: first.nextCursor });
  expect(second.total).toBe(2);
  expect(second.items[0].sessionId).toBe("conversation-2");
  expect(second.nextCursor).toBeUndefined();
});

test("sessionless calls group only by their real trace identity and never collide with sessions", () => {
  write("session", { sessionId: "same-id", traceId: "session-run" });
  write("session-on-same-trace", { sessionId: "other-session", traceId: "same-id" });
  write("standalone-1", { sessionId: undefined, traceId: "same-id" });
  write("standalone-2", { sessionId: undefined, traceId: "same-id" });
  write("standalone-other", { sessionId: undefined, traceId: "another-run" });
  const page = store.sessions();
  expect(page.total).toBe(4);
  expect(page.items.find((item) => item.key === "trace:same-id")).toMatchObject({
    traceId: "same-id",
    callCount: 2,
    traceCount: 1,
  });
  expect(page.items.find((item) => item.key === "trace:same-id")).not.toHaveProperty("sessionId");
  expect(store.list({ traceId: "same-id", withoutSession: true }).total).toBe(2);
  expect(store.sessions({ withoutSession: true }).total).toBe(2);
  expect(store.list({ traceId: "same-id" }).total).toBe(3);
  expect(() => store.list({ withoutSession: "true" } as any)).toThrow("query");
  expect(page.items.find((item) => item.key === "session:same-id")).toMatchObject({
    sessionId: "same-id",
    callCount: 1,
  });
});

test("filters and Host workspace scopes apply before session counts and stable pagination", () => {
  write("worktree", { workspacePath: "/project/worktree", sessionId: "joined", model: "wanted" });
  write("root-panel", {
    workspacePath: "/project",
    sessionId: "joined",
    source: "panel:fixture",
    traceId: "second-run",
    model: "wanted",
  });
  write("root-chat", {
    workspacePath: "/project",
    sessionId: "joined",
    source: "desktop",
    model: "wanted",
  });
  write("foreign", { workspacePath: "/foreign", sessionId: "joined", model: "wanted" });
  write("other-model", { workspacePath: "/project/worktree", sessionId: "joined", model: "other" });
  write("other-session", {
    workspacePath: "/project/worktree",
    sessionId: "z-last",
    model: "wanted",
    status: "failed",
  });
  const query = {
    workspaceScopes: [
      { workspacePath: "/project/worktree" },
      { workspacePath: "/project", sourcePrefix: "panel:" },
    ],
    model: "wanted",
    limit: 1,
  };
  const first = store.sessions(query);
  expect(first.total).toBe(2);
  expect(first.items[0].sessionId).toBe("z-last");
  const second = store.sessions({ ...query, cursor: first.nextCursor });
  expect(second.items[0]).toMatchObject({ sessionId: "joined", callCount: 2, traceCount: 2 });
  expect(store.sessions({ ...query, sessionId: "joined" }).total).toBe(1);
  expect(store.sessions({ ...query, source: "panel:fixture" }).items[0].callCount).toBe(1);
  expect(store.sessions({ ...query, status: "failed" }).items[0].sessionId).toBe("z-last");
  expect(store.sessions({ ...query, since: now + 1 }).total).toBe(0);
  expect(store.sessions({ ...query, search: "root-panel second-run" }).items[0].callCount).toBe(1);
});

test("session cursors reject corrupt or call-list cursors and share query bounds", () => {
  write("one");
  for (const cursor of [
    "invalid",
    Buffer.from(JSON.stringify({ startedAt: now, id: "one" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        kind: "sessions",
        updatedAt: now,
        key: "session:one",
        workspacePath: "/foreign",
      }),
    ).toString("base64url"),
  ])
    expect(() => store.sessions({ cursor })).toThrow("session cursor");
  expect(() => store.sessions({ limit: 0 })).toThrow("query");
  expect(() =>
    store.sessions({
      workspaceScopes: [{ workspacePath: "/project", includeChildren: true }],
    } as any),
  ).toThrow("workspace scopes");
});

test("type filters precede session counts, trace counts and pagination without leaking scopes", () => {
  for (let index = 0; index < 205; index++)
    write(`main-${index}`, {
      workspacePath: "/project/worktree",
      sessionId: "mixed",
      traceId: index % 2 ? "execution-1" : "execution-2",
      startedAt: now - index,
    });
  write("title", {
    workspacePath: "/project/worktree",
    sessionId: "mixed",
    purpose: "title",
    startedAt: now + 10,
  });
  write("title-other-session", {
    workspacePath: "/project/worktree",
    sessionId: "other",
    purpose: "title",
    startedAt: now + 20,
  });
  write("root-panel-title", {
    workspacePath: "/project",
    sessionId: "mixed",
    purpose: "title",
    source: "panel:fixture",
    traceId: "panel-run",
    startedAt: now + 30,
  });
  write("root-chat-title", {
    workspacePath: "/project",
    sessionId: "mixed",
    purpose: "title",
    startedAt: now + 40,
  });
  write("foreign-title", {
    workspacePath: "/foreign",
    sessionId: "mixed",
    purpose: "title",
    startedAt: now + 50,
  });
  const query = {
    workspaceScopes: [
      { workspacePath: "/project/worktree" },
      { workspacePath: "/project", sourcePrefix: "panel:" },
    ],
    callType: "title" as const,
    limit: 1,
  };
  const first = store.sessions(query);
  expect(first.total).toBe(2);
  expect(first.items[0]).toMatchObject({
    sessionId: "mixed",
    callCount: 2,
    traceCount: 2,
    callTypes: ["title"],
    latestRequestId: "root-panel-title",
  });
  const second = store.sessions({ ...query, cursor: first.nextCursor });
  expect(second.items[0]).toMatchObject({ sessionId: "other", callCount: 1, callTypes: ["title"] });
  expect(second.nextCursor).toBeUndefined();
  const mixed = store.sessions({ workspaceScopes: query.workspaceScopes, sessionId: "mixed" });
  expect(mixed.items[0]).toMatchObject({ callCount: 207, callTypes: ["execution", "title"] });
  expect(store.list(query).total).toBe(3);
  const execution = store.sessions({ ...query, callType: "execution" });
  expect(execution.total).toBe(1);
  expect(execution.items[0]).toMatchObject({
    callCount: 205,
    traceCount: 2,
    callTypes: ["execution"],
  });
  expect(() => store.sessions({ ...query, callType: "made-up" } as any)).toThrow("query");
});
