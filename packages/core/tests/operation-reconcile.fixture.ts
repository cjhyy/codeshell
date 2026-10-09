import { afterAll, afterEach, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http, { createServer } from "node:http";
import https from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Install confinement before loading Core. Only this synthetic HTTP origin can
// receive requests; no operator HOME, token, account, model or provider is used.
let route: (action: string, params: Record<string, unknown>) => unknown = () => ({});
const calls: Array<{ method: string; action: string; params: Record<string, unknown> }> = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, "http://fixture");
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  const params = JSON.parse(text || url.searchParams.get("params") || "{}");
  const action = url.pathname.slice(1);
  calls.push({ method: request.method!, action, params });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(route(action, params)));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const { installLocalNetworkGuard } =
  await import("../../../scripts/runtime-cost-smoke-isolation.mjs");
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
assert.ok(process.env.CODESHELL_OPERATION_READ_RECEIPT);
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
const allowedResponse = await new Promise<string>((resolve, reject) => {
  controlledHttp
    .get(`${origin}/_transport_probe`, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    })
    .on("error", reject);
});
assert.equal(allowedResponse, "{}");
assert.deepEqual(calls, [{ method: "GET", action: "_transport_probe", params: {} }]);
calls.length = 0;
writeFileSync(
  process.env.CODESHELL_OPERATION_READ_RECEIPT!,
  JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    version: process.version,
    bun: process.versions.bun,
    executable: realpathSync(process.execPath),
    executableSha256: createHash("sha256")
      .update(readFileSync(realpathSync(process.execPath)))
      .digest("hex"),
    home,
    origin,
    negativeProbes: negativeProbeNames.length,
    negativeProbeNames,
    confinement: "Bun JavaScript fetch/http/https exits; not an OS or native network sandbox",
    preservesBuiltinExports: true,
    allowedHttpProbe: true,
    beforeCoreImport: true,
    fixtureSha256: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
  }),
  { mode: 0o600 },
);
const { OperationLedger } = await import("../src/operations/ledger.js");
const { OperationController } = await import("../src/operations/controller.js");
const { CapabilityResolver } = await import("../src/operations/resolver.js");
const { UsageLedger } = await import("../src/cost-ledger/store.js");
const { readOperationSessionOwner } = await import("../src/operations/session-owner.js");
const { createLinkOperationReviewStore } = await import("../src/links/operation-review.js");
const { setDefaultCredentialAccess } = await import("../src/credentials/access.js");
const { ToolRegistry } = await import("../src/tool-system/registry.js");
const { ToolExecutor } = await import("../src/tool-system/executor.js");
const { PermissionClassifier } = await import("../src/tool-system/permission.js");
const { HookRegistry } = await import("../src/hooks/registry.js");
const { createGithubOperationReader } = await import("../src/links/operation-reader.js");
const { githubRecoveryInput } = await import("../src/links/operation-recovery.js");
const { githubCreateIssueParameters } = await import("../src/links/verified-write.js");
const roots: string[] = [];
afterEach(() => {
  setDefaultCredentialAccess(null);
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  calls.length = 0;
});
afterAll(() => server.close());

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "link-operation-read-"));
  roots.push(root);
  const sessionId = "read-session";
  const directory = join(root, sessionId);
  mkdirSync(directory);
  const state = {
    sessionId,
    cwd: root,
    startedAt: Date.now(),
    status: "unverified_write",
    stateRevision: 3,
    runId: "original-run",
    costState: new UsageLedger({ storageDir: join(root, ".usage-ledger") }).sessionState(
      sessionId,
      root,
    ),
  };
  const save = () => writeFileSync(join(directory, "state.json"), JSON.stringify(state));
  save();
  const credential = {
    id: "original-connection",
    type: "oauth" as const,
    label: "Synthetic",
    hasSecret: true,
    oauthStatus: { state: "valid" as const, hasRefreshToken: true, canRefresh: true },
    meta: {
      linkProvider: "github",
      linkAccountId: "42",
      linkExecutionRuntime: "server" as const,
      linkExecutionBackend: "remote" as const,
      linkRemoteState: "connected" as const,
      linkRemoteGrantId: "original-grant",
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      linkCapabilityIds: [
        "github.get_repository",
        "github.get_starred",
        "github.set_starred",
        "github.get_issue",
        "github.list_issues",
        "github.create_issue",
        "github.update_issue",
      ],
    },
  };
  const data = {
    repositoryId: 123,
    issueId: 456,
    current: false,
    lose: false,
    wrongIssue: false,
    wrongUrl: false,
    accountEnabled: true,
    globalOnly: false,
    scopes: [] as string[],
    onRead: () => {},
  };
  let reviewing = false;
  route = (action, params) => {
    if (reviewing) data.onRead();
    if (action === "get_repository") return { id: data.repositoryId, full_name: "acme/repo" };
    if (action === "get_starred") return { starred: reviewing ? data.current : false };
    if (action === "list_issues") return { issues: [] };
    if (action === "create_issue") return { number: 7, title: "PRIVATE_TITLE", state: "open" };
    if (action === "get_issue")
      return {
        id: data.wrongIssue ? 999 : data.issueId,
        number: 7,
        url: `https://api.github.com/repos/${data.wrongUrl ? "other" : "acme"}/repo/issues/7`,
        repository_url: "https://api.github.com/repos/acme/repo",
        title: reviewing ? "PRIVATE_TITLE" : "original-mismatch",
        body: "PRIVATE_BODY",
        state: reviewing && data.current ? "closed" : "open",
      };
    if (action === "set_starred" || action === "update_issue") return params;
    throw new Error("Unexpected synthetic action");
  };
  setDefaultCredentialAccess({
    listMasked: () => (data.accountEnabled ? [credential] : []),
    resolveMeta: (_cwd, id, scope) => {
      data.scopes.push(scope);
      return data.accountEnabled && id === credential.id && (!data.globalOnly || scope === "full")
        ? credential
        : undefined;
    },
    envExposures: () => ({}),
    resolveValue: async () => {
      throw new Error("No raw token access");
    },
    executeRemoteLinkAction: async ({ action, params }) => {
      const write = ["create_issue", "set_starred", "update_issue"].includes(action);
      const response = await fetch(
        `${origin}/${action}${write ? "" : `?params=${encodeURIComponent(JSON.stringify(params))}`}`,
        {
          method: write ? "POST" : "GET",
          ...(write ? { body: JSON.stringify(params) } : {}),
        },
      );
      const result = await response.json();
      if (write && data.lose) throw new Error("Synthetic consumed response lost");
      return result;
    },
  });
  const ledger = () =>
    new OperationLedger(root, undefined, {
      sessionId,
      read: () => readOperationSessionOwner(root, sessionId),
    });
  const store = () => createLinkOperationReviewStore(root);
  const original = async (
    action: "create_issue" | "set_starred" | "update_issue",
    parameterOverrides: Record<string, unknown> = {},
  ) => {
    const own = ledger();
    const executor = new ToolExecutor(
      new ToolRegistry({ builtinTools: ["LinkAction"] }),
      new PermissionClassifier([{ tool: "LinkAction", decision: "allow" }]),
      new HookRegistry(),
    );
    executor.setContext({
      cwd: root,
      sessionId,
      settingsScope: "project",
      planMode: false,
      permissionMode: "default",
      signal: new AbortController().signal,
      originClientMessageId: "trusted-original",
      askUser: async () => "允许执行",
      operations: {
        sessionId,
        runId: "original-run",
        controller: new OperationController(own),
        resolver: new CapabilityResolver(),
      },
    } as any);
    const params = {
      owner: "acme",
      repo: "repo",
      ...(action === "set_starred"
        ? { starred: true }
        : action === "update_issue"
          ? { issue_number: 7, state: "closed" }
          : { title: "PRIVATE_TITLE", body: "PRIVATE_BODY" }),
      ...parameterOverrides,
    };
    const output = await executor.executeSingle({
      id: "original-tool",
      toolName: "LinkAction",
      args: { provider: "github", action, connectionId: credential.id, params },
    });
    const result = JSON.parse(output.result as string);
    expect(result.kind).toBe("unverified_write");
    own.sealForFinalization(sessionId);
    reviewing = true;
    return result;
  };
  const review = () => store().review(sessionId);
  const reconcile = async (snapshot = review()) => {
    const record = snapshot.records[0];
    return store().reconcile(sessionId, snapshot.owner, record.id, record.revision, {
      cwd: root,
      settingsScope: "full",
      assertCurrent: () => {},
      approveRead: async () => true,
    });
  };
  return {
    root,
    directory,
    sessionId,
    state,
    save,
    credential,
    data,
    ledger,
    original,
    review,
    reconcile,
  };
}

