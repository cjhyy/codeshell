import { beforeAll as installHostFixture } from "bun:test";
import { installTestLinkProviders } from "../../../../../tests/helpers/link-providers.js";
installHostFixture(installTestLinkProviders);
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultCredentialAccess, type CredentialMetadata } from "../../credentials/access.js";
import { LOCAL_LINK_PROVIDERS } from "../../links/providers.js";
import { isFigmaMcpAction } from "@cjhyy/code-shell-link";
import { SettingsManager } from "../../settings/manager.js";
import type { ToolContext } from "../../tool-system/context.js";
import { listSourcesTool, readSourceTool } from "../../tool-system/builtin/sources.js";
import { bindSource } from "../binding.js";
import { saveSourceDefinition } from "../catalog.js";
import type { SourceDefinition } from "../types.js";
import { linkSourceAdapter } from "./link.js";
import { ToolExecutor } from "../../tool-system/executor.js";
import { ToolRegistry } from "../../tool-system/registry.js";
import { PermissionClassifier, type ApprovalBackend } from "../../tool-system/permission.js";
import { HookRegistry } from "../../hooks/registry.js";
import type { PermissionRule } from "../../types.js";
import { StreamingToolQueue } from "../../engine/streaming-tool-queue.js";
import { BUILTIN_TOOLS } from "../../tool-system/builtin/index.js";
import { isLinkSourceAvailable } from "../link-view.js";
import { RunToolSurface } from "../../tool-system/run-tool-surface.js";

