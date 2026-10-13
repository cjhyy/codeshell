import { afterAll, afterEach, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http, { createServer } from "node:http";
import https from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
let loseResponse = false,
  mismatchRead = false;
const issues = new Map<number, Record<string, unknown>>();
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  const input = JSON.parse(text);
  calls.push(input);
  let result: unknown;
  if (input.action === "create_issue") {
    const number = issues.size + 1;
    result = {
      ...input.params,
      number,
      state: "open",
      body: input.params.body ?? "",
      id: 1000 + number,
      repository_url: `https://api.github.com/repos/${input.params.owner}/${input.params.repo}`,
    };
    issues.set(number, result as Record<string, unknown>);
    if (loseResponse) {
      request.socket.destroy();
      return;
    }
  } else if (input.action === "list_issues") result = { issues: [] };
  else if (input.action === "get_issue")
    result = {
      ...issues.get(input.params.issue_number),
      ...(mismatchRead ? { title: "Not the approved title" } : {}),
    };
  else {
    response.writeHead(400).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(result));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const { installLocalNetworkGuard } = await import("../../scripts/runtime-cost-smoke-isolation.mjs");
const originalHttpExports = { ...(await import("node:http")) };
const originalHttpsExports = { ...(await import("node:https")) };
installLocalNetworkGuard(origin);
// Bun 1.3.11 does not synchronize already loaded builtin ESM named exports
// when default.request/get are patched. Bind those exits to the SAME guarded
// real transports before Core loads; allowed-origin HTTP is still physical.
mock.module("node:http", () => ({
  ...originalHttpExports,
  default: http,
  request: http.request,
  get: http.get,
}));
mock.module("node:https", () => ({
  ...originalHttpsExports,
  default: https,
  request: https.request,
  get: https.get,
}));
// These are actual dynamic named imports, using the same module resolution as
// the subsequent Core imports. Every other builtin export remains unchanged.
const controlledHttp = await import("node:http");
const controlledHttps = await import("node:https");
for (const [original, controlled, transport] of [
  [originalHttpExports, controlledHttp, http],
  [originalHttpsExports, controlledHttps, https],
] as const) {
  assert.deepEqual(Object.keys(controlled).sort(), Object.keys(original).sort());
  for (const name of Object.keys(original))
    if (!["default", "request", "get"].includes(name))
      assert.equal(controlled[name], original[name], name);
  assert.equal(controlled.default, transport);
  assert.equal(controlled.request, transport.request);
  assert.equal(controlled.get, transport.get);
}
const home = process.env.HOME!;
assert.equal(realpathSync(home), home);
assert.equal(homedir(), home);
assert.equal(process.env.USERPROFILE, home);
assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);

const negativeProbeNames: string[] = [];
for (const [name, probe] of [
  ["fetch", () => fetch("https://example.invalid/blocked")],
  ["dispatcher", () => fetch(origin, { dispatcher: {} } as any)],
  ["http.request", () => http.request("http://127.0.0.1:1")],
  ["http.named.request", () => controlledHttp.request("http://127.0.0.1:1")],
  ["http.named.get", () => controlledHttp.get("http://127.0.0.1:1")],
  ["https.named.request", () => controlledHttps.request("https://example.invalid/blocked")],
  ["https.named.get", () => controlledHttps.get("https://example.invalid/blocked")],
  ["socketPath", () => http.request(origin, { socketPath: "/unavailable" })],
] as const) {
  assert.throws(probe, /Cost smoke refused/, name);
  negativeProbeNames.push(name);
}

const evidence = mkdtempSync(join(tmpdir(), "codeshell-batch-evidence-"));
const guardReceipt = {
  phase: "before-Core-import",
  pid: process.pid,
  ppid: process.ppid,
  runtime: process.versions,
  homeId: createHash("sha256").update(home).digest("hex"),
  origin,
  privateHome: homedir() === home && process.env.USERPROFILE === home,
  negativeProbes: negativeProbeNames,
};
writeFileSync(join(evidence, "guard.json"), JSON.stringify(guardReceipt), { mode: 0o600 });
console.log(`Batch preimport receipt: ${evidence}/guard.json`);
const { createGithubIssueBatch, normalizeGithubIssueBatch, githubIssueBatchPolicy } =
  await import("../../packages/core/src/links/github-issue-batch.js");
