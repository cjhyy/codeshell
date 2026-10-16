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
    "?limit=0",
    "?limit=201",
    "?limit=2&limit=3",
    "?since=20&until=10",
    "?status=unknown",
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