let home: string;
let cwd: string;
let previousHome: string | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  previousHome = process.env.CODE_SHELL_HOME;
  home = mkdtempSync(join(tmpdir(), "codeshell-link-source-"));
  cwd = join(home, "workspace");
  mkdirSync(cwd);
  process.env.CODE_SHELL_HOME = home;
});
afterEach(() => {
  setDefaultCredentialAccess(null);
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
const context = () => ({ cwd, settingsScope: "full" }) as ToolContext;
async function read(
  args: Record<string, unknown>,
  ctx = context(),
  rules: PermissionRule[] = [],
  hooks = new HookRegistry(),
  approvalBackend?: ApprovalBackend,
) {
  const executor = new ToolExecutor(
    new ToolRegistry({ builtinTools: ["ReadSource", "LinkAction"] }),
    new PermissionClassifier(
      [
        ...rules,
        { tool: "ReadSource", decision: "allow" },
        { tool: "LinkAction", decision: "allow" },
      ],
      "default",
      approvalBackend,
    ),
    hooks,
  );
  executor.setContext(ctx);
  const result = await executor.executeSingle({
    id: "source-read-fixture",
    toolName: "ReadSource",
    args,
  });
  return String(result.isError ? `Error: ${result.error}` : result.result);
}
const fixtureResources: Record<string, { group: string; id: string }> = {
  github: { group: "repositories", id: "acme/approved" },
  gitlab: { group: "projects", id: "42" },
  sentry: { group: "organizations", id: "fixture-org" },
  vercel: { group: "projects", id: "prj_fixture" },
  slack: { group: "channels", id: "C123" },
  notion: { group: "pages", id: "12345678123412341234123456789abc" },
  linear: { group: "teams", id: "12345678-1234-1234-1234-123456789abc" },
  todoist: { group: "projects", id: "42" },
  airtable: { group: "bases", id: "app1234567890" },
  figma: { group: "files", id: "FixtureFile123" },
};

function fixtureParams(providerId: string, action: string): Record<string, unknown> {
  const id = fixtureResources[providerId].id;
  if (providerId === "github") {
    const repository = { owner: "acme", repo: "approved" };
    switch (action) {
      case "list_repositories":
        return { limit: 5 };
      case "get_repository":
      case "get_starred":
      case "get_readme":
        return repository;
      case "get_file":
        return { ...repository, path: "README.md" };
      case "get_issue":
        return { ...repository, issue_number: 1 };
      case "get_pull_request":
        return { ...repository, pull_number: 1 };
      case "list_pull_request_files":
      case "list_pull_request_commits":
        return { ...repository, pull_number: 1, limit: 5 };
      case "get_commit":
        return { ...repository, sha: "a".repeat(40), limit: 5 };
      default:
        return { ...repository, limit: 5 };
    }
  }
  if (providerId === "figma")
    return {
      file_key: id,
      ...(["get_nodes", "get_images"].includes(action) ? { ids: "1:2" } : {}),
    };
  if (providerId === "slack") {
    if (action === "get_message")
      return { permalink: `https://fixture.slack.com/archives/${id}/p1234567890123456` };
    if (action === "get_thread") return { channel: id, ts: "1234567890.123456", limit: 5 };
    if (action === "get_channel_history") return { channel: id, limit: 5 };
  }
  if (providerId === "notion" && action === "get_page") return { page_id: id };
  if (providerId === "sentry") return action === "list_projects" ? { organization: id } : {};
  if (providerId === "airtable") return action === "list_tables" ? { base_id: id } : {};
  return { limit: 5 };
}

function fixtureResult(providerId: string, action: string, value: string) {
  const id = fixtureResources[providerId].id;
  if (providerId === "github" && ["get_file", "get_readme"].includes(action))
    return { content: value, truncated: false };
  if (providerId === "github" && action === "get_starred") return { starred: false, value };
  if (providerId === "figma") {
    if (action === "get_file") return { pages: [{ name: value }], truncated: false };
    if (action === "read_design_content") return { document: { name: value } };
    if (action === "get_nodes") return { nodes: { "1:2": { name: value } } };
    if (action === "get_images") return { images: { "1:2": value } };
    if (action === "get_image_fills") return { meta: { images: { fixture: value } } };
    if (action === "get_comments") return { comments: [{ message: value }] };
  }
  const collection =
    action === "list_pull_request_files"
      ? "files"
      : action === "list_pull_request_commits"
        ? "commits"
        : action === "get_channel_history"
          ? "messages"
          : action === "search"
            ? "results"
            : action.startsWith("list_")
              ? action.slice("list_".length)
              : undefined;
  if (!collection) return { value };
  const identity =
    providerId === "github"
      ? { full_name: id }
      : providerId === "sentry"
        ? { slug: id }
        : (providerId === "gitlab" && action === "list_issues") ||
            (providerId === "todoist" && action === "list_tasks")
          ? { project_id: id }
          : providerId === "linear" && action === "list_issues"
            ? { team: { id } }
            : providerId === "vercel" && action === "list_deployments"
              ? { projectId: id }
              : { id };
  return { [collection]: [{ ...identity, value }] };
}

function definition(providerId = "github", action = "list_repositories"): SourceDefinition {
  return {
    id: "link-view",
    kind: "link",
    label: "Pinned view",
    enabled: true,
    credentialRef: "connection-1",
    adapterConfig: { providerId, action, params: fixtureParams(providerId, action) },
  };
}
function credential(providerId = "github", action = "list_repositories"): CredentialMetadata {
  return {
    id: "connection-1",
    type: "oauth",
    label: "Fixture account",
    hasSecret: true,
    oauthStatus: { state: "valid", hasRefreshToken: true },
    meta: {
      linkProvider: providerId,
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteState: "connected",
      linkRemoteGrantId: "grant-1",
      linkResourceGroups: [
        {
          id: fixtureResources[providerId].group,
          items: [{ id: fixtureResources[providerId].id, label: "Fixture selected resource" }],
        },
      ],
      linkCapabilityIds: [`${providerId}.${action}`],
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
    },
  };
}
function bind(def = definition()) {
  saveSourceDefinition(def);
  bindSource(new SettingsManager(cwd, "full"), cwd, {
    sourceId: def.id,
    scopes: [`${def.adapterConfig.providerId}:${def.adapterConfig.action}`],
    readPolicy: "ask",
  });
}

test("ReadSource's bound LinkAction remains permission-gated without loading its model schema", async () => {
  const meta = credential();
  let reads = 0;
  setDefaultCredentialAccess({
    listMasked: () => [meta],
    resolveMeta: () => meta,
    envExposures: () => ({}),
    executeRemoteLinkAction: async () => {
      reads++;
      return fixtureResult("github", "list_repositories", "bound fixture");
    },
  });
  bind();
  const registry = new ToolRegistry({ builtinTools: ["ReadSource", "LinkAction", "ToolSearch"] });
  const surface = new RunToolSurface(["ReadSource"]);
  surface.updateCatalog(registry.getToolDefinitions());
  const ctx = { ...context(), runToolSurface: surface, modelToolNames: new Set(["ReadSource"]) };
  const seen: string[] = [];
  const hooks = new HookRegistry();
  hooks.register("pre_tool_use", async (event) => {
    seen.push(event.data.toolName as string);
    return {};
  });
  const args = { source: "link-view", scope: "github:list_repositories", resource: "result" };
  expect(await read(args, ctx, [], hooks)).toContain("bound fixture");
  expect(surface.isSelected("LinkAction")).toBe(false);
  expect(seen).toEqual(["ReadSource", "LinkAction"]);
  expect(reads).toBe(1);
  expect(await read(args, ctx, [{ tool: "LinkAction", decision: "deny" }])).toContain("denied");
  expect(reads).toBe(1);
  expect(await read(args, { ...ctx, allowedToolNames: new Set(["ReadSource"]) })).toContain(
    "denied",
  );
  expect(reads).toBe(1);
});

test("all 10 providers/36 read actions reuse exact saved grant and caller credential scope, metadata does no IO", async () => {
  let calls = 0;
  for (const provider of LOCAL_LINK_PROVIDERS)
    // Remote grants cannot authorize the independent Host-owned Figma MCP channel.
    for (const action of provider.actions.filter(
      (item) => item.risk !== "write" && !(provider.id === "figma" && isFigmaMcpAction(item.id)),
    )) {
      const def = definition(provider.id, action.id);
      const meta = credential(provider.id, action.id);
      setDefaultCredentialAccess({
        listMasked: (_cwd, scope) => (scope === "full" ? [meta] : []),
        resolveMeta: (_cwd, id, scope) => (id === meta.id && scope === "full" ? meta : undefined),
        envExposures: () => ({}),
        resolveValue: async () => {
          throw new Error("Remote sources must never resolve secrets");
        },
        executeRemoteLinkAction: async (request) => {
          calls++;
          expect(request).toMatchObject({
            cwd,
            scope: "full",
            id: meta.id,
            grantId: "grant-1",
            action: action.id,
            params: fixtureParams(provider.id, action.id),
          });
          return fixtureResult(provider.id, action.id, `fixture ${provider.id}/${action.id}`);
        },
      });
      bind(def);
      const before = calls;
      expect(await listSourcesTool({}, context())).toContain(`${provider.id}:${action.id}`);
      expect(calls).toBe(before);
      const output = await read({
        source: def.id,
        scope: `${provider.id}:${action.id}`,
        resource: "result",
      });
      expect(output).toContain(`fixture ${provider.id}/${action.id}`);
      expect(output).toContain("untrusted");
    }
  expect(LOCAL_LINK_PROVIDERS).toHaveLength(10);
  expect(calls).toBe(36);
}, 30_000);

test.each(["http-token", "cli"] as const)(
  "%s Star source readiness requires an explicit saved read grant without resolving credentials",
  async (backend) => {
    const meta: CredentialMetadata = {
      ...credential(),
      type: "link",
      oauthStatus: undefined,
      meta: {
        linkProvider: "github",
        linkExecutionRuntime: "local",
        linkExecutionBackend: backend,
        linkAccountId: "42",
      },
    };
    let io = 0;
    setDefaultCredentialAccess({
      listMasked: () => [meta],
      resolveMeta: () => meta,
      envExposures: () => ({}),
      resolveValue: async () => {
        io++;
        throw new Error("Source readiness must not resolve credentials");
      },
    });
    for (const action of ["get_repository", "get_starred"]) {
      const def = definition("github", action);
      bind(def);
      for (const capabilities of [undefined, [], ["github.list_repositories"]]) {
        meta.meta!.linkCapabilityIds = capabilities;
        expect(isLinkSourceAvailable(def, context())).toBe(false);
        expect(await listSourcesTool({}, context())).toContain("unavailable");
      }
      meta.meta!.linkCapabilityIds = [`github.${action}`];
      expect(isLinkSourceAvailable(def, context())).toBe(true);
      expect(await listSourcesTool({}, context())).not.toContain("unavailable");
    }
    // Existing unscoped read bindings retain their previous readiness semantics.
    delete meta.meta!.linkCapabilityIds;
    expect(isLinkSourceAvailable(definition(), context())).toBe(true);
    expect(io).toBe(0);
  },
);

test("local GitHub view uses production LinkAction HTTP path and original link-purpose credential access", async () => {
  const meta: CredentialMetadata = {
    id: "connection-1",
    type: "link",
    label: "Local",
    hasSecret: true,
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: "local",
      linkExecutionBackend: "http-token",
      linkAccountId: "42",
    },
  };
  let calls = 0;
  setDefaultCredentialAccess({
    listMasked: () => [meta],
    resolveMeta: () => meta,
    envExposures: () => ({}),
    resolveValue: async (request) => {
      expect(request).toEqual({ cwd, id: meta.id, scope: "full", purpose: "link" });
      return "github_pat_private_fixture";
    },
  });
  globalThis.fetch = (async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://api.github.com/user/repos?per_page=5&sort=updated");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer github_pat_private_fixture",
    );
    return new Response(
      JSON.stringify([{ id: 1, full_name: "acme/readonly", description: "fixture content" }]),
    );
  }) as typeof fetch;
  bind();
  const output = await read({
    source: "link-view",
    scope: "github:list_repositories",
    resource: "result",
  });
  expect(calls).toBe(1);
  expect(output).toContain("acme/readonly");
  expect(output).not.toContain("github_pat_private_fixture");
});

