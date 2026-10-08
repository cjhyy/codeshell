import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultCredentialAccess, type CredentialMetadata } from "../../credentials/access.js";
import { LOCAL_LINK_PROVIDERS } from "../../links/providers.js";
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
function definition(providerId = "github", action = "list_repositories"): SourceDefinition {
  return {
    id: "link-view",
    kind: "link",
    label: "Pinned view",
    enabled: true,
    credentialRef: "connection-1",
    adapterConfig: { providerId, action, params: { limit: 5 } },
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

test("all 10 providers/27 read actions reuse exact saved grant and caller credential scope, metadata does no IO", async () => {
  let calls = 0;
  for (const provider of LOCAL_LINK_PROVIDERS)
    for (const action of provider.actions.filter((item) => item.risk !== "write")) {
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
            params: { limit: 5 },
          });
          return { value: `fixture ${provider.id}/${action.id}` };
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
  expect(calls).toBe(27);
}, 30_000);

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
        return { value: "must not escape" };
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
      return { value: "secret fixture" };
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
      return { value: "must not escape" };
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
  expect(urls).toEqual(["https://api.github.com/repos/acme/approved/issues?per_page=5"]);
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
      return { value: "sequential fixture" };
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
