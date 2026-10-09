import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../credentials/store.js";
import { PlaintextCipher } from "../credentials/cipher.js";
import { setDefaultCredentialAccess } from "../credentials/access.js";
import type { ToolContext } from "../tool-system/context.js";
import { linkActionTool } from "./link-action-tool.js";
import {
  beginRemoteLinkAuthorization,
  completeRemoteLinkAuthorization,
  executeRemoteLinkAction,
} from "./remote.js";
import {
  REMOTE_LINK_PROVIDER_ADAPTERS,
  prepareRemoteLinkAction,
  type RemoteLinkProviderId,
} from "./remote-adapters.js";
import { getLocalLinkProvider, validateLocalLinkToken } from "./providers.js";
import { bindSource } from "../sources/binding.js";
import { saveSourceDefinition } from "../sources/catalog.js";
import { SettingsManager } from "../settings/manager.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  setDefaultCredentialAccess(null);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("Source read crosses production Link authorization/refresh/resource filters over actual HTTP", async () => {
  const previousHome = process.env.CODE_SHELL_HOME;
  const directory = mkdtempSync(join(tmpdir(), "source-remote-http-"));
  process.env.CODE_SHELL_HOME = directory;
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  });
  const f = await fixture("github", { scopes: ["github:list_repositories"] });
  await f.connect();
  setDefaultCredentialAccess({
    listMasked: (_cwd, scope) => (scope === "full" ? f.store.listMasked() : []),
    resolveMeta: (_cwd, id, scope) =>
      scope === "full" ? f.store.listMasked().find((item) => item.id === id) : undefined,
    envExposures: () => ({}),
    executeRemoteLinkAction: (request) =>
      executeRemoteLinkAction(request, { store: f.store, now: () => Date.now() + 1_000_000 }),
  });
  saveSourceDefinition({
    id: "selected-repositories",
    kind: "link",
    label: "Selected repositories",
    enabled: true,
    credentialRef: "selected-link",
    adapterConfig: { providerId: "github", action: "list_repositories", params: { limit: 10 } },
  });
  bindSource(new SettingsManager(directory, "full"), directory, {
    sourceId: "selected-repositories",
    scopes: ["github:list_repositories"],
    readPolicy: "ask",
  });
  const registry = new ToolRegistry({ builtinTools: ["ReadSource", "LinkAction"] });
  const approvals: string[] = [];
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([], "default", {
      requestApproval: async (request) => {
        approvals.push(request.toolName);
        return { approved: true };
      },
    }),
    new HookRegistry(),
  );
  executor.setContext({ cwd: directory, settingsScope: "full" } as ToolContext);
  const output = await executor.executeSingle({
    id: "source-http",
    toolName: "ReadSource",
    args: {
      source: "selected-repositories",
      scope: "github:list_repositories",
      resource: "result",
    },
  });
  expect(output.isError).toBe(false);
  expect(output.result).toContain("owner/repo");
  expect(output.result).not.toContain("other/private");
  expect(output.result).not.toContain("PRIVATE");
  expect(approvals).toEqual(["ReadSource", "LinkAction"]);
  expect(f.requests.filter((request) => request.path === "/oauth/token")).toHaveLength(2);
  expect(f.requests.at(-1)?.path).toEndWith("/actions/list_repositories");
});
const team = "12345678-1234-1234-1234-123456789abc";
const page = "abcdef12abcdef12abcdef12abcdef12";
const resources: Record<RemoteLinkProviderId, string> = {
  github: "owner/repo",
  gitlab: "42",
  sentry: "acme",
  vercel: "prj_allowed",
  slack: "C12345",
  notion: page,
  linear: team,
  todoist: "project_42",
  airtable: "appAllowed123",
  figma: "FileAllowed123",
};
function params(provider: RemoteLinkProviderId, action: string): Record<string, unknown> {
  if (provider === "github")
    return action === "list_repositories"
      ? { limit: 10 }
      : {
          owner: "Owner",
          repo: "Repo",
          ...(action === "get_issue"
            ? { issue_number: 7 }
            : action === "get_pull_request"
              ? { pull_number: 8 }
              : action === "get_file"
                ? { path: "docs/guide.md", ref: "main" }
                : action === "update_issue"
                  ? { issue_number: 7, state: "closed" }
                  : action === "create_issue"
                    ? { title: "Explicitly approved fixture", body: "Synthetic data" }
                    : action === "set_starred"
                      ? { starred: true }
                      : {}),
        };
  if (provider === "sentry" && action === "list_projects")
    return { organization: resources.sentry };
  if (provider === "slack" && action === "get_channel_history")
    return { channel: resources.slack, limit: 15 };
  if (provider === "notion")
    return action === "get_page"
      ? { page_id: "abcdef12-abcd-ef12-abcd-ef12abcdef12" }
      : { query: "fixture" };
  if (provider === "airtable" && action === "list_tables") return { base_id: resources.airtable };
  if (provider === "figma")
    return { file_url_or_key: `https://www.figma.com/design/${resources.figma}/Fixture` };
  if (provider === "vercel") return { team_id: "team_installation", limit: 10 };
  return ["gitlab", "slack", "linear", "todoist"].includes(provider) ? { limit: 10 } : {};
}
function result(provider: RemoteLinkProviderId, action: string, body: any): unknown {
  if (provider === "github") {
    if (action === "get_repository") return { id: 123, full_name: "owner/repo" };
    if (action === "get_starred") return { starred: false };
    if (action === "set_starred" || action === "update_issue") return { acknowledged: true };
    if (action === "list_repositories")
      return [
        { id: 1, full_name: "owner/repo" },
        { id: 2, full_name: "other/private" },
      ];
    if (action === "list_issues")
      return [
        { number: 7, title: "Issue" },
        { number: 8, pull_request: {} },
      ];
    if (action === "list_pull_requests") return [{ number: 8, title: "Pull", draft: false }];
    if (["get_file", "get_readme"].includes(action))
      return {
        type: "file",
        path: body.path ?? "README.md",
        encoding: "base64",
        content: Buffer.from("Hello from upstream").toString("base64"),
        sha: "sha",
        size: 19,
      };
    return {
      number: body.number ?? body.pull_number ?? 9,
      title: "Approved result",
      body: "Untrusted external content",
    };
  }
  if (provider === "gitlab")
    return action === "list_projects"
      ? {
          projects: [
            { id: 42, name: "Allowed" },
            { id: 43, name: "Forbidden" },
          ],
          next_cursor: "next",
        }
      : {
          issues: [
            { id: 1, project_id: 42 },
            { id: 2, project_id: 43 },
          ],
          next_cursor: "next",
        };
  if (provider === "sentry")
    return action === "list_organizations"
      ? {
          organizations: [
            { slug: "acme", id: "1" },
            { slug: "other", id: "2" },
          ],
        }
      : { projects: [{ slug: "project", id: "1" }] };
  if (provider === "vercel")
    return action === "list_projects"
      ? { projects: [{ id: "prj_allowed" }, { id: "prj_other" }], pagination: { next: 123 } }
      : {
          deployments: [
            { uid: "deploy-1", projectId: "prj_allowed" },
            { uid: "deploy-2", projectId: "prj_other" },
          ],
          pagination: { next: 123 },
        };
  if (provider === "slack")
    return action === "list_channels"
      ? { channels: [{ id: "C12345" }, { id: "COTHER" }], next_cursor: "next" }
      : { messages: [{ ts: "1", text: "Hello" }], has_more: true };
  if (provider === "notion")
    return action === "get_page"
      ? { id: page, object: "page", properties: {} }
      : {
          results: [
            { id: page, object: "page" },
            { id: "ffffffffffffffffffffffffffffffff", object: "page" },
          ],
          next_cursor: "next",
          has_more: true,
        };
  if (provider === "linear")
    return action === "list_teams"
      ? { teams: [{ id: team, key: "TEAM" }, { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" }] }
      : {
          issues: [
            { id: "issue-1", team: { id: team } },
            { id: "issue-2", team: { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" } },
          ],
          next_cursor: "next",
        };
  if (provider === "todoist")
    return action === "list_projects"
      ? { projects: [{ id: "project_42" }, { id: "other" }] }
      : {
          tasks: [
            { id: "task-1", project_id: "project_42" },
            { id: "task-2", project_id: "other" },
          ],
          next_cursor: "next",
        };
  if (provider === "airtable")
    return action === "list_bases"
      ? { bases: [{ id: "appAllowed123" }, { id: "appOther" }], offset: "next" }
      : { tables: [{ id: "tbl1", fields: [] }] };
  return action === "get_file"
    ? { name: "Fixture", version: "1", pages: [{ id: "0:1", name: "Page", type: "CANVAS" }] }
    : { comments: [{ id: "1", message: "Hello" }] };
}
async function fixture(
  providerId: RemoteLinkProviderId,
  options: { metadata?: (value: any) => any; scopes?: string[] } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "all-remote-link-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new CredentialStore(undefined, new PlaintextCipher(), directory);
  const adapter = REMOTE_LINK_PROVIDER_ADAPTERS.find((item) => item.id === providerId)!;
  const scopes = options.scopes ?? adapter.actions.map((action) => `${providerId}:${action}`);
  const connectionId = randomUUID(),
    grantId = randomUUID();
  const group = {
    id: adapter.group,
    items: [{ id: resources[providerId], label: "Explicitly selected resource" }],
  };
  const requests: Array<{ path: string; body: any }> = [];
  let actionStatus = 200,
    actionResult: unknown,
    wait: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const raw = Buffer.concat(parts).toString();
    const body = req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(raw))
      : raw
        ? JSON.parse(raw)
        : {};
    requests.push({ path: req.url!, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/oauth/token")
      return res.end(
        JSON.stringify({
          access_token: "DOWNSTREAM-PRIVATE",
          refresh_token: "ROTATING-PRIVATE-" + requests.length,
          expires_in: 900,
          token_type: "Bearer",
          scope: scopes.join(" "),
        }),
      );
    if (req.url === "/api/v1/data/authorization") {
      const metadata = {
        version: 1,
        providerId,
        connectionId,
        grantId,
        account: { id: `${providerId}-account`, login: "fixture", label: "Fixture account" },
        actions: scopes.map((scope) => scope.split(":")[1]),
        scopes,
        resources: [group],
        resourceGroups: [group],
        ...(providerId === "github" ? { repositories: [resources.github] } : {}),
      };
      return res.end(JSON.stringify(options.metadata?.(metadata) ?? metadata));
    }
    await wait;
    res.statusCode = actionStatus;
    res.end(
      JSON.stringify(
        actionStatus === 200
          ? { result: actionResult ?? result(providerId, req.url!.split("/").at(-1)!, body) }
          : { error: "UPSTREAM-PRIVATE and DOWNSTREAM-PRIVATE must not leak" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const attempt = beginRemoteLinkAuthorization(
    { issuer, clientId: "registered-client", redirectUri: "http://127.0.0.1:4900/callback" },
    Date.now(),
    { providerId, actions: adapter.actions },
  );
  const connect = async () => {
    const credential = await completeRemoteLinkAuthorization(
      attempt,
      `${attempt.configuration.redirectUri}?code=once&state=${attempt.state}`,
      "selected-link",
      "Selected Link",
    );
    store.save("user", credential);
    return credential;
  };
  const execute = (
    action: string,
    values = params(providerId, action),
    options: { signal?: AbortSignal; now?: () => number } = {},
  ) =>
    executeRemoteLinkAction(
      { id: "selected-link", grantId, scope: "full", action, params: values },
      { store, ...options },
    );
  return {
    store,
    adapter,
    attempt,
    requests,
    connect,
    execute,
    setStatus: (value: number) => {
      actionStatus = value;
    },
    setResult: (value: unknown) => {
      actionResult = value;
    },
    delay: (value: Promise<void>) => {
      wait = value;
    },
  };
}

for (const adapter of REMOTE_LINK_PROVIDER_ADAPTERS) {
  test(`${adapter.id}: actual HTTP authorization and every declared action preserve the local contract and selected resources`, async () => {
    const f = await fixture(adapter.id);
    const credential = await f.connect();
    expect(new URL(f.attempt.authorizationUrl).searchParams.get("provider_id")).toBe(adapter.id);
    expect(credential.meta?.linkProvider).toBe(adapter.id);
    expect(credential.meta?.linkResourceGroups?.[0]?.id).toBe(adapter.group);
    expect(credential.meta?.linkCapabilityIds).toEqual(
      adapter.actions.map((action) => `${adapter.id}.${action}`),
    );
    expect(JSON.stringify(credential.meta)).not.toContain("PRIVATE");
    for (const action of adapter.actions) {
      const output = await f.execute(action);
      expect(output).toBeObject();
      const lists = Object.values(output as Record<string, unknown>).filter(Array.isArray);
      for (const list of lists) expect(list.length).toBe(1);
      expect(f.requests.at(-1)?.path).toEndWith(`/actions/${action}`);
    }
    expect(f.requests.filter((request) => request.path.includes("/actions/"))).toHaveLength(
      adapter.actions.length,
    );
    if (adapter.id === "notion")
      expect(f.requests.find((request) => request.path.endsWith("/search"))?.body).toEqual({
        query: "fixture",
      });
    if (adapter.id === "vercel")
      expect(f.requests.at(-1)?.body).toMatchObject({
        team_id: "team_installation",
        limit: 10,
      });
  });
}

test("authorization rejects cross-provider, expanded capabilities, ambiguous resources and missing identity", async () => {
  for (const metadata of [
    (value: any) => ({ ...value, providerId: "github" }),
    (value: any) => ({ ...value, actions: ["list_projects", "create_issue"] }),
    (value: any) => ({ ...value, scopes: ["github:list_repositories"] }),
    (value: any) => ({
      ...value,
      resourceGroups: [
        { id: "repositories", items: [{ id: "owner/repo", label: "Wrong provider" }] },
      ],
    }),
    (value: any) => ({
      ...value,
      resourceGroups: [
        {
          id: "projects",
          items: [
            { id: "42", label: "a" },
            { id: "42", label: "b" },
          ],
        },
      ],
    }),
    (value: any) => ({ ...value, account: { id: "", login: "" } }),
  ]) {
    const f = await fixture("gitlab", { metadata });
    await expect(f.connect()).rejects.toMatchObject({ code: "reconnect" });
    expect(f.store.list()).toEqual([]);
  }
});

test("unreviewed scopes in a token are rejected before any metadata or action request", async () => {
  const f = await fixture("gitlab", { scopes: ["gitlab:list_projects", "github:create_issue"] });
  await expect(f.connect()).rejects.toMatchObject({ code: "reconnect" });
  expect(f.requests.map((request) => request.path)).toEqual(["/oauth/token"]);
});

test("resource-specific actions reject a different grant resource before sending HTTP", async () => {
  const cases: Array<[RemoteLinkProviderId, string, Record<string, unknown>]> = [
    ["github", "get_file", { owner: "other", repo: "private", path: "secret" }],
    ["sentry", "list_projects", { organization: "other" }],
    ["slack", "get_channel_history", { channel: "COTHER" }],
    ["notion", "get_page", { page_id: "ffffffffffffffffffffffffffffffff" }],
    ["airtable", "list_tables", { base_id: "appOther" }],
    ["figma", "get_comments", { file_key: "OtherFile" }],
  ];
  for (const [provider, action, input] of cases) {
    const f = await fixture(provider);
    await f.connect();
    const before = f.requests.length;
    await expect(f.execute(action, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.execute("unreviewed_write", {})).rejects.toMatchObject({ code: "forbidden" });
    expect(f.requests).toHaveLength(before);
  }
});

test("bounded list metadata survives normalization and refresh stays bound to the non-GitHub provider", async () => {
  const f = await fixture("todoist");
  await f.connect();
  const output = await f.execute(
    "list_tasks",
    { limit: 1 },
    { now: () => Date.now() + 16 * 60_000 },
  );
  expect(output).toEqual({
    tasks: [{ id: "task-1", project_id: "project_42" }],
    next_cursor: "next",
  });
  expect(f.requests.filter((request) => request.body.grant_type === "refresh_token")).toHaveLength(
    1,
  );
  expect(f.requests.at(-1)?.body).toEqual({ limit: 1 });
});

test("in-flight resource authority changes discard the returned data", async () => {
  const f = await fixture("slack");
  const credential = await f.connect();
  let release!: () => void;
  f.delay(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const request = f.execute("list_channels");
  while (!f.requests.some((item) => item.path.endsWith("/list_channels")))
    await new Promise((resolve) => setTimeout(resolve, 2));
  f.store.save("user", {
    ...credential,
    meta: {
      ...credential.meta,
      linkResourceGroups: [{ id: "channels", items: [{ id: "COTHER", label: "Changed" }] }],
    },
  });
  release();
  await expect(request).rejects.toMatchObject({ code: "changed" });
});

test("request cancellation and provider errors cannot return success or credential-bearing bodies", async () => {
  const f = await fixture("linear");
  await f.connect();
  f.setStatus(429);
  await expect(f.execute("list_teams")).rejects.toMatchObject({ code: "unavailable" });
  f.setStatus(200);
  f.setResult({ teams: "malformed" });
  await expect(f.execute("list_teams")).rejects.toMatchObject({ code: "unavailable" });
  const abort = new AbortController();
  abort.abort();
  const before = f.requests.length;
  await expect(f.execute("list_teams", {}, { signal: abort.signal })).rejects.toThrow();
  expect(f.requests).toHaveLength(before);
});

test("remote GitHub write requires approval and the owning authorization pipeline before any request", async () => {
  const f = await fixture("github");
  const credential = await f.connect();
  const masked = {
    ...credential,
    secret: undefined,
    hasSecret: true,
    oauthStatus: { state: "valid" as const, hasRefreshToken: true },
  };
  setDefaultCredentialAccess({
    listMasked: () => [masked],
    resolveMeta: () => masked,
    envExposures: () => ({}),
    executeRemoteLinkAction: async (input) => f.execute(input.action, input.params),
  });
  const args = {
    provider: "github",
    action: "create_issue",
    connectionId: credential.id,
    params: params("github", "create_issue"),
  };
  const before = f.requests.length;
  expect(JSON.parse(await linkActionTool(args, { cwd: "/fixture" } as ToolContext)).kind).toBe(
    "error",
  );
  expect(
    JSON.parse(
      await linkActionTool(args, {
        cwd: "/fixture",
        askUser: async () => "取消",
      } as unknown as ToolContext),
    ).kind,
  ).toBe("cancelled");
  expect(f.requests).toHaveLength(before);
  const approved = JSON.parse(
    await linkActionTool(args, {
      cwd: "/fixture",
      askUser: async () => "允许执行",
    } as unknown as ToolContext),
  );
  expect(approved).toMatchObject({
    kind: "error",
    provider: "github",
    action: "create_issue",
    error: "Verified writes require the owning Engine and tool authorization pipeline.",
  });
  expect(f.requests).toHaveLength(before);
});

test("GitLab, Figma and Linear distinguish personal-token headers from OAuth Bearer headers", async () => {
  for (const providerId of ["gitlab", "figma", "linear"] as const) {
    for (const authKind of ["token", "oauth"] as const) {
      let headers = new Headers();
      await validateLocalLinkToken(providerId, "synthetic-private", {
        authKind,
        fetchImpl: (async (_url: unknown, init?: RequestInit) => {
          headers = new Headers(init?.headers);
          return new Response(
            JSON.stringify(
              providerId === "linear"
                ? { data: { viewer: { id: "1", name: "Fixture" } } }
                : { id: "1", username: "fixture", handle: "fixture" },
            ),
            { status: 200 },
          );
        }) as typeof fetch,
      });
      expect(headers.get("authorization")).toBe(
        authKind === "oauth"
          ? "Bearer synthetic-private"
          : providerId === "linear"
            ? "synthetic-private"
            : null,
      );
      expect(headers.get("private-token")).toBe(
        providerId === "gitlab" && authKind === "token" ? "synthetic-private" : null,
      );
      expect(headers.get("x-figma-token")).toBe(
        providerId === "figma" && authKind === "token" ? "synthetic-private" : null,
      );
    }
    const provider = getLocalLinkProvider(providerId)!;
    expect(provider.actions.length).toBe(2);
  }
});

test("execution rechecks the stored token scope intersection before HTTP", async () => {
  const f = await fixture("gitlab");
  const credential = await f.connect();
  const secret = JSON.parse(credential.secret!);
  secret.scope = "gitlab:list_projects";
  f.store.save("user", { ...credential, secret: JSON.stringify(secret) });
  const before = f.requests.length;
  await expect(f.execute("list_issues")).rejects.toMatchObject({ code: "reconnect" });
  expect(f.requests).toHaveLength(before);
});

test("remote parameters retain reviewed provider limits and reject unsupported compound cursors", () => {
  const group = (providerId: RemoteLinkProviderId) => [
    {
      id: REMOTE_LINK_PROVIDER_ADAPTERS.find((adapter) => adapter.id === providerId)!.group,
      items: [{ id: resources[providerId], label: "Selected" }],
    },
  ];
  expect(prepareRemoteLinkAction("slack", "list_channels", { limit: 200 }, group("slack"))).toEqual(
    { limit: 200 },
  );
  expect(prepareRemoteLinkAction("linear", "list_issues", { limit: 100 }, group("linear"))).toEqual(
    { limit: 50 },
  );
  expect(() =>
    prepareRemoteLinkAction("todoist", "list_tasks", { cursor: "unbound" }, group("todoist")),
  ).toThrow();
});
