import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

// The real Host/Link/controller path below uses only an injected credential adapter.
// Install a socket guard before importing any producer; no provider is contacted.
const surfaces = [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
  [net, "connect"],
  [net, "createConnection"],
  [net.Socket.prototype, "connect"],
] as const;
const originals = surfaces.map(([target, key]) => ({
  target: target as unknown as Record<string, unknown>,
  key,
  descriptor: Object.getOwnPropertyDescriptor(target, key),
}));
let deniedNetwork = 0;
for (const { target, key } of originals)
  target[key] = () => {
    deniedNetwork++;
    throw new Error("external operations fixture denied outbound network");
  };
syncBuiltinESMExports();
expect(() => fetch("https://outside.invalid/probe")).toThrow("denied outbound");
expect(() => https.get("https://outside.invalid/probe")).toThrow("denied outbound");

const { SessionManager, ToolRegistry, setDefaultCredentialAccess } =
  await import("@cjhyy/code-shell-core");
const { createSessionToolHost } = await import("@cjhyy/code-shell-core/extension");
const { ExternalRuntimeOperationRun } = await import("./external-runtime-operations.js");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  setDefaultCredentialAccess(null);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(() => {
  try {
    expect(deniedNetwork).toBe(2);
  } finally {
    for (const { target, key, descriptor } of originals) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    syncBuiltinESMExports();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture(backend: "remote" | "pat" = "remote") {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-external-ops-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "sessions"),
    cwd = join(directory, "workspace"),
    sessionId = "external-fixture";
  mkdirSync(cwd);
  const sessions = new SessionManager(root);
  sessions.create(cwd, "fixture", "codex", sessionId);
  let generation = 0;
  let current: InstanceType<typeof ExternalRuntimeOperationRun> | undefined;
  const begin = (origin = `intent-${generation + 1}`, closePrevious = true) => {
    if (closePrevious) current?.finish();
    const runId = `run-${++generation}`;
    sessions.startSessionRun(sessions.readSessionState(sessionId)!, runId, origin);
    current = new ExternalRuntimeOperationRun({
      root,
      sessionId,
      runId,
      originClientMessageId: origin,
      isCurrent: () => generation === Number(runId.slice(4)),
    });
    return current;
  };
  begin();
  const credential = {
    id: "connection",
    type: backend === "remote" ? ("oauth" as const) : ("link" as const),
    label: "Fixture",
    hasSecret: true,
    oauthStatus: backend === "remote" ? { state: "valid" as const, canRefresh: true } : undefined,
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: backend === "remote" ? "server" : "local",
      linkExecutionBackend: backend === "remote" ? "remote" : "http-token",
      linkAccountId: "42",
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      linkRemoteState: "connected",
      linkRemoteGrantId: "grant",
      linkCapabilityIds: ["github.get_repository", "github.get_starred", "github.set_starred"],
    },
  };
  const calls: string[] = [];
  let starred = false;
  let lose = false;
  let approval: () => Promise<string> = async () => "允许执行";
  let onRead: (() => void) | undefined;
  let onWrite: (() => Promise<void>) | undefined;
  let onResolve: (() => Promise<void>) | undefined;
  setDefaultCredentialAccess({
    listMasked: () => [credential],
    resolveMeta: () => credential,
    envExposures: () => ({}),
    resolveValue: async () => {
      await onResolve?.();
      return "fixture-token";
    },
    executeRemoteLinkAction: async ({ action, params }) => {
      calls.push(action);
      if (action === "get_repository") return { id: 123, full_name: "acme/repo" };
      if (action === "get_starred") {
        onRead?.();
        return { starred };
      }
      if (action === "set_starred") {
        starred = params.starred as boolean;
        await onWrite?.();
        if (lose) throw new Error("Lost response after physical send");
        return { acknowledged: true };
      }
      throw new Error("Unexpected fixture action");
    },
  });
  const registry = new ToolRegistry({ builtinTools: ["LinkAction"] });
  registry.registerTool(
    {
      name: "Probe",
      description: "Read trusted call identity",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
      isReadOnly: true,
      isConcurrencySafe: true,
      permissionDefault: "allow",
    },
    async (_args, context) =>
      JSON.stringify({
        origin: context.originClientMessageId,
        runId: context.operations?.runId,
        sessionId: context.operations?.sessionId,
      }),
  );
  const host = createSessionToolHost({
    businessSessionId: sessionId,
    cwd,
    registry,
    settingsScope: "isolated",
    projectTrusted: false,
    permissionMode: "default",
    presetRules: [
      { tool: "LinkAction", decision: "allow" },
      { tool: "Probe", decision: "allow" },
    ],
    exposure: { mode: "allowlist", toolNames: new Set(["LinkAction", "Probe"]) },
    visibility: { cwd, host: "desktop", isSubAgent: false },
    captureRunContext: () => current?.capture(),
    contextOverrides: { askUser: () => approval() },
  });
  cleanups.push(() => host.dispose());
  const invoke = async (desired = true) => {
    const result = await host.execute({
      id: `call-${calls.length}`,
      name: "LinkAction",
      input: {
        provider: "github",
        action: "set_starred",
        connectionId: "connection",
        params: { owner: "Acme", repo: "Repo", starred: desired },
        // Model fields never become Host authority.
        originClientMessageId: "forged",
        operations: { runId: "forged", sessionId: "other" },
      },
    });
    return result.isError
      ? { kind: "executor_error", error: result.error }
      : JSON.parse(String(result.result).split("\n")[0]!);
  };
  return {
    host,
    calls,
    sessions,
    root,
    sessionId,
    begin,
    invoke,
    get current() {
      return current!;
    },
    setApproval: (fn: typeof approval) => (approval = fn),
    setOnRead: (fn: typeof onRead) => (onRead = fn),
    setOnWrite: (fn: typeof onWrite) => (onWrite = fn),
    setOnResolve: (fn: typeof onResolve) => (onResolve = fn),
    lose: () => (lose = true),
    clearCurrent: () => (current = undefined),
  };
}

test("an approved Link write executes once and independently reads its postcondition", async () => {
  const f = fixture();
  const result = await f.invoke();
  expect(result.operation.state).toBe("verified");
  expect(f.calls).toEqual([
    "get_repository",
    "get_starred",
    "set_starred",
    "get_repository",
    "get_starred",
  ]);
  expect(f.current.terminalReason("completed")).toBe("completed");
  expect(f.current.capture()).toBeUndefined();
});

test("denied Link approval sends no write and never invents an unverified write", async () => {
  const f = fixture();
  f.setApproval(async () => "取消");
  const result = await f.invoke();
  expect(result.kind).toBe("cancelled");
  expect(f.calls).toEqual([]);
  expect(f.current.context.signal.aborted).toBe(false);
  expect(f.current.terminalReason("completed")).toBe("completed");
});

test("a lost physical write blocks further sends across tool calls and subsequent runs", async () => {
  const f = fixture();
  f.lose();
  expect((await f.invoke()).kind).toBe("executor_error");
  expect(f.current.hasUnverifiedWrites()).toBe(true);
  expect(f.current.context.signal.aborted).toBe(true);
  expect((await f.invoke()).kind).toBe("executor_error");
  expect(f.current.terminalReason("completed")).toBe("unverified_write");
  f.begin("real-followup");
  expect((await f.invoke()).kind).toBe("executor_error");
  expect(f.calls.filter((action) => action === "set_starred")).toHaveLength(1);
  expect(f.current.terminalReason("completed")).toBe("unverified_write");
});

test("a parked approval keeps its original run and cannot borrow a later submission", async () => {
  const f = fixture();
  const entered = deferred<void>(),
    release = deferred<string>();
  f.setApproval(() => {
    entered.resolve();
    return release.promise;
  });
  const pending = f.invoke();
  await entered.promise;
  const first = f.current;
  f.begin("second-user");
  release.resolve("允许执行");
  const result = await pending;
  expect(result.operation?.state ?? result.kind).toMatch(/blocked|executor_error|^error$/);
  expect(first.capture()).toBeUndefined();
  expect(f.calls).not.toContain("set_starred");
  const probe = await f.host.execute({
    id: "probe-new",
    name: "Probe",
    input: { originClientMessageId: "forged", runId: "forged" },
  });
  expect(probe.isError).toBeFalsy();
  expect(JSON.parse(String(probe.result))).toEqual({
    origin: "second-user",
    runId: "run-2",
    sessionId: f.sessionId,
  });
});

test("durable owner replacement during preflight stops before sending, without a cancel signal", async () => {
  const f = fixture();
  f.setOnRead(() => {
    f.sessions.startSessionRun(f.sessions.readSessionState(f.sessionId)!, "replacement", "new");
  });
  const result = await f.invoke();
  expect(result.operation?.state ?? result.kind).toMatch(/blocked|executor_error|^error$/);
  expect(f.calls).not.toContain("set_starred");
  expect(f.current.capture()).toBeUndefined();
});

test("interrupt seals an in-flight physical write; a late acknowledgement cannot verify it", async () => {
  const f = fixture();
  const sent = deferred<void>(),
    release = deferred<void>();
  f.setOnWrite(() => {
    sent.resolve();
    return release.promise;
  });
  const pending = f.invoke();
  await sent.promise;
  const first = f.current;
  expect(first.finish()).toBe(true);
  f.begin("next-user");
  release.resolve();
  const late = await pending;
  expect(late.kind).toBe("executor_error");
  expect(first.hasUnverifiedWrites()).toBe(true);
  expect((await f.invoke(false)).kind).toBe("executor_error");
  expect(f.calls).toEqual(["get_repository", "get_starred", "set_starred"]);
  expect(first.terminalReason("completed")).toBe("unverified_write");
});

test("tool calls outside an active submission fail closed", async () => {
  const f = fixture();
  f.current.finish();
  expect((await f.invoke()).kind).toBe("executor_error");
  f.clearCurrent();
  expect((await f.host.execute({ id: "orphan", name: "Probe", input: {} })).isError).toBe(true);
  expect(f.calls).toEqual([]);
});

test("a reminder without a real user anchor retains reads but has no write capability", async () => {
  const f = fixture();
  let approvals = 0;
  f.setApproval(async () => {
    approvals++;
    return "允许执行";
  });
  f.begin("");
  expect(f.current.capture()).toBeDefined();
  expect(f.current.context.operations).toBeUndefined();
  const read = await f.host.execute({
    id: "read-no-intent",
    name: "LinkAction",
    input: {
      provider: "github",
      action: "get_starred",
      connectionId: "connection",
      params: { owner: "acme", repo: "repo" },
    },
  });
  expect(read.isError).toBeFalsy();
  expect(JSON.parse(String(read.result)).kind).toBe("action_result");
  expect((await f.invoke()).kind).toBe("error");
  expect(approvals).toBe(0);
  expect(f.calls).toEqual(["get_starred"]);
});

test("external model billing remains incomplete even before its first token event", () => {
  const f = fixture();
  const state = f.sessions.readSessionState(f.sessionId)!;
  expect(state.tokenUsage.totalTokens).toBe(0);
  expect(state.costState).toMatchObject({
    kind: "usage-ledger",
    historicalCoverageIncomplete: true,
    summary: { partial: true, requests: 0 },
  });
});

test("a superseded run freezes only its own physical send after a late acknowledgement", async () => {
  const f = fixture();
  const sent = deferred<void>(),
    release = deferred<void>();
  f.setOnWrite(() => {
    sent.resolve();
    return release.promise;
  });
  const pending = f.invoke();
  await sent.promise;
  f.sessions.startSessionRun(f.sessions.readSessionState(f.sessionId)!, "replacement", "new");
  expect(f.current.finish()).toBe(false);
  release.resolve();
  await pending;
  const receipts = JSON.parse(readFileSync(join(f.root, ".operations", "ledger.json"), "utf8"));
  expect(Object.values(receipts.records).map((receipt: any) => receipt.state)).toEqual(["unknown"]);
  expect(f.calls).toEqual(["get_repository", "get_starred", "set_starred"]);
});

test("PAT credential resolution rechecks the durable owner before physical write IO", async () => {
  const f = fixture("pat");
  const resolving = deferred<void>(),
    release = deferred<void>();
  let resolutions = 0;
  f.setOnResolve(async () => {
    if (++resolutions === 3) {
      resolving.resolve();
      await release.promise;
    }
  });
  const priorFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (url.origin !== "https://api.github.com" || method !== "GET")
      throw new Error("PAT fixture denied a non-fixture request");
    if (url.pathname === "/repos/acme/repo")
      return Response.json({ id: 123, full_name: "acme/repo" });
    if (url.pathname === "/user/starred/acme/repo") return new Response(null, { status: 404 });
    throw new Error("PAT fixture denied an unexpected path");
  }) as typeof fetch;
  try {
    const pending = f.invoke();
    await Promise.race([
      resolving.promise,
      pending.then((result) => {
        throw new Error(JSON.stringify(result));
      }),
    ]);
    f.sessions.startSessionRun(f.sessions.readSessionState(f.sessionId)!, "replacement", "new");
    release.resolve();
    expect((await pending).kind).toBe("error");
    expect(requests).toEqual(["GET /repos/acme/repo", "GET /user/starred/acme/repo"]);
  } finally {
    release.resolve();
    globalThis.fetch = priorFetch;
  }
});

test("custody lost during independent verification seals the receipt and preserves sent evidence", async () => {
  const f = fixture();
  const checking = deferred<void>(),
    release = deferred<void>();
  const context = f.current.context;
  const pending = context.operations!.controller.run(
    {
      sessionId: f.sessionId,
      intentId: context.originClientMessageId,
      service: "github",
      action: "create_issue",
      channel: "remote-link",
      account: null,
      target: null,
      parameters: null,
      postcondition: null,
    },
    {
      assertAuthorized: context.assertCurrent,
      preflight: async () => {},
      validate: async () => {},
      authorize: async () => true,
      execute: async () => ({ id: "physically-sent-issue" }),
      verify: async () => {
        checking.resolve();
        await release.promise;
        return true;
      },
    },
  );
  await checking.promise;
  f.sessions.startSessionRun(f.sessions.readSessionState(f.sessionId)!, "replacement", "new");
  release.resolve();
  await expect(pending).rejects.toThrow("no longer current");
  const receipts = JSON.parse(readFileSync(join(f.root, ".operations", "ledger.json"), "utf8"));
  expect(Object.values(receipts.records)).toMatchObject([
    { state: "unknown", reference: { id: "physically-sent-issue" } },
  ]);
});
