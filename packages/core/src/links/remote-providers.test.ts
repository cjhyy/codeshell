import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../credentials/store.js";
import { PlaintextCipher } from "../credentials/cipher.js";
import { createIpcCredentialAccess, setDefaultCredentialAccess } from "../credentials/access.js";
import { createInProcessTransport } from "../protocol/transport.js";
import type { ToolContext } from "../tool-system/context.js";
import { linkActionTool } from "./link-action-tool.js";
import {
  beginRemoteLinkAuthorization,
  completeRemoteLinkAuthorization,
  executeRemoteLinkAction,
  RemoteLinkError,
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
import { createSessionOperationController } from "../operations/controller.js";
import { CapabilityResolver } from "../operations/resolver.js";

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
            : ["get_pull_request", "list_pull_request_files", "list_pull_request_commits"].includes(
                  action,
                )
              ? { pull_number: 8 }
              : action === "get_commit"
                ? { sha: "a".repeat(40) }
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
  if (provider === "slack" && action === "get_message")
    return { permalink: "https://fixture.slack.com/archives/C12345/p1760000000000001" };
  if (provider === "slack" && action === "get_thread")
    return { channel: resources.slack, ts: "1760000000.000001" };
  if (provider === "slack" && action === "get_channel_history")
    return { channel: resources.slack, limit: 15 };
  if (provider === "notion")
    return action === "get_page"
      ? { page_id: "abcdef12-abcd-ef12-abcd-ef12abcdef12" }
      : { query: "fixture" };
  if (provider === "airtable" && action === "list_tables") return { base_id: resources.airtable };
  if (provider === "figma")
    return {
      file_url_or_key: `https://www.figma.com/design/${resources.figma}/Fixture`,
      ...(["get_nodes", "get_images"].includes(action) ? { ids: ["1:2"] } : {}),
    };
  if (provider === "vercel") return { team_id: "team_installation", limit: 10 };
  return ["gitlab", "slack", "linear", "todoist"].includes(provider) ? { limit: 10 } : {};
}
function result(provider: RemoteLinkProviderId, action: string, body: any): unknown {
  if (provider === "github") {
    if (action === "list_pull_request_files")
      return [{ filename: "src/example.ts", patch: "@@ -1 +1 @@\n-old\n+new" }];
    if (["list_pull_request_commits", "get_commit"].includes(action)) {
      const commit = {
        sha: "a".repeat(40),
        author: { login: "fixture", id: 42 },
        commit: {
          author: { name: "Fixture", email: "fixture@example.test", date: "2026-10-12T00:00:00Z" },
        },
        parents: [{ sha: "b".repeat(40) }],
        files: [{ filename: "src/example.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
      };
      return action === "get_commit" ? commit : [commit];
    }
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
  if (provider === "slack" && ["get_message", "get_thread"].includes(action))
    return {
      messages: [{ user: "U12345", ts: "1760000000.000001", text: "Decision context" }],
      permalink: "https://fixture.slack.com/archives/C12345/p1760000000000001",
      has_more: false,
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
  if (action === "get_file")
    return {
      name: "Fixture",
      version: "1",
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [{ id: "0:1", name: "Page", type: "CANVAS" }],
      },
    };
  if (action === "get_nodes")
    return {
      name: "Fixture",
      nodes: { "1:2": { document: { id: "1:2", type: "TEXT", characters: "Full text" } } },
    };
  if (action === "get_images") return { images: { "1:2": "https://example.test/render.png" } };
  if (action === "get_image_fills")
    return { meta: { images: { fill: "https://example.test/fill.png" } } };
  return {
    comments: [
      { id: "1", message: "Hello", parent_id: "0", order_id: "1", file_key: resources.figma },
    ],
  };
}
async function fixture(
  providerId: RemoteLinkProviderId,
  options: { metadata?: (value: any) => any; scopes?: string[]; resourceFiles?: string[] } = {},
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
    { providerId, actions: adapter.actions, resourceFiles: options.resourceFiles },
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
      if (adapter.id === "figma" && action === "get_comments")
        expect(output).toMatchObject({
          comments: [{ parent_id: "0", order_id: "1", file_key: resources.figma }],
        });
      const lists = Object.values(output as Record<string, unknown>).filter(Array.isArray);
      for (const list of lists) expect(list.length).toBe(1);
      expect(f.requests.at(-1)?.path).toEndWith(`/actions/${action}`);
      if (adapter.id === "figma" && action === "get_file")
        expect(f.requests.at(-1)?.body).toEqual({ file_url_or_key: resources.figma, depth: 2 });
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

test("Figma account-only grants are connected but cannot read any file or refresh a token", async () => {
  const f = await fixture("figma", {
    resourceFiles: [],
    metadata: (value) => ({
      ...value,
      resources: [{ id: "files", items: [] }],
      resourceGroups: [{ id: "files", items: [] }],
    }),
  });
  const credential = await f.connect();
  expect(new URL(f.attempt.authorizationUrl).searchParams.get("resource_mode")).toBe("deferred");
  expect(credential.meta?.linkRemoteState).toBe("connected");
  expect(credential.meta?.linkResourceGroups).toEqual([{ id: "files", items: [] }]);
  const before = f.requests.length;
  for (const action of f.adapter.actions) {
    await expect(
      f.execute(action, params("figma", action), {
        now: () => Date.now() + 1_000_000,
      }),
    ).rejects.toMatchObject({ code: "file_not_authorized" });
    await expect(f.execute(action)).rejects.toThrow("添加文件");
  }
  expect(f.requests).toHaveLength(before);
  expect(f.store.resolve("selected-link")?.meta?.linkRemoteState).toBe("connected");
});

test("saved get_file grants permit explicit full reads without gaining node or image actions", async () => {
  const f = await fixture("figma", { scopes: ["figma:get_file", "figma:get_comments"] });
  const credential = await f.connect();
  expect(credential.meta?.linkCapabilityIds).toEqual(["figma.get_file", "figma.get_comments"]);
  const document = {
    id: "0:0",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        type: "CANVAS",
        children: [{ id: "1:2", type: "TEXT", characters: "Design text", style: { fontSize: 24 } }],
      },
    ],
  };
  f.setResult({
    name: "Full file",
    document,
    components: { "3:4": { name: "Button" } },
    styles: { "5:6": { name: "Heading" } },
    secret: "omit",
  });
  expect(await f.execute("get_file", { file_key: resources.figma, full: true })).toMatchObject({
    document,
    components: { "3:4": { name: "Button" } },
    styles: { "5:6": { name: "Heading" } },
  });
  expect(f.requests.at(-1)?.body).toEqual({ file_url_or_key: resources.figma, full: true });
  const before = f.requests.length;
  for (const action of ["get_nodes", "get_images", "get_image_fills"])
    await expect(f.execute(action)).rejects.toMatchObject({ code: "forbidden" });
  expect(f.requests).toHaveLength(before);
  expect(f.store.resolve("selected-link")?.meta?.linkCapabilityIds).toEqual([
    "figma.get_file",
    "figma.get_comments",
  ]);
});

test("Figma get_file fails explicitly when the service returns only a pages summary", async () => {
  const f = await fixture("figma", { scopes: ["figma:get_file", "figma:get_comments"] });
  await f.connect();
  f.setResult({ name: "Summary", pages: [{ id: "0:1", name: "Page", type: "CANVAS" }] });
  await expect(f.execute("get_file")).rejects.toMatchObject({ code: "content_unavailable" });
  expect(f.requests.filter((request) => request.path.includes("/actions/"))).toHaveLength(1);
});

test("remote Figma full content has a larger bounded budget and a recoverable overflow", async () => {
  const f = await fixture("figma");
  await f.connect();
  const content = "x".repeat(3 * 1024 * 1024);
  f.setResult({
    name: "Large file",
    document: { id: "0:0", type: "DOCUMENT", description: content },
  });
  expect(await f.execute("get_file", { file_key: resources.figma, full: true })).toHaveProperty(
    "document.description",
    content,
  );
  f.setResult({
    name: "Too large",
    document: { id: "0:0", type: "DOCUMENT", description: "x".repeat(8 * 1024 * 1024) },
  });
  await expect(f.execute("get_file")).rejects.toMatchObject({ code: "response_too_large" });
  await expect(f.execute("get_file")).rejects.toThrow("get_nodes");
  expect(f.store.resolve("selected-link")?.meta?.linkRemoteState).toBe("connected");
  f.setStatus(413);
  await expect(f.execute("get_file")).rejects.toMatchObject({ code: "response_too_large" });
});

test("remote Figma Make links fail explicitly before refresh or provider HTTP", async () => {
  const f = await fixture("figma");
  await f.connect();
  const before = f.requests.length;
  await expect(
    f.execute(
      "get_file",
      { file_url_or_key: "https://www.figma.com/make/MakeOne/Prototype" },
      { now: () => Date.now() + 1_000_000 },
    ),
  ).rejects.toMatchObject({ code: "unsupported_file_type" });
  expect(f.requests).toHaveLength(before);
});

test("Figma selection is canonical, bounded and cannot silently widen or lose requested file access", async () => {
  const url = `https://www.figma.com/design/${resources.figma}/Fixture?node-id=0-1`;
  const f = await fixture("figma", { resourceFiles: [url, resources.figma] });
  const query = new URL(f.attempt.authorizationUrl).searchParams;
  expect(query.get("resource_mode")).toBe("select");
  expect(JSON.parse(query.get("resource_files")!)).toEqual([resources.figma]);
  await f.connect();
  for (const resourceFiles of [[], [resources.figma, "AnotherFile"]]) {
    const invalid = await fixture("figma", { resourceFiles });
    await expect(invalid.connect()).rejects.toMatchObject({ code: "reconnect" });
    expect(invalid.store.list()).toEqual([]);
  }
  for (const value of [
    "https://figma.com.attacker.test/design/FileAllowed123/Fixture",
    "https://user:pass@www.figma.com/design/FileAllowed123/Fixture",
    "https://www.figma.com:8443/design/FileAllowed123/Fixture",
    "http://www.figma.com/design/FileAllowed123/Fixture",
  ]) {
    expect(() =>
      beginRemoteLinkAuthorization(f.attempt.configuration, Date.now(), {
        providerId: "figma",
        resourceFiles: [value],
      }),
    ).toThrow();
  }
  expect(() =>
    beginRemoteLinkAuthorization(f.attempt.configuration, Date.now(), {
      providerId: "github",
      resourceFiles: [],
    }),
  ).toThrow();
  expect(() =>
    beginRemoteLinkAuthorization(f.attempt.configuration, Date.now(), {
      providerId: "figma",
      resourceFiles: Array.from({ length: 101 }, (_, i) => `File${i}`),
    }),
  ).toThrow();
  const full = Array.from({ length: 100 }, (_, i) => `File${i}`);
  const duplicate = beginRemoteLinkAuthorization(f.attempt.configuration, Date.now(), {
    providerId: "figma",
    resourceFiles: [...full, "https://www.figma.com/design/File0/AlreadyAdded"],
  });
  expect(duplicate.resourceFiles).toEqual(full);
});

test("ReadSource over worker IPC directs an ungranted Figma file to Add file without issuing provider requests", async () => {
  const previousHome = process.env.CODE_SHELL_HOME;
  const directory = mkdtempSync(join(tmpdir(), "figma-source-remote-http-"));
  process.env.CODE_SHELL_HOME = directory;
  cleanups.push(() => {
    if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  });
  const f = await fixture("figma", {
    resourceFiles: [],
    metadata: (value) => ({
      ...value,
      resources: [{ id: "files", items: [] }],
      resourceGroups: [{ id: "files", items: [] }],
    }),
  });
  await f.connect();
  const [main, worker] = createInProcessTransport();
  setDefaultCredentialAccess(createIpcCredentialAccess(worker));
  main.send({
    jsonrpc: "2.0",
    method: "desktop/credentialSnapshot",
    params: {
      revision: 1,
      entries: [
        {
          cwd: directory,
          full: f.store.listMasked(),
          project: [],
          envFull: {},
          envProject: {},
        },
      ],
    },
  });
  main.onMessage((message) => {
    if (
      !("method" in message) ||
      !("id" in message) ||
      message.method !== "desktop/remoteLinkAction"
    )
      return;
    void executeRemoteLinkAction(message.params as any, { store: f.store }).then(
      (result) => main.send({ jsonrpc: "2.0", id: message.id, result }),
      (error) =>
        main.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: "Details are deliberately omitted by the worker boundary",
            ...(error instanceof RemoteLinkError && error.code === "file_not_authorized"
              ? { data: { remoteLinkCode: error.code } }
              : {}),
          },
        }),
    );
  });
  saveSourceDefinition({
    id: "figma-design",
    kind: "link",
    label: "Design",
    enabled: true,
    credentialRef: "selected-link",
    adapterConfig: {
      providerId: "figma",
      action: "get_file",
      params: { file_url_or_key: resources.figma },
    },
  });
  bindSource(new SettingsManager(directory, "full"), directory, {
    sourceId: "figma-design",
    scopes: ["figma:get_file"],
    readPolicy: "ask",
  });
  const executor = new ToolExecutor(
    new ToolRegistry({ builtinTools: ["ReadSource", "LinkAction"] }),
    new PermissionClassifier([], "default", {
      requestApproval: async () => ({ approved: true }),
    }),
    new HookRegistry(),
  );
  executor.setContext({ cwd: directory, settingsScope: "full" } as ToolContext);
  const before = f.requests.length;
  const output = await executor.executeSingle({
    id: "figma-source",
    toolName: "ReadSource",
    args: { source: "figma-design", scope: "figma:get_file", resource: "result" },
  });
  expect(output.isError).toBe(true);
  expect(output.error).toContain("添加文件");
  expect(f.requests).toHaveLength(before);
  expect(f.store.resolve("selected-link")?.meta?.linkResourceLabels).toEqual([]);
});