const { githubOperationPlan } = await import("../../packages/core/src/links/operation-recovery.js");
const { OperationLedger } = await import("../../packages/core/src/operations/ledger.js");
const { OperationController } = await import("../../packages/core/src/operations/controller.js");
const { readOperationSessionOwner } =
  await import("../../packages/core/src/operations/session-owner.js");
const { SessionManager } = await import("../../packages/core/src/session/session-manager.js");
const { UsageLedger } = await import("../../packages/core/src/cost-ledger/store.js");
const { CapabilityResolver } = await import("../../packages/core/src/operations/resolver.js");
const { setDefaultCredentialAccess } =
  await import("../../packages/core/src/credentials/access.js");
const { ToolRegistry } = await import("../../packages/core/src/tool-system/registry.js");
const { ToolExecutor } = await import("../../packages/core/src/tool-system/executor.js");
const { PermissionClassifier } = await import("../../packages/core/src/tool-system/permission.js");
const { HookRegistry } = await import("../../packages/core/src/hooks/registry.js");
const { requestOnce } = await import("../../packages/core/src/links/request-once.js");

const roots: string[] = [];
afterEach(() => {
  setDefaultCredentialAccess(null);
  calls.length = 0;
  issues.clear();
  loseResponse = false;
  mismatchRead = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});