test("wrong provider, missing capability, unavailable project credential, and write configuration fail closed before IO", async () => {
  const meta = credential();
  let calls = 0;
  setDefaultCredentialAccess({
    listMasked: (_cwd, scope) => (scope === "full" ? [meta] : []),
    resolveMeta: (_cwd, _id, scope) => (scope === "full" ? meta : undefined),
    envExposures: () => ({}),
    executeRemoteLinkAction: async () => {
      calls++;
      return {};
    },
  });
  bind();
  const args = { source: "link-view", scope: "github:list_repositories", resource: "result" };
  expect(await readSourceTool(args, { ...context(), settingsScope: "project" })).toContain(
    "unavailable",
  );
  meta.meta!.linkCapabilityIds = ["github.create_issue"];
  expect(await readSourceTool(args, context())).toContain("unavailable");
  meta.meta!.linkCapabilityIds = ["github.list_repositories"];
  meta.meta!.linkProvider = "figma";
  expect(await readSourceTool(args, context())).toContain("unavailable");
  expect(() => saveSourceDefinition(definition("github", "create_issue"))).toThrow("read-only");
  await expect(
    linkSourceAdapter.read(definition("github", "create_issue"), "result", {
      cwd,
      settingsScope: "full",
      maxBytes: 100,
    }),
  ).rejects.toThrow("read-only");
  expect(calls).toBe(0);
});

