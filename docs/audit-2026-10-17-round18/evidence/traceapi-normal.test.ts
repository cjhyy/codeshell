import { expect, test } from "bun:test";
import { createRemoteModelTraceApi } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/web/src/model-trace-api.ts";

test("omitted and explicitly undefined query values keep the four ordinary route paths", async () => {
  const paths: string[] = [];
  const api = createRemoteModelTraceApi({
    request: async (path) => {
      paths.push(path);
      return { items: [], total: 0 };
    },
  });
  await api.list();
  await api.sessions();
  await api.list({ search: undefined, cursor: undefined });
  await api.sessions({ model: undefined });
  expect(paths).toEqual([
    "/api/v1/model-traces",
    "/api/v1/model-traces/sessions",
    "/api/v1/model-traces",
    "/api/v1/model-traces/sessions",
  ]);
});

test("all ordinary list filters survive a URL query round trip with Unicode and punctuation", async () => {
  const paths: string[] = [];
  const api = createRemoteModelTraceApi({ request: async (path) => { paths.push(path); return { items: [], total: 0 }; } });
  const query = Object.freeze({
    limit: 50,
    cursor: "next+/= &世界?%#",
    search: "hello & 世界 + 🙂 /?=%#",
    traceId: "trace-normal-1",
    sessionId: "session-normal-1",
    withoutSession: false,
    model: "normal/model-v1",
    provider: "normal provider",
    purpose: "title & summary",
    callType: "execution" as const,
    source: "normal-source",
    status: "completed" as const,
    since: 0,
    until: 1_790_000_000_000,
  });
  await api.list(query);
  const url = new URL(paths[0]!, "https://memory.example.invalid");
  expect(url.pathname).toBe("/api/v1/model-traces");
  expect([...url.searchParams.entries()]).toEqual(Object.entries(query).map(([key, value]) => [key, String(value)]));
  expect(query.cursor).toBe("next+/= &世界?%#");
  expect(query.search).toBe("hello & 世界 + 🙂 /?=%#");
});

test("sessions preserve normal filters, standalone grouping, and an opaque next-page cursor", async () => {
  const paths: string[] = [];
  const page = { items: [], total: 3, nextCursor: "第二页+/=" };
  const api = createRemoteModelTraceApi({ request: async (path) => { paths.push(path); return page; } });
  const first = await api.sessions({ search: "🙂 café", callType: "speech", withoutSession: true, limit: 3 });
  const second = await api.sessions({ search: "🙂 café", callType: "speech", withoutSession: true, limit: 3, cursor: first.nextCursor });
  const url = new URL(paths[1]!, "https://memory.example.invalid");
  expect(first).toBe(page);
  expect(second).toBe(page);
  expect(url.pathname).toBe("/api/v1/model-traces/sessions");
  expect(Object.fromEntries(url.searchParams)).toEqual({ search: "🙂 café", callType: "speech", withoutSession: "true", limit: "3", cursor: "第二页+/=" });
});

test("list preserves the requester's page items, total, and optional cursor without mutation", async () => {
  const item = Object.freeze({ id: "ordinary-record-1", model: "ordinary-model", attemptCount: 1 });
  const items = Object.freeze([item]);
  const page = Object.freeze({ items, total: 19, nextCursor: "opaque-list-cursor" });
  const api = createRemoteModelTraceApi({ request: async () => page });
  const result = await api.list({ limit: 1 });
  expect(result).toBe(page);
  expect(result.items).toBe(items);
  expect(result.items[0]).toBe(item);
  expect(result.total).toBe(19);
  expect(result.nextCursor).toBe("opaque-list-cursor");
});

test("explicit empty ordinary string filters remain explicit while absent optionals stay absent", async () => {
  const paths: string[] = [];
  const api = createRemoteModelTraceApi({ request: async (path) => { paths.push(path); return { items: [], total: 0 }; } });
  await api.list({ search: "", cursor: "", model: undefined, provider: "" });
  expect(paths).toEqual(["/api/v1/model-traces?search=&cursor=&provider="]);
});

test("get passes a locally fabricated ordinary id and returns its owned detail object", async () => {
  const paths: string[] = [];
  const detail = { record: { id: "normal_record-1", attempts: [] }, events: [{ id: "event-1" }] };
  const api = createRemoteModelTraceApi({ request: async (path) => { paths.push(path); return detail; } });
  const result = await api.get("normal_record-1");
  expect(paths).toEqual(["/api/v1/model-traces/normal_record-1"]);
  expect(result).toBe(detail);
  expect(result?.events).toBe(detail.events);
});

test("getConfig uses the fixed ordinary config route and preserves owned configuration fields", async () => {
  const paths: string[] = [];
  const config = Object.freeze({ policyRevision: "owned-fixture-v1", enabled: true, captureContent: false, retentionDays: 7, includeEphemeral: true });
  const api = createRemoteModelTraceApi({ request: async (path) => { paths.push(path); return config; } });
  expect(await api.getConfig()).toBe(config);
  expect(paths).toEqual(["/api/v1/model-traces/config"]);
});

test("concurrent ordinary list and session requests retain separate query parameters and results", async () => {
  const calls: Array<{ path: string; finish: (value: unknown) => void }> = [];
  const api = createRemoteModelTraceApi({ request: (path) => new Promise((finish) => { calls.push({ path, finish }); }) });
  const listPromise = api.list({ search: "list & 一", limit: 2 });
  const sessionPromise = api.sessions({ search: "sessions + 二", limit: 3 });
  const listPage = { items: [], total: 2 };
  const sessionPage = { items: [], total: 3, nextCursor: "ordinary-next" };
  expect(calls.map(({ path }) => path)).toEqual([
    "/api/v1/model-traces?search=list+%26+%E4%B8%80&limit=2",
    "/api/v1/model-traces/sessions?search=sessions+%2B+%E4%BA%8C&limit=3",
  ]);
  calls[1]!.finish(sessionPage);
  calls[0]!.finish(listPage);
  expect(await listPromise).toBe(listPage);
  expect(await sessionPromise).toBe(sessionPage);
});