const item = (title: string) => ({
  owner: "synthetic-owner",
  repo: "synthetic-repo",
  title,
  body: "Synthetic body",
});
function fixture() {
  const root = mkdtempSync(join(home, "batch-"));
  roots.push(root);
  const sessionId = "fixture-session",
    originIntent = randomUUID();
  const sessions = new SessionManager(root);
  const bundle = sessions.create(root, "batch-local-fixture", "batch-local-fixture", sessionId);
  bundle.state.status = "paused";
  bundle.state.costState = new UsageLedger().sessionState(sessionId, root);
  sessions.saveState(bundle.state);
  const connection = {
    id: "fixture-link",
    type: "oauth" as const,
    label: "Synthetic connection",
    hasSecret: true,
    oauthStatus: { state: "valid" as const, hasRefreshToken: true, canRefresh: true },
    meta: {
      linkProvider: "github",
      linkAccountId: "42",
      linkExecutionRuntime: "server" as const,
      linkExecutionBackend: "remote" as const,
      linkRemoteState: "connected" as const,
      linkRemoteGrantId: "synthetic-grant",
      linkLastVerifiedAt: "2026-10-10T00:00:00Z",
      linkCapabilityIds: ["github.create_issue", "github.list_issues", "github.get_issue"],
    },
  };
  const ledger = () =>
    new OperationLedger(root, undefined, {
      sessionId,
      read: () => readOperationSessionOwner(root, sessionId),
    });
  const input = {
    root,
    sessionId,
    originIntent,
    connection,
    items: [item("one"), item("two")],
    assertCurrent() {},
  };
  const batch = createGithubIssueBatch(input);
  let approvals = 0,
    allowWrite = true;
  const ctx: any = {
    cwd: root,
    settingsScope: "isolated",
    sessionId,
    originClientMessageId: originIntent,
    askUser: async () => {
      approvals++;
      return allowWrite ? "允许执行" : "取消";
    },
    allowedToolNames: new Set(["LinkAction"]),
    operations: {
      controller: new OperationController(ledger()),
      resolver: new CapabilityResolver(),
      sessionId,
      runId: "physical-run",
      onToolFailure: async () => batch.close(),
      batchAuthority: async (_phase: string, _id: string, params: Record<string, unknown>) =>
        batch.resolve(params),
    },
  };
  setDefaultCredentialAccess({
    listMasked: () => [connection],
    resolveMeta: () => connection,
    envExposures: () => ({}),
    executeRemoteLinkAction: async (input: any) => {
      const response = await requestOnce(origin, {
        method: "POST",
        body: JSON.stringify({ action: input.action, params: input.params }),
      });
      return response.json();
    },
  });
  const invoke = async (
    params = item("one"),
    extraRules: any[] = [],
    hooks = new HookRegistry(),
  ) => {
    const executor = new ToolExecutor(
      new ToolRegistry({ builtinTools: ["LinkAction"] }),
      new PermissionClassifier(
        [...extraRules, { tool: "LinkAction", decision: "allow" }],
        "default",
      ),
      hooks,
    );
    executor.setContext(ctx);
    const result = await executor.executeSingle({
      id: randomUUID(),
      toolName: "LinkAction",
      args: { provider: "github", action: "create_issue", connectionId: connection.id, params },
    });
    return result.isError
      ? { kind: "executor_error", error: result.error }
      : JSON.parse(String(result.result));
  };
  return {
    root,
    sessionId,
    originIntent,
    connection,
    input,
    batch,
    ledger,
    ctx,
    invoke,
    approvals: () => approvals,
    setApproval: (value: boolean) => {
      allowWrite = value;
    },
  };
}
test("actual ToolExecutor verifies two fixed slots, duplicate physical tool IDs never send twice", async () => {
  const f = fixture();
  expect((await f.invoke()).kind).toBe("action_result");
  expect((await f.invoke()).kind).toBe("action_result");
  expect((await f.invoke(item("two"))).kind).toBe("action_result");
  expect(calls.map((c) => c.action)).toEqual([
    "list_issues",
    "create_issue",
    "get_issue",
    "list_issues",
    "create_issue",
    "get_issue",
  ]);
  expect(f.approvals()).toBe(3);
  expect(f.batch.finish().allVerified).toBe(true);
});
test("out-of-order and changed parameters cannot mint an additional slot", async () => {
  const f = fixture();
  expect((await f.invoke(item("two"))).kind).toBe("error");
  expect((await f.invoke(item("extra"))).kind).toBe("error");
  expect(calls).toEqual([]);
});
test("lost physical response keeps one POST and blocks all subsequent items", async () => {
  const f = fixture();
  loseResponse = true;
  expect((await f.invoke()).kind).toBe("unverified_write");
  expect((await f.invoke(item("two"))).kind).toBe("error");
  expect(calls.filter((c) => c.action === "create_issue")).toHaveLength(1);
  expect(() => f.batch.finish()).toThrow(/ended/);
});
test("failed postcondition stays sealed even when a later read would match", async () => {
  const f = fixture();
  mismatchRead = true;
  expect((await f.invoke()).kind).toBe("unverified_write");
  mismatchRead = false;
  expect((await f.invoke()).kind).toBe("error");
  expect((await f.invoke(item("two"))).kind).toBe("error");
  expect(calls.filter((c) => c.action === "create_issue")).toHaveLength(1);
  expect(() => f.batch.finish()).toThrow(/ended/);
});
test("Native item cancellation is sticky across a later approval and model retry", async () => {
  const f = fixture();
  f.setApproval(false);
  expect((await f.invoke()).kind).toBe("cancelled");
  f.setApproval(true);
  expect((await f.invoke()).kind).toBe("error");
  expect((await f.invoke(item("two"))).kind).toBe("error");
  expect(calls).toHaveLength(0);
});
test("permission and pre-tool denial stop all remaining slots despite a later permissive retry", async () => {
  for (const kind of ["permission", "hook"]) {
    const f = fixture(),
      hooks = new HookRegistry();
    if (kind === "hook") hooks.register("pre_tool_use", () => ({ decision: "deny" }));
    const result = await f.invoke(
      item("one"),
      kind === "permission" ? [{ tool: "LinkAction", decision: "deny" }] : [],
      hooks,
    );
    expect(result.kind).toBe("executor_error");
    expect((await f.invoke()).kind).toBe("error");
    expect((await f.invoke(item("two"))).kind).toBe("error");
    expect(calls).toHaveLength(0);
  }
});
test("default single identity is permanently blocked, even in a cold ledger", () => {
  const f = fixture();
  const single = githubOperationPlan(
    f.sessionId,
    f.originIntent,
    f.connection,
    "create_issue",
    item("one"),
  );
  expect(() => f.ledger().prepare(single)).toThrow(/immutable plan/);
  const disk = JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8"));
  const anchor = Object.values(disk.records).find((r: any) => r.state === "blocked") as any;
  expect(f.ledger().claim(anchor.id).claimed).toBe(false);
  expect(() => createGithubIssueBatch(f.input)).toThrow(/already reserved/);
});
test("close without admission seals every planned item and no callback can reopen it", async () => {
  const f = fixture();
  f.batch.close();
  expect((await f.invoke()).kind).toBe("error");
  const disk = JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8"));
  expect(Object.values(disk.records).every((r: any) => r.state === "blocked" && !r.attemptId)).toBe(
    true,
  );
  expect(calls).toHaveLength(0);
});
test("native reservation cannot upgrade a prior single, verified or planned", () => {
  for (const verified of [false, true]) {
    const f = fixture();
    const freshOrigin = randomUUID();
    const ledger = f.ledger();
    const plan = githubOperationPlan(
      f.sessionId,
      freshOrigin,
      f.connection,
      "create_issue",
      item("one"),
    );
    const receipt = ledger.prepare(plan);
    if (verified) {
      const running = ledger.claim(receipt.id).receipt;
      ledger.settle(receipt.id, running.attemptId, "succeeded", { reference: { id: "1" } });
      ledger.settle(receipt.id, running.attemptId, "verified");
    }
    expect(() => createGithubIssueBatch({ ...f.input, originIntent: freshOrigin })).toThrow(
      /already reserved/,
    );
  }
});
test("reservation failure publishes neither anchor nor claimable partial slots", () => {
  const f = fixture();
  const prior = readFileSync(join(f.root, ".operations/ledger.json"), "utf8");
  let calls = 0;
  expect(() =>
    createGithubIssueBatch({
      ...f.input,
      originIntent: randomUUID(),
      assertCurrent() {
        if (++calls === 2) throw new Error("revoked");
      },
    }),
  ).toThrow("revoked");
  expect(readFileSync(join(f.root, ".operations/ledger.json"), "utf8")).toBe(prior);
});
test("manifest count, canonical byte budget, exact fields and duplicate normalized items are bounded", () => {
  expect(() => normalizeGithubIssueBatch([])).toThrow();
  expect(() =>
    normalizeGithubIssueBatch(Array.from({ length: 9 }, (_, i) => item(String(i)))),
  ).toThrow();
  expect(() => normalizeGithubIssueBatch([item("same"), item("same")])).toThrow(/Duplicate/);
  expect(() => normalizeGithubIssueBatch([{ ...item("extra"), slot: 2 }])).toThrow();
  expect(() =>
    normalizeGithubIssueBatch(
      Array.from({ length: 8 }, (_, i) => ({ ...item(String(i)), body: "\u0000".repeat(20000) })),
    ),
  ).toThrow(/bounds/);
});
test("current default Profile and explicit permission edits invalidate policy without writing migration", () => {
  const f = fixture();
  mkdirSync(join(f.root, ".code-shell"));
  const path = join(f.root, ".code-shell/settings.json");
  const before = githubIssueBatchPolicy(f.root);
  writeFileSync(
    path,
    JSON.stringify({ permissions: { rules: [{ tool: "LinkAction", decision: "deny" }] } }),
  );
  expect(githubIssueBatchPolicy(f.root)).not.toBe(before);
  writeFileSync(path, JSON.stringify({ profile: { active: "missing-synthetic-profile" } }));
  expect(() => githubIssueBatchPolicy(f.root)).toThrow(/Profile/);
  expect(readFileSync(path, "utf8")).toBe(
    JSON.stringify({ profile: { active: "missing-synthetic-profile" } }),
  );
});