test("disconnect and source parameter replacement while Link IO awaits suppress external content", async () => {
  for (const mode of ["disconnect", "replace"]) {
    const meta = credential();
    setDefaultCredentialAccess({
      listMasked: () => [meta],
      resolveMeta: () => meta,
      envExposures: () => ({}),
      executeRemoteLinkAction: async () => {
        await Promise.resolve();
        if (mode === "disconnect") meta.hasSecret = false;
        else
          saveSourceDefinition({
            ...definition(),
            adapterConfig: {
              providerId: "github",
              action: "list_repositories",
              params: { limit: 6 },
            },
          });
        return fixtureResult("github", "list_repositories", "must not escape");
      },
    });
    bind();
    const output = await read({
      source: "link-view",
      scope: "github:list_repositories",
      resource: "result",
    });
    expect(output).toStartWith("Error:");
    expect(output).not.toContain("must not escape");
  }
});

test("ReadSource cannot bypass LinkAction hard deny, exact args deny, run surface, or capability disable", async () => {
  const meta = credential();
  let calls = 0;
  setDefaultCredentialAccess({
    listMasked: () => [meta],
    resolveMeta: () => meta,
    envExposures: () => ({}),
    executeRemoteLinkAction: async () => {
      calls++;
      return fixtureResult("github", "list_repositories", "secret fixture");
    },
  });
  bind();
  const args = { source: "link-view", scope: "github:list_repositories", resource: "result" };
  for (const argsPattern of [
    undefined,
    { provider: "github" },
    { action: "list_repositories" },
    { connectionId: "connection-1" },
  ]) {
    expect(
      await read(args, context(), [{ tool: "LinkAction", argsPattern, decision: "deny" }]),
    ).toContain("denied");
  }
  expect(await read(args, { ...context(), allowedToolNames: new Set(["ReadSource"]) })).toContain(
    "denied",
  );
  expect(await read(args, { ...context(), disabledBuiltins: new Set(["LinkAction"]) })).toContain(
    "denied",
  );
  expect(await readSourceTool(args, context())).toContain("authorization pipeline");
  expect(calls).toBe(0);
});

