import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import {
  ModelTraceStore,
  type ModelTraceRecord,
  type ModelTraceListQuery,
} from "@cjhyy/code-shell-core/internal";
import { createModelTraceHistory } from "./model-trace-history.js";
import { createModelTraceHttp } from "./model-trace-http.js";

const fixtures: Array<{ root: string; server: Server }> = [];
afterEach(async () => {
  for (const { root, server } of fixtures.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  }
});
function entry(id: string, workspacePath?: string): ModelTraceRecord {
  return {
    version: 1,
    id,
    traceId: "shared-run",
    workspacePath,
    source: "fixture",
    purpose: "main",
    provider: "openai",
    model: "fixture-model",
    startedAt: Date.now(),
    status: "completed",
    stream: false,
    inputState: "not-recorded",
    outputState: "not-recorded",
    attempts: [],
  };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-model-trace-http-"));
  const cwd = join(root, "workspace");
  const other = join(root, "other");
  const storageDir = join(root, "sessions", ".model-traces");
  const store = new ModelTraceStore({ storageDir });
  store.write(entry("visible", cwd));
  store.write(entry("other", other));
  store.write(entry("unattributed"));
  for (const [id, workspacePath] of [
    ["our-event", cwd],
    ["other-event", other],
    ["unknown-event", undefined],
  ] as const)
    store.writeEvent({
      id,
      workspacePath,
      traceId: "shared-run",
      kind: "tool",
      name: id,
      startedAt: Date.now(),
      status: "completed",
      inputState: "not-recorded",
      outputState: "not-recorded",
    });
  let allowed = true;
  let scopes: ModelTraceListQuery["workspaceScopes"];
  let scopeResolver: (() => ModelTraceListQuery["workspaceScopes"]) | undefined;
  const service = createModelTraceHttp({
    storageDir,
    workspacePath: cwd,
    isAuthorized: (req) => allowed && req.headers.authorization === "Bearer fixture",
    resolveWorkspaceScopes: () => (scopeResolver ? scopeResolver() : scopes),
  });
  const server = createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixtures.push({ root, server });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/model-traces`;
  const request = (path = "", method = "GET", authorized = true) =>
    fetch(url + path, { method, headers: authorized ? { authorization: "Bearer fixture" } : {} });
  return {
    root,
    cwd,
    other,
    store,
    storageDir,
    request,
    setScopes: (value: ModelTraceListQuery["workspaceScopes"]) => {
      scopes = value;
    },
    setScopeResolver: (value: () => ModelTraceListQuery["workspaceScopes"]) => {
      scopeResolver = value;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
  };
}

test("trace HTTP authenticates, fixes workspace scope, and associates events only by trace identity and workspace", async () => {
  const f = await fixture();
  expect((await f.request("", "GET", false)).status).toBe(401);
  const response = await f.request();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const page = await response.json();
  expect(page.items.map((item: any) => item.id)).toEqual(["visible"]);
  expect(page.total).toBe(1);
  const detail = await (await f.request("/visible")).json();
  expect(detail.record.workspacePath).toBe(f.cwd);
  expect(detail.events.map((event: any) => event.id)).toEqual(["our-event"]);
  for (const id of ["other", "unattributed", "missing"])
    expect((await f.request(`/${id}`)).status).toBe(404);
  f.setAllowed(false);
  expect((await f.request("/visible")).status).toBe(401);
});

test("remote trace queries cannot select paths, override workspace, or mutate capture policy", async () => {
  const f = await fixture();
  const original = f.store.getConfig();
  for (const query of [
    "?storageDir=/tmp/foreign",
    "?workspacePath=/tmp/foreign",
    "?workspaceScopes=/tmp/foreign",
    "?withoutSession=1",
    "?limit=0",
    "?limit=201",
    "?limit=2&limit=3",
    "?since=20&until=10",
    "?status=unknown",
    "?callType=main",
    "?callType=SUMMARY",
    "?callType=title&callType=execution",
    "?cursor=%00",
  ])
    expect((await f.request(query)).status).toBe(400);
  expect((await f.request("/%2e%2e%2Fsecret")).status).toBe(400);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await f.request("/config", method);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  }
  expect(await (await f.request("/config")).json()).toEqual(original);
  expect(f.store.getConfig()).toEqual(original);
});

test("two Host stores stay isolated and native setters validate complete configuration before writing", async () => {
  const f = await fixture();
  const first = createModelTraceHistory({ storageDir: f.storageDir });
  const second = createModelTraceHistory({ storageDir: join(f.root, "separate", ".model-traces") });
  expect(second.list().items).toEqual([]);
  expect(second.get("visible")).toBeNull();
  expect(
    first.setConfig({ captureContent: false, includeEphemeral: false, retentionDays: 30 }),
  ).toMatchObject({
    enabled: true,
    captureContent: false,
    includeEphemeral: false,
    retentionDays: 30,
  });
  expect(second.getConfig().captureContent).toBe(true);
  for (const patch of [
    { captureContent: "yes" },
    { includeEphemeral: 1 },
    { retentionDays: 0 },
    { retentionDays: 366 },
    { storageDir: f.root },
    { enabled: false, unexpected: true },
  ])
    expect(() => first.setConfig(patch)).toThrow();
  expect(first.getConfig().enabled).toBe(true);
});

test("trusted related scopes expose project Panel calls without exposing ordinary project chats or events", async () => {
  const f = await fixture();
  f.setScopes([{ workspacePath: f.root, sourcePrefix: "panel:" }]);
  const now = Date.now();
  f.store.write({ ...entry("root-panel", f.root), source: "panel:video:tts", startedAt: now + 2 });
  f.store.write({ ...entry("root-chat", f.root), source: "desktop", startedAt: now + 3 });
  f.store.write({
    ...entry("other-panel", f.other),
    source: "panel:video:tts",
    startedAt: now + 4,
  });
  for (const [id, parentId, workspacePath] of [
    ["panel-event", "root-panel", f.root],
    ["panel-child", "panel-event", f.root],
    ["root-chat-event", "root-chat", f.root],
    ["unlinked-root-event", undefined, f.root],
    ["other-panel-event", "root-panel", f.other],
  ] as const)
    f.store.writeEvent({
      id,
      parentId,
      workspacePath,
      traceId: "shared-run",
      kind: "tool",
      name: id,
      startedAt: now,
      status: "completed",
      inputState: "not-recorded",
      outputState: "not-recorded",
    });
  const first = await (await f.request("?limit=1")).json();
  expect(first.total).toBe(2);
  expect(first.items.map((item: any) => item.id)).toEqual(["root-panel"]);
  const second = await (
    await f.request("?limit=1&cursor=" + encodeURIComponent(first.nextCursor))
  ).json();
  expect(second.items.map((item: any) => item.id)).toEqual(["visible"]);
  const detail = await (await f.request("/root-panel")).json();
  expect(detail.events.map((event: any) => event.id).sort()).toEqual([
    "our-event",
    "panel-child",
    "panel-event",
  ]);
  for (const id of ["root-chat", "other-panel"])
    expect((await f.request("/" + id)).status).toBe(404);
  f.setScopes(undefined);
  expect((await (await f.request()).json()).items.map((item: any) => item.id)).toEqual(["visible"]);
  expect((await f.request("/root-panel")).status).toBe(404);
});

test("revoking a related workspace during a request discards its already-read prompts", async () => {
  const f = await fixture();
  f.store.write({ ...entry("root-panel", f.root), source: "panel:video:tts" });
  let reads = 0;
  f.setScopeResolver(() =>
    ++reads === 1 ? [{ workspacePath: f.root, sourcePrefix: "panel:" }] : undefined,
  );
  const response = await f.request("/root-panel");
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("root-panel");
});

test("session HTTP groups all authorized executions before pagination and keeps standalone calls separate", async () => {
  const f = await fixture();
  const now = Date.now();
  for (let i = 0; i < 205; i++)
    f.store.write({
      ...entry(`session-call-${i}`, f.cwd),
      sessionId: "real-session",
      traceId: i % 2 ? "second-run" : "first-run",
      startedAt: now + 10 - i,
    });
  f.store.write({
    ...entry("foreign-session-call", f.other),
    sessionId: "real-session",
    startedAt: now + 100,
  });
  f.store.write({
    ...entry("other-visible", f.cwd),
    traceId: "separate-run",
    startedAt: now - 500,
  });
  expect((await f.request("/sessions", "GET", false)).status).toBe(401);
  const first = await (await f.request("/sessions?limit=1")).json();
  expect(first.total).toBe(3);
  expect(first.items[0]).toMatchObject({
    key: "session:real-session",
    sessionId: "real-session",
    callCount: 205,
    traceCount: 2,
    latestRequestId: "session-call-0",
    latestTraceId: "first-run",
  });
  const second = await (
    await f.request("/sessions?limit=1&cursor=" + encodeURIComponent(first.nextCursor))
  ).json();
  expect(second.items[0]).toMatchObject({
    key: "trace:shared-run",
    traceId: "shared-run",
    callCount: 1,
  });
  expect(second.items[0]).not.toHaveProperty("sessionId");
  const filtered = await (
    await f.request("/sessions?sessionId=real-session&traceId=second-run")
  ).json();
  expect(filtered.total).toBe(1);
  expect(filtered.items[0]).toMatchObject({ callCount: 102, traceCount: 1 });
  expect((await (await f.request("/sessions?withoutSession=true")).json()).total).toBe(2);
  expect((await (await f.request("?traceId=first-run&withoutSession=true")).json()).total).toBe(0);
  for (const query of [
    "?withoutSession=1",
    "?cursor=invalid",
    "?workspacePath=/foreign",
    "?workspaceScopes=/foreign",
    "?storageDir=/foreign",
    "?limit=201",
    "?limit=1&limit=2",
  ])
    expect((await f.request("/sessions" + query)).status).toBe(400);
  f.setAllowed(false);
  expect((await f.request("/sessions")).status).toBe(401);
});

test("session aggregation rechecks related workspace authority before responding", async () => {
  const f = await fixture();
  f.store.write({
    ...entry("root-session-call", f.root),
    sessionId: "root-session",
    source: "panel:fixture",
  });
  f.setScopes([{ workspacePath: f.root, sourcePrefix: "panel:" }]);
  expect(
    (await (await f.request("/sessions?sessionId=root-session")).json()).items[0].callCount,
  ).toBe(1);
  let reads = 0;
  f.setScopeResolver(() =>
    ++reads === 1 ? [{ workspacePath: f.root, sourcePrefix: "panel:" }] : undefined,
  );
  const response = await f.request("/sessions");
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("root-session");
});

test("call category queries filter only authorized metadata before call and session paging", async () => {
  const f = await fixture();
  const now = Date.now();
  for (const [id, workspacePath, purpose, sessionId, offset] of [
    ["summary-a", f.cwd, "aux_summary", "session-a", 1],
    ["summary-b", f.cwd, "manual_compact", "session-b", 2],
    ["title-a", f.cwd, "title", "session-a", 3],
    ["foreign-summary", f.other, "aux_summary", "session-a", 4],
    ["unknown-summary", undefined, "aux_summary", "session-a", 5],
  ] as const)
    f.store.write({
      ...entry(id, workspacePath),
      sessionId,
      purpose,
      startedAt: now + offset,
      callType: "execution",
    });
  const calls = await (await f.request("?callType=summary&limit=1")).json();
  expect(calls.total).toBe(2);
  expect(calls.items[0]).toMatchObject({
    id: "summary-b",
    purpose: "manual_compact",
    callType: "summary",
  });
  const nextCalls = await (
    await f.request("?callType=summary&limit=1&cursor=" + encodeURIComponent(calls.nextCursor))
  ).json();
  expect(nextCalls.items.map((item: any) => item.id)).toEqual(["summary-a"]);
  const sessions = await (await f.request("/sessions?callType=summary&limit=1")).json();
  expect(sessions.total).toBe(2);
  expect(sessions.items[0]).toMatchObject({
    sessionId: "session-b",
    callCount: 1,
    callTypes: ["summary"],
  });
  const nextSessions = await (
    await f.request(
      "/sessions?callType=summary&limit=1&cursor=" + encodeURIComponent(sessions.nextCursor),
    )
  ).json();
  expect(nextSessions.items[0]).toMatchObject({
    sessionId: "session-a",
    callCount: 1,
    callTypes: ["summary"],
  });
  expect((await (await f.request("/title-a")).json()).record.callType).toBe("title");
  expect((await (await f.request("?callType=title&purpose=main")).json()).total).toBe(0);
  for (const query of [
    "?callType=main",
    "?callType=",
    "?callTypes=title",
    "?callType=title&workspacePath=/foreign",
  ])
    expect((await f.request("/sessions" + query)).status).toBe(400);
});