// Actual Main IPC uses the same source issuer/owner reader above; only OS UI is
// replaced by a deterministic Native-answer seam. No request touches an account.
const batchClient =
  await import("../../packages/core/src/operations/desktop-batch-authority-client.js");
const { canonicalKey } = await import("../../packages/core/src/workspace/workspace-context.js");
const { allowsLinkAction, linkAuthoritySnapshot } =
  await import("../../packages/core/src/links/authority.js");
mock.module("@cjhyy/code-shell-core/internal", () => ({
  createGithubIssueBatch,
  normalizeGithubIssueBatch,
  githubIssueBatchPolicy,
  readOperationSessionOwner,
  allowsLinkAction,
  linkAuthoritySnapshot,
  canonicalKey,
  ...batchClient,
}));
const { PanelHostWindowRoutes } =
  await import("../../packages/desktop/src/main/panel-host-routing.js");
const { registerOperationBatchIpc } =
  await import("../../packages/desktop/src/main/operation-batch-ipc.js");
const { prepareAgentRunMetadata } =
  await import("../../packages/desktop/src/main/agent-run-metadata.js");
function mainFixture() {
  const f = fixture(); // Its independent origin is intentionally not this Native batch origin.
  const handlers = new Map<string, Function>();
  let enabled = true,
    trusted = true,
    revision = "r1",
    answer = 0;
  let onConfirm: () => void | Promise<void> = () => {},
    confirms = 0;
  const panelOwners = new PanelHostWindowRoutes();
  const frame = {};
  const webContents: any = { id: 100, mainFrame: frame };
  const window: any = { webContents, isDestroyed: () => false };
  const event: any = { sender: webContents, senderFrame: frame };
  let resolver: Function | undefined,
    pendingResolve: (value: unknown) => void = () => {},
    run: Record<string, unknown> | undefined,
    token: string | undefined;
  const bridge = {
    claimSessionPanelOwner: (sid: string, id: number) => panelOwners.claim(sid, id),
    panelOwnerWebContentsId: (sid: string) =>
      panelOwners.resolve(sid, [window]).ownerWebContentsId ?? undefined,
    sessionPanelOwnerRevision: (sid: string) => panelOwners.revision(sid),
    workerGeneration: () => 7,
    hasLiveWorker: () => true,
    setOperationBatchResolver: (fn: Function | undefined) => {
      resolver = fn;
    },
    requestOperationBatchRun: (
      params: Record<string, unknown>,
      secret: string,
      check: () => void,
    ) => {
      check();
      run = params;
      token = secret;
      return new Promise((resolve) => (pendingResolve = resolve));
    },
  };
  const dispose = registerOperationBatchIpc({
    ipc: {
      handle: (name: string, fn: Function) => handlers.set(name, fn),
      removeHandler: (name: string) => {
        handlers.delete(name);
      },
    } as any,
    windows: () => [window],
    enabled: () => enabled,
    root: f.root,
    bridge: () => bridge as any,
    resolveTarget: async () => ({
      kind: "session",
      projectId: "fixture-project",
      mainRootId: "root1",
      sessionId: f.sessionId,
      cwd: f.root,
    }),
    trusted: async () => trusted,
    trustedSync: () => trusted,
    authorityRevision: () => revision,
    isSessionRunning: () => false,
    connections: () => [f.connection],
    confirm: async (_window, options) => {
      expect(options.defaultId).toBe(0);
      expect(options.cancelId).toBe(0);
      confirms++;
      await onConfirm();
      return { response: answer };
    },
  });
  const start = () =>
    handlers.get("operationBatch:start")!(event, {
      sessionId: f.sessionId,
      connectionId: f.connection.id,
      items: [item("one"), item("two")],
    });
  const activate = (runId = "actual-main-run") => {
    const path = join(f.root, f.sessionId, "state.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(state, { status: "active", runId });
    writeFileSync(path, JSON.stringify(state));
    return {
      sessionId: f.sessionId,
      runId,
      originIntent: run!.clientMessageId,
      token,
      connectionId: f.connection.id,
      parameters: item("one"),
      phase: "resolve",
    };
  };
  return {
    ...f,
    dispose,
    start,
    activate,
    resolve: (input: any, generation = 7) => resolver!(input, generation),
    getRun: () => run,
    getToken: () => token,
    finishRun: () => pendingResolve({ status: "result" }),
    setAnswer: (value: number) => {
      answer = value;
    },
    changeTrust: () => {
      trusted = false;
    },
    changeFlag: () => {
      enabled = false;
    },
    changeRegistry: () => {
      revision = "r2";
    },
    duringConfirm: (fn: () => void | Promise<void>) => {
      onConfirm = fn;
    },
    confirmations: () => confirms,
    transferOwner: (id: number) => panelOwners.claim(f.sessionId, id),
    forgetOwner: () => panelOwners.forgetSession(f.sessionId),
    event,
  };
}
test("Main Native default cancellation leaves ledger byte-identical and starts no Run", async () => {
  const f = mainFixture();
  const before = readFileSync(join(f.root, ".operations/ledger.json"), "utf8");
  expect(await f.start()).toEqual({ status: "cancelled" });
  expect(f.getRun()).toBeUndefined();
  expect(readFileSync(join(f.root, ".operations/ledger.json"), "utf8")).toBe(before);
  await f.dispose();
});
test("Main atomically admits only one pending confirmation per Session", async () => {
  const f = mainFixture();
  let release: () => void = () => {},
    entered: () => void = () => {};
  const ready = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  f.duringConfirm(() => {
    entered();
    return gate;
  });
  const first = f.start();
  await ready;
  await expect(f.start()).rejects.toThrow(/pending|Stop the Session/);
  expect(f.confirmations()).toBe(1);
  release();
  expect(await first).toEqual({ status: "cancelled" });
  await f.dispose();
});
test("Main owner handoff and ABA cannot restore a batch permit", async () => {
  for (const aba of [false, true]) {
    const f = mainFixture();
    f.setAnswer(1);
    await f.start();
    const input = f.activate();
    await f.resolve(input);
    f.transferOwner(200);
    if (aba) f.transferOwner(100);
    await expect(f.resolve(input)).rejects.toThrow(/authority changed/);
    f.transferOwner(100);
    await expect(f.resolve(input)).rejects.toThrow(/absent|ended/);
    expect(calls).toHaveLength(0);
    f.finishRun();
    await f.dispose();
  }
});
test("Native pending confirmation cannot revive through none-other-forget ABA", async () => {
  const f = mainFixture();
  f.setAnswer(1);
  f.duringConfirm(() => {
    f.transferOwner(200);
    f.forgetOwner();
  });
  await expect(f.start()).rejects.toThrow(/authority changed/);
  expect(f.getRun()).toBeUndefined();
  expect(calls).toHaveLength(0);
  await f.dispose();
});
test("Main rechecks project/trust/flag after Native answer before minting permit", async () => {
  for (const change of ["changeTrust", "changeFlag", "changeRegistry"] as const) {
    const f = mainFixture();
    f.setAnswer(1);
    f.duringConfirm(f[change]);
    await expect(f.start()).rejects.toThrow();
    expect(f.getRun()).toBeUndefined();
    await f.dispose();
  }
});
test("Main nonce binds one actual Run/worker; visible origin without nonce cannot consume it", async () => {
  const f = mainFixture();
  f.setAnswer(1);
  expect(await f.start()).toEqual({ status: "started", count: 2 });
  const input = f.activate();
  await expect(f.resolve({ ...input, token: undefined })).rejects.toThrow(/admission/);
  expect(await f.resolve(input)).toMatchObject({ kind: "batch", index: 0, count: 2 });
  await expect(f.resolve({ ...input, runId: "other-run" })).rejects.toThrow(/actual active Run/);
  await expect(f.resolve(input)).rejects.toThrow(/absent|ended/);
  f.finishRun();
  await f.dispose();
});
test("Main Profile/default policy drift seals remaining slots and cannot revive", async () => {
  const f = mainFixture();
  f.setAnswer(1);
  await f.start();
  const input = f.activate();
  await f.resolve(input);
  mkdirSync(join(f.root, ".code-shell"));
  const path = join(f.root, ".code-shell/settings.json");
  writeFileSync(
    path,
    JSON.stringify({ permissions: { rules: [{ tool: "LinkAction", decision: "deny" }] } }),
  );
  await expect(f.resolve(input)).rejects.toThrow(/authority changed/);
  rmSync(path);
  await expect(f.resolve(input)).rejects.toThrow(/absent|ended/);
  f.finishRun();
  await f.dispose();
});
test("private response namespace and Run token are rejected on renderer and remote preparation", () => {
  const deps = { isProjectTrusted: () => true, isNoRepoCwd: () => true };
  for (const origin of ["renderer", "mobile", "serve"] as const) {
    for (const value of [
      { id: "operation-batch-authority-guessed", result: { kind: "batch" } },
      { id: 5, method: "desktop/operationBatch", params: {} },
    ])
      expect(() =>
        prepareAgentRunMetadata(JSON.stringify(value), { origin, producer: "fixture" }, deps),
      ).toThrow(/private Host channel/);
    expect(() =>
      prepareAgentRunMetadata(
        JSON.stringify({
          id: "known",
          method: "agent/run",
          params: { sessionId: "x", cwd: "/x", operationBatchToken: randomUUID() },
        }),
        { origin, producer: "fixture" },
        { ...deps, isTrustedOperationBatchRequest: () => true },
      ),
    ).toThrow(/private Native admission/);
  }
  const line = JSON.stringify({
    id: "trusted",
    method: "agent/run",
    params: { sessionId: "x", cwd: "/x", operationBatchToken: randomUUID() },
  });
  expect(() =>
    prepareAgentRunMetadata(line, { origin: "host", producer: "fixture" }, deps),
  ).toThrow(/private Native admission/);
  expect(
    JSON.parse(
      prepareAgentRunMetadata(
        line,
        { origin: "host", producer: "fixture" },
        { ...deps, isTrustedOperationBatchRequest: (id) => id === "trusted" },
      ).outLine,
    ).params.operationBatchToken,
  ).toBeDefined();
});

const { Engine } = await import("../../packages/core/src/engine/engine.js");
const { EngineRuntime } = await import("../../packages/core/src/engine/runtime.js");
const { ModelPool } = await import("../../packages/core/src/llm/model-pool.js");
const { SettingsManager } = await import("../../packages/core/src/settings/manager.js");
const { MCPManager } = await import("../../packages/core/src/tool-system/mcp-manager.js");
const { CostTracker } = await import("../../packages/core/src/cost-tracker.js");
const { LLMClientBase } = await import("../../packages/core/src/llm/client-base.js");
const { registerProvider } = await import("../../packages/core/src/llm/client-factory.js");
let mainCalls = 0,
  plannedItems = 2,
  retryFirst = false;
class BatchLocalClient extends LLMClientBase {
  protected initClient() {}
  async createMessage(options: any) {
    const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
    this.recordUsage(usage, options);
    const step = mainCalls++;
    return {
      text: "Synthetic fixture response",
      stopReason: step < plannedItems ? "tool_use" : "stop",
      usage,
      toolCalls:
        step < plannedItems
          ? [
              {
                id: `model-${step}`,
                toolName: "LinkAction",
                args: {
                  provider: "github",
                  action: "create_issue",
                  connectionId: "fixture-link",
                  params: item(step === 0 || (retryFirst && step === 1) ? "one" : "two"),
                },
              },
            ]
          : [],
    };
  }
}
registerProvider("batch-local-fixture", BatchLocalClient);
async function engineFixture(
  mode = "default",
  count = 2,
  hasToken = true,
  failure?: "native" | "permission" | "hook" | "approval",
) {
  mainCalls = 0;
  plannedItems = count;
  retryFirst = Boolean(failure);
  const g = mainFixture();
  mkdirSync(join(g.root, ".code-shell"));
  writeFileSync(
    join(g.root, ".code-shell/settings.json"),
    JSON.stringify({
      permissions: {
        rules: [
          {
            tool: "LinkAction",
            decision: failure === "permission" ? "deny" : failure === "approval" ? "ask" : "allow",
          },
        ],
      },
    }),
  );
  g.setAnswer(1);
  await g.start();
  const registry = new ToolRegistry({ builtinTools: ["LinkAction"] });
  const runtime = new EngineRuntime({
    modelPool: new ModelPool(),
    toolRegistry: registry,
    settings: new SettingsManager(g.root, "full"),
    mcpPool: new MCPManager(registry),
    costTracker: new CostTracker(),
  });
  const request = g.getRun()!;
  const signals: any[] = [];
  let asks = 0,
    rpcCalls = 0;
  const engine = new Engine({
    llm: { provider: "batch-local-fixture", model: "batch-local-fixture", apiKey: "synthetic" },
    cwd: g.root,
    runtime,
    settingsScope: "full",
    sessionStorageDir: g.root,
    isSubAgent: true,
    permissionMode: mode as any,
    enabledBuiltinTools: ["LinkAction"],
    maxTurns: 5,
    askUser: async () => (failure === "native" && asks++ === 0 ? "取消" : "允许执行"),
    ...(failure === "hook"
      ? {
          hooks: [
            { event: "pre_tool_use" as const, handler: () => ({ decision: "deny" as const }) },
          ],
        }
      : {}),
    approvalBackend: { requestApproval: async () => ({ approved: failure !== "approval" }) },
    operationBatchAuthority: async (input) => {
      rpcCalls++;
      return g.resolve(input);
    },
    behaviorProfiles: [
      {
        id: "quiet",
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableMcp: true,
        disableSessionTitle: true,
      },
    ],
  });
  try {
    const result = await engine.run(String(request.task), {
      sessionId: g.sessionId,
      clientMessageId: String(request.clientMessageId),
      ...(hasToken ? { operationBatchToken: g.getToken() } : {}),
      behaviorMode: "quiet",
      onStream: (event) => signals.push(event),
    });
    if (failure)
      console.log(
        "Batch failure actual",
        JSON.stringify({
          failure,
          reason: result.reason,
          mainCalls,
          posts: calls.filter((c) => c.action === "create_issue").length,
        }),
      );
    return {
      result,
      signals,
      rpcCalls,
      disk: JSON.parse(readFileSync(join(g.root, g.sessionId, "state.json"), "utf8")),
      mainCalls,
      posts: calls.filter((c) => c.action === "create_issue").length,
    };
  } finally {
    g.finishRun();
    await g.dispose();
    await runtime.close();
  }
}
test("actual Engine normal Run consumes Main-issued fixed slots and persists verified completion", async () => {
  const actual = await engineFixture();
  expect(actual.result.reason).toBe("completed");
  expect(actual.posts).toBe(2);
  expect(actual.disk.status).toBe("completed");
});
test("actual Engine completing only the first item persists batch_incomplete, never completed", async () => {
  const actual = await engineFixture("default", 1);
  expect(actual.result.reason).toBe("batch_incomplete");
  expect(actual.posts).toBe(1);
  expect(actual.disk.status).toBe("batch_incomplete");
  expect(actual.result.text).toContain("剩余项目已停止");
});
test("actual Engine plan mode cannot be upgraded by Native batch approval", async () => {
  const actual = await engineFixture("plan");
  expect(actual.result.reason).toBe("batch_incomplete");
  expect(actual.mainCalls).toBe(0);
  expect(actual.posts).toBe(0);
});

test("actual Engine Native item cancellation stays closed across same-item model retry", async () => {
  const actual = await engineFixture("default", 3, true, "native");
  expect(actual.mainCalls).toBeGreaterThanOrEqual(4);
  expect(actual.mainCalls).toBeLessThanOrEqual(5);
  expect(actual.posts).toBe(0);
  expect(actual.result.reason).toBe("batch_incomplete");
  expect(actual.disk.status).toBe("batch_incomplete");
});
for (const failure of ["permission", "hook", "approval"] as const)
  test(`actual Engine ${failure} denial cannot be retried into batch writes`, async () => {
    const actual = await engineFixture("default", 3, true, failure);
    expect(actual.mainCalls).toBeGreaterThanOrEqual(4);
    expect(actual.mainCalls).toBeLessThanOrEqual(5);
    expect(actual.posts).toBe(0);
    expect(actual.result.reason).toBe("batch_incomplete");
    expect(actual.disk.status).toBe("batch_incomplete");
  });
test("ordinary Run with the visible batch origin but no private nonce makes no batch RPC or write", async () => {
  const actual = await engineFixture("default", 2, false);
  expect(actual.mainCalls).toBeGreaterThan(0);
  expect(actual.posts).toBe(0);
  expect(actual.rpcCalls).toBe(0);
});