test("fixed view rejects hook rewrites and rechecks source authority after nested approval before IO", async () => {
  const meta = credential();
  let calls = 0;
  setDefaultCredentialAccess({
    listMasked: () => [meta],
    resolveMeta: () => meta,
    envExposures: () => ({}),
    executeRemoteLinkAction: async () => {
      calls++;
      return fixtureResult("github", "list_repositories", "must not escape");
    },
  });
  bind();
  const args = { source: "link-view", scope: "github:list_repositories", resource: "result" };
  const hooks = new HookRegistry();
  hooks.register("pre_tool_use", (event) =>
    event.data.toolName === "LinkAction"
      ? {
          updatedInput: {
            provider: "github",
            action: "create_issue",
            connectionId: meta.id,
            params: { title: "must not write" },
          },
        }
      : {},
  );
  expect(await read(args, context(), [], hooks)).toContain("denied");
  let approvals = 0;
  expect(
    await read(args, context(), [{ tool: "LinkAction", decision: "ask" }], new HookRegistry(), {
      requestApproval: async () => {
        approvals++;
        bindSource(new SettingsManager(cwd, "full"), cwd, {
          sourceId: "link-view",
          scopes: [],
          readPolicy: "ask",
        });
        return { approved: true };
      },
    }),
  ).toContain("denied");
  expect(approvals).toBe(1);
  expect(calls).toBe(0);
});

test("fixed view handler input has no nested references retained by hooks during credential resolution", async () => {
  const meta: CredentialMetadata = {
    id: "connection-1",
    type: "link",
    label: "Local",
    hasSecret: true,
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: "local",
      linkExecutionBackend: "http-token",
      linkAccountId: "42",
    },
  };
  let retainedParams: Record<string, unknown> | undefined;
  const hooks = new HookRegistry();
  hooks.register("on_tool_start", (event) => {
    if (event.data.toolName === "LinkAction")
      retainedParams = event.data.args.params as Record<string, unknown>;
    return {};
  });
  setDefaultCredentialAccess({
    listMasked: () => [meta],
    resolveMeta: () => meta,
    envExposures: () => ({}),
    resolveValue: async () => {
      await Promise.resolve();
      expect(retainedParams).toBeDefined();
      retainedParams!.owner = "different-owner";
      retainedParams!.repo = "different-private-repo";
      return "github_pat_private_fixture";
    },
  });
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify([{ number: 1, title: "Approved repository" }]));
  }) as typeof fetch;
  bind({
    ...definition("github", "list_issues"),
    adapterConfig: {
      providerId: "github",
      action: "list_issues",
      params: { owner: "acme", repo: "approved", limit: 5 },
    },
  });
  const output = await read(
    { source: "link-view", scope: "github:list_issues", resource: "result" },
    context(),
    [],
    hooks,
  );
  expect(urls).toEqual([
    "https://api.github.com/repos/acme/approved/issues?per_page=5&page=1&state=open",
  ]);
  expect(output).toContain("Approved repository");
});

