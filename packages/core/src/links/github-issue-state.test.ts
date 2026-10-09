import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultCredentialAccess, type CredentialMetadata } from "../credentials/access.js";
import { OperationLedger } from "../operations/ledger.js";
import { OperationController } from "../operations/controller.js";
import { CapabilityResolver } from "../operations/resolver.js";
import type { ToolContext } from "../tool-system/context.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import { getLocalLinkProvider } from "./providers.js";
import { executeCliLinkAction } from "./cli.js";
import { prepareRemoteLinkAction, normalizeRemoteLinkActionResult } from "./remote-adapters.js";
import { linkActionTool } from "./link-action-tool.js";
import { allowsLinkAction } from "./authority.js";
import { githubIssueStateParameters } from "./github-issue-state.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  setDefaultCredentialAccess(null);
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const caps = ["github.get_repository", "github.get_issue", "github.update_issue"];
function fixture(backend: "remote" | "oauth" = "remote") {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-star-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const credential: CredentialMetadata = {
    id: "connection",
    type: backend === "remote" ? "oauth" : "link",
    label: "Fixture",
    hasSecret: true,
    oauthStatus: { state: "valid", canRefresh: true },
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: backend === "remote" ? "server" : "local",
      linkExecutionBackend: backend === "remote" ? "remote" : "http-token",
      linkAccountId: "42",
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      ...(backend === "remote"
        ? { linkRemoteState: "connected", linkRemoteGrantId: "grant" }
        : { linkAuthSource: "browser-oauth", linkOAuthState: "connected" }),
      linkCapabilityIds: [...caps],
    },
  };
  const state = {
    repositoryId: 123,
    issueId: 456,
    state: "open",
    lose: false,
    mismatch: false,
    wrongRepository: false,
    wrongNumber: false,
    wrongUrl: false,
    pr: false,
    replaceRepo: false,
    replaceIssue: false,
    revoke: false,
  };
  const calls: string[] = [];
  const execute = async ({
    action,
    params,
  }: {
    action: string;
    params: Record<string, unknown>;
  }) => {
    calls.push(action);
    if (action === "get_repository")
      return {
        id: state.repositoryId,
        full_name: state.wrongRepository ? "other/repo" : "acme/repo",
      };
    if (action === "get_issue") {
      if (state.revoke) credential.meta!.linkCapabilityIds = ["github.update_issue"];
      return {
        id: state.issueId,
        number: state.wrongNumber ? 8 : 7,
        url: `https://api.github.com/repos/${state.wrongUrl ? "other" : "acme"}/repo/issues/7`,
        repository_url: "https://api.github.com/repos/acme/repo",
        state: state.mismatch && calls.includes("update_issue") ? "open" : state.state,
        ...(state.pr ? { pull_request: {} } : {}),
      };
    }
    if (action === "update_issue") {
      state.state = params.state as string;
      if (state.replaceRepo) state.repositoryId = 999;
      if (state.replaceIssue) state.issueId = 999;
      if (state.lose) throw new Error("Lost response");
      return { acknowledged: true };
    }
    throw new Error("Unexpected fixture action");
  };
  setDefaultCredentialAccess({
    listMasked: () => [credential],
    resolveMeta: () => credential,
    envExposures: () => ({}),
    executeRemoteLinkAction: execute,
    executeLocalOAuthLinkAction: execute,
  });
  const ledger = new OperationLedger(directory);
  const ctx = {
    cwd: directory,
    settingsScope: "isolated",
    originClientMessageId: "intent",
    sessionId: "session",
    askUser: async () => "允许执行",
    operations: {
      sessionId: "session",
      runId: "run",
      controller: new OperationController(ledger),
      resolver: new CapabilityResolver(),
    },
  } as ToolContext;
  const invoke = async (
    params: Record<string, unknown> = {
      owner: "Acme",
      repo: "Repo",
      issue_number: 7,
      state: "closed",
    },
    options: { deny?: string; hooks?: HookRegistry; action?: string } = {},
  ) => {
    const executor = new ToolExecutor(
      new ToolRegistry({ builtinTools: ["LinkAction"] }),
      new PermissionClassifier(
        [
          ...(options.deny
            ? [
                {
                  tool: "LinkAction",
                  decision: "deny" as const,
                  argsPattern: { action: options.deny },
                },
              ]
            : []),
          { tool: "LinkAction", decision: "allow" },
        ],
        "default",
      ),
      options.hooks ?? new HookRegistry(),
    );
    executor.setContext(ctx);
    const result = await executor.executeSingle({
      id: `tool-${calls.length}`,
      toolName: "LinkAction",
      args: {
        provider: "github",
        action: options.action ?? "update_issue",
        connectionId: credential.id,
        params,
      },
    });
    return result.isError
      ? { kind: "executor_error", error: String(result.result) }
      : JSON.parse(String(result.result).split("\n")[0]!);
  };
  return { credential, calls, ctx, ledger, invoke, state };
}