test.each(["create_issue", "set_starred", "update_issue"] as const)(
  "%s cold read observes exact immutable target, sends zero writes and never rewrites history",
  async (action) => {
    const f = fixture();
    await f.original(action);
    f.data.current = action !== "create_issue";
    const before = JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8"));
    const stateBefore = readFileSync(join(f.directory, "state.json"), "utf8");
    const count = calls.length;
    const observation = await f.reconcile();
    expect(observation.result).toBe("matches_current");
    expect(calls.slice(count).map((call) => call.method)).toEqual(
      action === "create_issue" ? ["GET"] : ["GET", "GET"],
    );
    expect(
      calls
        .slice(count)
        .every((call) => call.params.owner === "acme" && call.params.repo === "repo"),
    ).toBe(true);
    const after = JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8"));
    expect(after.records).toEqual(before.records);
    expect(readFileSync(join(f.directory, "state.json"), "utf8")).toBe(stateBefore);
    expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
    expect(f.review().records[0].observation).toEqual(observation);
    expect(JSON.stringify(f.review().records)).not.toMatch(
      /PRIVATE_BODY|PRIVATE_TITLE|original-grant|original-connection/,
    );
  },
);

test("pre-send immutable identity recovers a lost Star response; replacement and changed desired state never prove a match", async () => {
  const f = fixture();
  f.data.lose = true;
  await f.original("set_starred");
  expect(f.review().records[0].hasReference).toBe(false);
  expect((await f.reconcile()).result).toBe("differs_current");
  f.data.repositoryId = 999;
  const count = calls.length;
  expect((await f.reconcile()).result).toBe("identity_changed");
  expect(calls.slice(count).map((call) => call.action)).toEqual(["get_repository"]);
});