test("nested Link execution completes inside the production single-slot sequential tool queue", async () => {
  const meta = credential();
  let inFlight = 0,
    maxConcurrency = 0,
    calls = 0;
  setDefaultCredentialAccess({
    listMasked: () => [meta],
    resolveMeta: () => meta,
    envExposures: () => ({}),
    executeRemoteLinkAction: async () => {
      calls++;
      maxConcurrency = Math.max(maxConcurrency, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return fixtureResult("github", "list_repositories", "sequential fixture");
    },
  });
  bind();
  // Core's queue has sequential unsafe calls rather than a numeric concurrency
  // option. Pin ReadSource into that real one-slot path for this regression.
  const registry = new ToolRegistry({
    builtinTools: ["ReadSource", "LinkAction"],
    toolCatalog: BUILTIN_TOOLS.map((tool) =>
      tool.definition.name === "ReadSource"
        ? { ...tool, definition: { ...tool.definition, isConcurrencySafe: false } }
        : tool,
    ),
  });
  const executor = new ToolExecutor(
    registry,
    new PermissionClassifier([
      { tool: "ReadSource", decision: "allow" },
      { tool: "LinkAction", decision: "allow" },
    ]),
    new HookRegistry(),
  );
  executor.setContext(context());
  executor.setSignal(AbortSignal.timeout(2_000));
  const queue = new StreamingToolQueue(executor);
  for (const id of ["source-one", "source-two"])
    queue.enqueue({
      id,
      toolName: "ReadSource",
      args: { source: "link-view", scope: "github:list_repositories", resource: "result" },
    });
  const results = await queue.drain();
  expect(results).toHaveLength(2);
  expect(
    results.every(
      (result) => !result.isError && String(result.result).includes("sequential fixture"),
    ),
  ).toBe(true);
  expect(calls).toBe(2);
  expect(maxConcurrency).toBe(1);
});

test.each(["grant", "client", "scope", "account"])(
  "replacing saved %s under the same connection ID during approval cannot change the approved view",
  async (changed) => {
    const meta = credential();
    let calls = 0;
    setDefaultCredentialAccess({
      listMasked: () => [meta],
      resolveMeta: () => meta,
      envExposures: () => ({}),
      executeRemoteLinkAction: async () => {
        calls++;
        return {};
      },
    });
    bind();
    const output = await read(
      { source: "link-view", scope: "github:list_repositories", resource: "result" },
      context(),
      [{ tool: "LinkAction", decision: "ask" }],
      new HookRegistry(),
      {
        requestApproval: async () => {
          if (changed === "grant") meta.meta!.linkRemoteGrantId = "different-grant";
          else if (changed === "account") meta.meta!.linkAccountId = "different-account";
          else if (changed === "client") meta.oauthStatus!.clientId = "different-client";
          else meta.oauthStatus!.scope = "different:scope";
          return { approved: true };
        },
      },
    );
    expect(output).toContain("denied");
    expect(calls).toBe(0);
  },
);

test("source readiness uses current OAuth metadata only and preserves legacy PAT/CLI compatibility", async () => {
  const meta: CredentialMetadata = {
    id: "connection-1",
    type: "link",
    label: "Local OAuth",
    hasSecret: true,
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: "local",
      linkAuthSource: "browser-oauth",
      linkOAuthState: "connected",
      linkCapabilityIds: ["github.list_repositories"],
      linkAccountId: "42",
    },
    oauthStatus: { state: "valid", hasRefreshToken: true, canRefresh: true },
  };
  let io = 0;
  setDefaultCredentialAccess({
    listMasked: () => [meta],
    resolveMeta: () => meta,
    envExposures: () => ({}),
    resolveValue: async () => {
      io++;
      throw new Error("Must not resolve metadata secret");
    },
    executeLocalOAuthLinkAction: async () => {
      io++;
      throw new Error("Must not refresh metadata");
    },
  });
  bind();
  for (const state of ["reconnect", "refreshing"] as const) {
    meta.meta!.linkOAuthState = state;
    expect(isLinkSourceAvailable(definition(), context())).toBe(false);
    expect(await listSourcesTool({}, context())).toContain("unavailable");
  }
  meta.meta!.linkOAuthState = "connected";
  for (const state of ["missing", "invalid"] as const) {
    meta.oauthStatus = { state, hasRefreshToken: true, canRefresh: true };
    expect(isLinkSourceAvailable(definition(), context())).toBe(false);
  }
  meta.oauthStatus = { state: "expired", hasRefreshToken: true, canRefresh: false };
  expect(isLinkSourceAvailable(definition(), context())).toBe(false);
  meta.oauthStatus = { state: "expired", hasRefreshToken: true, canRefresh: true };
  expect(isLinkSourceAvailable(definition(), context())).toBe(true);
  meta.oauthStatus = { state: "valid", hasRefreshToken: false, canRefresh: false };
  expect(isLinkSourceAvailable(definition(), context())).toBe(true);
  delete meta.oauthStatus;
  delete meta.meta!.linkAuthSource;
  delete meta.meta!.linkOAuthState;
  delete meta.meta!.linkCapabilityIds;
  expect(isLinkSourceAvailable(definition(), context())).toBe(true);
  meta.meta!.linkExecutionBackend = "cli";
  expect(isLinkSourceAvailable(definition(), context())).toBe(true);
  expect(io).toBe(0);
});