test("empty resource grants remain invalid for providers without deferred file selection", async () => {
  const f = await fixture("gitlab", {
    metadata: (value) => ({
      ...value,
      resources: [{ id: "projects", items: [] }],
      resourceGroups: [{ id: "projects", items: [] }],
    }),
  });
  await expect(f.connect()).rejects.toMatchObject({ code: "reconnect" });
  expect(f.store.list()).toEqual([]);
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
    [
      "slack",
      "get_message",
      { permalink: "https://fixture.slack.com/archives/COTHER/p1760000000000001" },
    ],
    ["slack", "get_thread", { channel: "COTHER", ts: "1760000000.000001" }],
    ["github", "get_commit", { owner: "other", repo: "private", sha: "a".repeat(40) }],
    ["github", "list_pull_request_files", { owner: "other", repo: "private", pull_number: 8 }],
    ["notion", "get_page", { page_id: "ffffffffffffffffffffffffffffffff" }],
    ["airtable", "list_tables", { base_id: "appOther" }],
    ["figma", "get_comments", { file_key: "OtherFile" }],
  ];
  for (const [provider, action, input] of cases) {
    const f = await fixture(provider);
    await f.connect();
    const before = f.requests.length;
    await expect(f.execute(action, input)).rejects.toMatchObject({
      code: provider === "figma" ? "file_not_authorized" : "forbidden",
    });
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
  const operationRoot = mkdtempSync(join(tmpdir(), "remote-link-cancel-controller-"));
  cleanups.push(() => rmSync(operationRoot, { recursive: true, force: true }));
  let approvals = 0;
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
        operations: {
          controller: createSessionOperationController(operationRoot, "cancel-session", undefined),
          resolver: new CapabilityResolver(),
          sessionId: "cancel-session",
          runId: "trusted-run",
        },
        executeBoundTool: async () => {
          throw new Error("Cancelled writes must not execute a bound tool");
        },
        askUser: async (_question, options) => {
          approvals++;
          expect(options?.optionsOnly).toBe(true);
          return "取消";
        },
      } as unknown as ToolContext),
    ).kind,
  ).toBe("cancelled");
  expect(approvals).toBe(1);
  expect(f.requests).toHaveLength(before);
  const approved = JSON.parse(
    await linkActionTool(args, {
      cwd: "/fixture",
      askUser: async () => {
        approvals++;
        return "允许执行";
      },
    } as unknown as ToolContext),
  );
  expect(approved).toMatchObject({
    kind: "error",
    provider: "github",
    action: "create_issue",
    error: "Verified writes require the owning Engine and tool authorization pipeline.",
  });
  expect(approvals).toBe(1);
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
    expect(provider.actions.length).toBe(providerId === "figma" ? 5 : 2);
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