test("missing original create identity performs no reads and preserves the manual path", async () => {
  const f = fixture();
  f.data.lose = true;
  await f.original("create_issue");
  const count = calls.length;
  expect((await f.reconcile()).result).toBe("unavailable");
  expect(calls.length).toBe(count);
  expect(f.review().records[0].canResolve).toBe(true);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
});

test.each(["set_starred", "update_issue", "create_issue"] as const)(
  "proven legacy %s uses the exact typed intent/plan; number-only create remains manual",
  async (action) => {
    const f = fixture();
    const output = await f.original(action);
    const file = join(f.root, ".operations/ledger.json");
    const ledger = JSON.parse(readFileSync(file, "utf8"));
    const receipt = ledger.records[output.operation.id];
    delete receipt.recovery;
    delete receipt.ownerIncarnation;
    writeFileSync(file, JSON.stringify(ledger));
    const params: Record<string, unknown> = {
      owner: "acme",
      repo: "repo",
      ...(action === "set_starred"
        ? { starred: true }
        : action === "update_issue"
          ? { issue_number: 7, state: "closed" }
          : { title: "PRIVATE_TITLE", body: "PRIVATE_BODY" }),
    };
    const events = [
      { type: "session_meta", data: { sessionId: f.sessionId, startedAt: f.state.startedAt } },
      {
        type: "message",
        data: {
          role: "user",
          clientMessageId: "trusted-original",
          content: "original user intent",
        },
      },
      {
        type: "tool_use",
        data: {
          toolName: "LinkAction",
          toolCallId: "original",
          args: { provider: "github", action, connectionId: f.credential.id, params },
        },
      },
      {
        type: "tool_result",
        data: { toolName: "LinkAction", toolCallId: "original", result: JSON.stringify(output) },
      },
      {
        type: "run_result",
        data: { clientMessageId: "trusted-original", result: { reason: "unverified_write" } },
      },
    ];
    writeFileSync(
      join(f.directory, "transcript.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    f.data.current = true;
    const count = calls.length;
    expect((await f.reconcile()).result).toBe(
      action === "create_issue" ? "unavailable" : "matches_current",
    );
    expect(calls.length - count).toBe(action === "create_issue" ? 0 : 2);
    // Changed tool arguments cannot borrow an otherwise matching typed receipt.
    params.repo = "other";
    writeFileSync(
      join(f.directory, "transcript.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    const before = calls.length;
    expect((await f.reconcile()).result).toBe("unavailable");
    expect(calls.length).toBe(before);
  },
);

test.each(["account", "grant", "capabilities"])(
  "changed %s sends no read and cannot reuse the saved authority",
  async (change) => {
    const f = fixture();
    await f.original("update_issue");
    if (change === "account") f.credential.meta.linkAccountId = "other";
    if (change === "grant") f.credential.meta.linkRemoteGrantId = "other";
    if (change === "capabilities") f.credential.meta.linkCapabilityIds = ["github.get_issue"];
    const count = calls.length;
    expect((await f.reconcile()).result).toBe("unavailable");
    expect(calls.length).toBe(count);
  },
);

test("revocation and Session restart during provider await cannot publish an observation", async () => {
  for (const change of ["account", "run", "incarnation"]) {
    const f = fixture();
    await f.original("set_starred");
    const snapshot = f.review();
    f.data.onRead = () => {
      if (change === "account") f.data.accountEnabled = false;
      else {
        f.state.stateRevision++;
        f.state.runId = "new-run";
        if (change === "incarnation") f.state.startedAt++;
        f.save();
      }
    };
    await expect(f.reconcile(snapshot)).rejects.toThrow();
    const saved = JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8"));
    expect(saved.observations).toBeUndefined();
  }
});

test("real current user deny/builtin off and hook input changes stop the pinned reader before HTTP", async () => {
  const f = fixture();
  mkdirSync(join(f.root, ".code-shell"));
  for (const settings of [
    { permissions: { rules: [{ tool: "LinkAction", decision: "deny" }] } },
    { capabilityOverrides: { builtin: { LinkAction: "off" } } },
  ]) {
    writeFileSync(join(f.root, ".code-shell/settings.json"), JSON.stringify(settings));
    const reader = createGithubOperationReader({
      cwd: f.root,
      sessionId: f.sessionId,
      settingsScope: "project",
      assertAuthorized: () => {},
      approveRead: async () => true,
      signal: new AbortController().signal,
    });
    await expect(
      reader.read("get_repository", f.credential.id, { owner: "acme", repo: "repo" }),
    ).rejects.toThrow();
  }
  writeFileSync(join(f.root, ".code-shell/settings.json"), "{}");
  const hooks = new HookRegistry();
  hooks.register("pre_tool_use", () => ({
    updatedInput: {
      provider: "github",
      action: "set_starred",
      connectionId: "other",
      params: { owner: "other", repo: "other", starred: true },
    },
  }));
  const reader = createGithubOperationReader({
    cwd: f.root,
    sessionId: f.sessionId,
    settingsScope: "project",
    hooks,
    assertAuthorized: () => {},
    approveRead: async () => true,
    signal: new AbortController().signal,
  });
  await expect(
    reader.read("get_repository", f.credential.id, { owner: "acme", repo: "repo" }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test.each(["汉".repeat(20_000), `x${"\u0001".repeat(19_999)}`])(
  "maximum legal create body survives the real write and cold exact-plan proof",
  async (body) => {
    const f = fixture();
    await f.original("create_issue", { body });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.find((call) => call.method === "POST")!.params.body).toBe(body);
    const count = calls.length;
    // A wrong current body is a comparison result, proving the exact saved
    // private plan was recovered and authenticated after reopening the store.
    expect((await f.reconcile()).result).toBe("differs_current");
    expect(calls.slice(count).map((call) => call.action)).toEqual(["get_issue"]);
    expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
  },
);

test("omitted original settings scope captures the actual full credential default", () => {
  const f = fixture();
  expect(githubRecoveryInput({} as any, f.credential, null).policy.settingsScope).toBe("full");
});

test("create body still rejects more than the existing 20,000-character limit", () => {
  expect(() =>
    githubCreateIssueParameters({
      owner: "acme",
      repo: "repo",
      title: "title",
      body: "汉".repeat(20_001),
    }),
  ).toThrow("too long");
});

test("legacy missing scope cannot borrow a global-only credential", async () => {
  const f = fixture();
  const output = await f.original("set_starred");
  const file = join(f.root, ".operations/ledger.json");
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  delete Object.values(ledger.records as Record<string, any>)[0].recovery;
  writeFileSync(file, JSON.stringify(ledger));
  writeFileSync(
    join(f.directory, "transcript.jsonl"),
    [
      { type: "session_meta", data: { sessionId: f.sessionId, startedAt: f.state.startedAt } },
      { type: "message", data: { role: "user", clientMessageId: "trusted-original" } },
      {
        type: "tool_use",
        data: {
          toolName: "LinkAction",
          toolCallId: "original",
          args: {
            provider: "github",
            action: "set_starred",
            connectionId: f.credential.id,
            params: { owner: "acme", repo: "repo", starred: true },
          },
        },
      },
      {
        type: "tool_result",
        data: { toolName: "LinkAction", toolCallId: "original", result: JSON.stringify(output) },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  f.data.globalOnly = true;
  f.data.scopes.length = 0;
  const count = calls.length;
  expect((await f.reconcile()).result).toBe("unavailable");
  expect(calls.length).toBe(count);
  expect(f.data.scopes.length).toBeGreaterThan(0);
  expect(f.data.scopes.every((scope) => scope === "project")).toBe(true);
});

test("Host global deny remains effective when original credential scope is project", async () => {
  const f = fixture();
  await f.original("set_starred");
  const oldHome = process.env.HOME;
  const home = join(f.root, "host-home");
  mkdirSync(join(home, ".code-shell"), { recursive: true });
  writeFileSync(
    join(home, ".code-shell/settings.json"),
    JSON.stringify({ permissions: { rules: [{ tool: "LinkAction", decision: "deny" }] } }),
  );
  process.env.HOME = home;
  try {
    const count = calls.length;
    expect((await f.reconcile()).result).toBe("permission_denied");
    expect(calls.length).toBe(count);
    expect(f.data.scopes.at(-1)).toBe("project");
  } finally {
    process.env.HOME = oldHome;
  }
});

test("enabled configured settings and plugin hooks fail closed without executing commands", async () => {
  const f = fixture();
  const settings = join(f.root, ".code-shell/settings.json");
  mkdirSync(join(f.root, ".code-shell"));
  const options = {
    cwd: f.root,
    sessionId: f.sessionId,
    settingsScope: "project" as const,
    assertAuthorized: () => {},
    approveRead: async () => true,
    signal: new AbortController().signal,
  };
  writeFileSync(
    settings,
    JSON.stringify({ hooks: [{ event: "pre_tool_use", command: "must-not-run" }] }),
  );
  expect(() => createGithubOperationReader(options)).toThrow("Operation read unavailable");
  writeFileSync(settings, "{}");
  const oldHome = process.env.HOME;
  const home = join(f.root, "hook-home");
  const installPath = join(home, "plugin");
  mkdirSync(join(installPath, "hooks"), { recursive: true });
  writeFileSync(
    join(installPath, "hooks/hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "must-not-run" }] }],
      },
    }),
  );
  mkdirSync(join(home, ".code-shell/plugins"), { recursive: true });
  writeFileSync(
    join(home, ".code-shell/plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "synthetic@fixture": [
          {
            scope: "user",
            installPath,
            version: "1",
            installedAt: "2026-10-09",
            lastUpdated: "2026-10-09",
          },
        ],
      },
    }),
  );
  process.env.HOME = home;
  try {
    expect(() => createGithubOperationReader(options)).toThrow("Operation read unavailable");
    writeFileSync(settings, JSON.stringify({ disabledPlugins: ["synthetic"] }));
    const reader = createGithubOperationReader(options);
    await reader.read("get_repository", f.credential.id, { owner: "acme", repo: "repo" });
    expect(calls.map((call) => call.action)).toEqual(["get_repository"]);
  } finally {
    process.env.HOME = oldHome;
  }
});

test("unrelated lifecycle or nonmatching tool hooks do not block fixed reads", async () => {
  const f = fixture();
  mkdirSync(join(f.root, ".code-shell"));
  writeFileSync(
    join(f.root, ".code-shell/settings.json"),
    JSON.stringify({
      hooks: [
        { event: "on_session_start", command: "must-not-run" },
        { event: "on_session_end", command: "must-not-run" },
        { event: "pre_tool_use", matcher: "^Write$", command: "must-not-run" },
      ],
    }),
  );
  const reader = createGithubOperationReader({
    cwd: f.root,
    sessionId: f.sessionId,
    settingsScope: "project",
    assertAuthorized: () => {},
    approveRead: async () => true,
    signal: new AbortController().signal,
  });
  await reader.read("get_repository", f.credential.id, { owner: "acme", repo: "repo" });
  expect(calls.map((call) => call.action)).toEqual(["get_repository"]);
});

test("related configured hooks record a distinct zero-read unavailable observation and keep manual review", async () => {
  const f = fixture();
  await f.original("set_starred");
  mkdirSync(join(f.root, ".code-shell"));
  writeFileSync(
    join(f.root, ".code-shell/settings.json"),
    JSON.stringify({ hooks: [{ event: "on_permission_check", command: "must-not-run" }] }),
  );
  const count = calls.length;
  expect((await f.reconcile()).result).toBe("hooks_unavailable");
  expect(calls.length).toBe(count);
  expect(f.review().records[0].canResolve).toBe(true);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
});

test.each(["issue", "url"])("changed immutable %s prevents a current-state match", async (kind) => {
  const f = fixture();
  await f.original("update_issue");
  f.data.current = true;
  if (kind === "issue") f.data.wrongIssue = true;
  else f.data.wrongUrl = true;
  const count = calls.length;
  expect((await f.reconcile()).result).toBe("identity_changed");
  expect(calls.slice(count).map((call) => call.action)).toEqual(["get_repository", "get_issue"]);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
});

test("missing pinned Profile and policy change during HTTP fail closed before publishing", async () => {
  for (const kind of ["profile", "policy"]) {
    const f = fixture();
    await f.original("set_starred");
    if (kind === "profile") {
      (f.state as any).workspaceProfile = "missing-pinned-profile";
      f.save();
    } else {
      mkdirSync(join(f.root, ".code-shell"));
      f.data.onRead = () =>
        writeFileSync(
          join(f.root, ".code-shell/settings.json"),
          JSON.stringify({ permissions: { rules: [{ tool: "LinkAction", decision: "deny" }] } }),
        );
    }
    const count = calls.length;
    await expect(f.reconcile()).rejects.toThrow();
    expect(calls.length - count).toBe(kind === "profile" ? 0 : 1);
    expect(
      JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8")).observations,
    ).toBeUndefined();
  }
});

test("independent observation history is bounded before another provider request", async () => {
  const f = fixture();
  await f.original("set_starred");
  const original = JSON.parse(
    readFileSync(join(f.root, ".operations/ledger.json"), "utf8"),
  ).records;
  for (let index = 0; index < 20; index++) await f.reconcile();
  const count = calls.length;
  await expect(f.reconcile()).rejects.toThrow("history is full");
  expect(calls.length).toBe(count);
  expect(JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8")).records).toEqual(
    original,
  );
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
});

test("concurrent observations serialize without changing the original receipt", async () => {
  const f = fixture();
  await f.original("set_starred");
  const snapshot = f.review();
  const before = JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8"));
  const observations = await Promise.all([f.reconcile(snapshot), f.reconcile(snapshot)]);
  expect(new Set(observations.map((observation) => observation.id)).size).toBe(2);
  const after = JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8"));
  expect(after.records).toEqual(before.records);
  expect(after.observations[snapshot.records[0].id]).toHaveLength(2);
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(true);
});

test("manual resolution during HTTP invalidates a late observation without changing its decision", async () => {
  const f = fixture();
  await f.original("set_starred");
  const snapshot = f.review();
  const record = snapshot.records[0];
  f.data.onRead = () => {
    f.data.onRead = () => {};
    createLinkOperationReviewStore(f.root).resolve(
      f.sessionId,
      snapshot.owner,
      record.id,
      record.revision,
      () => {},
    );
  };
  await expect(f.reconcile(snapshot)).rejects.toThrow("stale");
  const after = JSON.parse(readFileSync(join(f.root, ".operations/ledger.json"), "utf8"));
  expect(after.observations).toBeUndefined();
  expect(after.records[record.id].operatorResolution.decision).toBe("accept_uncertainty");
  expect(after.records[record.id].state).toBe("unknown");
  expect(f.ledger().hasUnverifiedWrites(f.sessionId)).toBe(false);
});