test.each(["remote", "oauth"] as const)(
  "%s closes/reopens one issue, binds immutable IDs, and never repeats a known result",
  async (backend) => {
    const f = fixture(backend);
    const output = await f.invoke();
    expect(output.kind).toBe("action_result");
    expect(output.data).toEqual({
      owner: "acme",
      repo: "repo",
      issue_number: 7,
      state: "closed",
      changed: true,
      verified: true,
    });
    expect(output.operation.reference.id).toBe("123/456/7/closed/changed");
    expect(f.calls).toEqual([
      "get_repository",
      "get_issue",
      "update_issue",
      "get_repository",
      "get_issue",
    ]);
    expect((await f.invoke()).operation.id).toBe(output.operation.id);
    expect(f.calls).toHaveLength(5);
    f.ctx.originClientMessageId = "explicit-reopen";
    expect(
      (await f.invoke({ owner: "acme", repo: "repo", issue_number: 7, state: "open" })).data.state,
    ).toBe("open");
    expect(f.calls.filter((action) => action === "update_issue")).toHaveLength(2);
  },
);

test("already satisfied state performs zero writes and independently verifies", async () => {
  const f = fixture();
  f.state.state = "closed";
  const output = await f.invoke();
  expect(output.operation.state).toBe("verified");
  expect(output.data.changed).toBe(false);
  expect(f.calls).toEqual(["get_repository", "get_issue", "get_repository", "get_issue"]);
});

test.each(["wrongRepository", "wrongNumber", "wrongUrl", "pr"] as const)(
  "%s is blocked before any mutation",
  async (fault) => {
    const f = fixture();
    f.state[fault] = true;
    expect((await f.invoke()).operation.state).toBe("blocked");
    expect(f.calls).not.toContain("update_issue");
  },
);

test.each(["replaceRepo", "replaceIssue", "mismatch"] as const)(
  "%s after write cannot prove success or resend",
  async (fault) => {
    const f = fixture();
    f.state[fault] = true;
    expect((await f.invoke()).operation.state).toBe("succeeded");
    await f.invoke();
    expect(f.calls.filter((action) => action === "update_issue")).toHaveLength(1);
  },
);

test("lost response stays unknown across process reconstruction and new intent cannot bypass it", async () => {
  const f = fixture();
  f.state.lose = true;
  expect((await f.invoke()).operation.state).toBe("unknown");
  f.ctx.operations!.controller = new OperationController(new OperationLedger(f.ctx.cwd!));
  expect((await f.invoke()).operation.state).toBe("unknown");
  f.ctx.originClientMessageId = "later-turn";
  expect((await f.invoke()).operation.state).toBe("blocked");
  expect(f.calls.filter((action) => action === "update_issue")).toHaveLength(1);
});

test.each(["get_issue", "get_repository"])(
  "nested executor deny of %s prevents any write",
  async (deny) => {
    const f = fixture();
    expect((await f.invoke(undefined, { deny })).operation.state).toBe("blocked");
    expect(f.calls).toEqual([]);
  },
);

test("nested read hooks and live authority revocation are not bypassed", async () => {
  const f = fixture();
  const hooks = new HookRegistry();
  hooks.register("pre_tool_use", (event) =>
    event.data.args?.action === "get_issue"
      ? {
          updatedInput: {
            ...event.data.args,
            params: { owner: "other", repo: "repo", issue_number: 7 },
          },
        }
      : {},
  );
  const output = await f.invoke(undefined, { hooks });
  expect(output.operation.state).toBe("blocked");
  expect(f.calls).not.toContain("update_issue");
});

test("revocation after validation never writes", async () => {
  const f = fixture();
  f.state.revoke = true;
  await f.invoke();
  expect(f.calls).not.toContain("update_issue");
});

test("new action requires explicit grant on legacy local connections and CLI remains read-only", async () => {
  const f = fixture("oauth");
  delete f.credential.meta!.linkCapabilityIds;
  expect(allowsLinkAction(f.credential, "github", "update_issue")).toBe(false);
  expect((await f.invoke()).kind).toBe("error");
  expect(f.calls).toEqual([]);
  f.credential.meta!.linkCapabilityIds = [...caps];
  f.credential.meta!.linkExecutionBackend = "cli";
  expect(allowsLinkAction(f.credential, "github", "update_issue")).toBe(false);
  expect((await f.invoke()).kind).toBe("error");
  expect(f.calls).toEqual([]);
});

test.each([
  { issue_number: "7" },
  { issue_number: 0 },
  { issue_number: Number.MAX_SAFE_INTEGER + 1 },
  { state: "all" },
  { state_reason: "completed" },
  { title: "not supported" },
  { body: "not supported" },
  { labels: [] },
  { owner: ".." },
  { repo: "../repo" },
])("closed-set parameters reject %j", (patch) => {
  expect(() =>
    githubIssueStateParameters({
      owner: "Acme",
      repo: "Repo",
      issue_number: 7,
      state: "closed",
      ...patch,
    }),
  ).toThrow();
});

test("remote projection preserves identity and sends only reviewed state parameters", () => {
  const groups = [{ id: "repositories", items: [{ id: "acme/repo", label: "Synthetic" }] }];
  expect(
    prepareRemoteLinkAction(
      "github",
      "update_issue",
      { owner: "Acme", repo: "Repo", issue_number: 7, state: "closed" },
      groups,
    ),
  ).toEqual({ repository: "acme/repo", issue_number: 7, state: "closed" });
  const issue = {
    id: 456,
    number: 7,
    state: "open",
    url: "https://api.github.com/repos/acme/repo/issues/7",
    repository_url: "https://api.github.com/repos/acme/repo",
    pull_request: {},
  };
  expect(normalizeRemoteLinkActionResult("github", "get_issue", issue, {}, groups)).toEqual(issue);
});

test("local provider sends one fixed PATCH and preserves get_issue identity", async () => {
  const provider = getLocalLinkProvider("github")!;
  const calls: RequestInit[] = [];
  const fetchImpl = (async (url, init) => {
    expect(String(url)).toBe("https://api.github.com/repos/acme/repo/issues/7");
    calls.push(init!);
    return new Response(
      JSON.stringify({
        id: 456,
        number: 7,
        state: "closed",
        url: String(url),
        repository_url: "https://api.github.com/repos/acme/repo",
      }),
    );
  }) as typeof fetch;
  const params = { owner: "acme", repo: "repo", issue_number: 7, state: "closed" };
  expect(
    await provider.actions
      .find((a) => a.id === "update_issue")!
      .execute({ token: "synthetic", params, fetchImpl }),
  ).toEqual({ acknowledged: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe("PATCH");
  expect(calls[0]!.body).toBe('{"state":"closed"}');
  expect(calls[0]!.redirect).toBe("error");
  expect(
    (
      (await provider.actions
        .find((a) => a.id === "get_issue")!
        .execute({
          token: "synthetic",
          params: { owner: "acme", repo: "repo", issue_number: 7 },
          fetchImpl,
        })) as any
    ).id,
  ).toBe(456);
  let cliCalls = 0;
  await expect(
    executeCliLinkAction("github", "update_issue", params, {}, async () => {
      cliCalls++;
      throw new Error("No process permitted");
    }),
  ).rejects.toThrow();
  expect(cliCalls).toBe(0);
});

test.each([{ ids: undefined }, { ids: [] }])(
  "legacy absent/empty capability set never receives new write permission: %j",
  async ({ ids }) => {
    const f = fixture("oauth");
    f.credential.meta!.linkCapabilityIds = ids;
    expect(allowsLinkAction(f.credential, "github", "update_issue")).toBe(false);
    const output = JSON.parse(
      await linkActionTool(
        {
          provider: "github",
          action: "update_issue",
          connectionId: f.credential.id,
          params: { owner: "acme", repo: "repo", issue_number: 7, state: "closed" },
        },
        f.ctx,
      ),
    );
    expect(output.kind).toBe("error");
    expect(f.calls).toEqual([]);
  },
);

test("missing required read grants, cancelled approval and changed account/grant fail closed", async () => {
  for (const missing of ["github.get_repository", "github.get_issue"]) {
    const f = fixture();
    f.credential.meta!.linkCapabilityIds = caps.filter((id) => id !== missing);
    expect((await f.invoke()).operation.state).toBe("blocked");
    expect(f.calls).toEqual([]);
  }
  const cancelled = fixture();
  cancelled.ctx.askUser = async () => "取消";
  expect((await cancelled.invoke()).kind).toBe("cancelled");
  expect(cancelled.calls).toEqual([]);
  for (const field of ["linkAccountId", "linkRemoteGrantId"] as const) {
    const f = fixture();
    expect((await f.invoke()).operation.state).toBe("verified");
    f.credential.meta![field] = "changed";
    expect((await f.invoke()).kind).toBe("error");
    expect(f.calls).toHaveLength(5);
  }
});

test("display-only hook does not replace private verification evidence", async () => {
  const f = fixture();
  const hooks = new HookRegistry();
  let observed = 0;
  hooks.register("post_tool_use", () => {
    observed++;
    return { additionalContext: "Synthetic display only" };
  });
  expect((await f.invoke(undefined, { hooks })).operation.state).toBe("verified");
  expect(observed).toBe(5);
});
