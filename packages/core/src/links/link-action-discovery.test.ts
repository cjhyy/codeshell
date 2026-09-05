import { afterEach, describe, expect, test } from "bun:test";
import {
  setDefaultCredentialAccess,
  type CredentialAccessScope,
  type CredentialMetadata,
} from "../credentials/access.js";
import type { SettingsScope } from "../settings/manager.js";
import type { ToolContext } from "../tool-system/context.js";
import type { getCliLinkStatus } from "./cli.js";
import { linkActionTool } from "./link-action-tool.js";

const cwd = "/link-discovery-test";

function context(settingsScope: SettingsScope = "full"): ToolContext {
  return { cwd, settingsScope, signal: new AbortController().signal } as ToolContext;
}

function installAccess(full: CredentialMetadata[] = [], project: CredentialMetadata[] = []) {
  const state = { resolveCalls: 0, scopes: [] as CredentialAccessScope[] };
  setDefaultCredentialAccess({
    listMasked: (_cwd, scope) => {
      state.scopes.push(scope);
      return scope === "full" ? full : project;
    },
    resolveMeta: (_cwd, id, scope) =>
      (scope === "full" ? full : project).find((credential) => credential.id === id),
    envExposures: () => ({}),
    resolveValue: async () => {
      state.resolveCalls += 1;
      throw new Error("Discovery must not resolve a credential secret");
    },
  });
  return state;
}

function githubCredential(id: string, hasSecret: boolean): CredentialMetadata {
  return {
    id,
    type: "link",
    label: "GitHub local",
    hasSecret,
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: "local",
      linkExecutionBackend: "http-token",
      linkAccountLabel: "saved-account",
    },
  };
}

const unexpectedProbe: typeof getCliLinkStatus = async () => {
  throw new Error("This query must not inspect host CLI login");
};

afterEach(() => setDefaultCredentialAccess(null));

describe("LinkAction connection discovery", () => {
  test("discovers providers before any Link is saved without probing every CLI", async () => {
    const state = installAccess();
    const result = JSON.parse(await linkActionTool({}, context(), unexpectedProbe));

    expect(result.kind).toBe("providers");
    expect(result.notice).toBeString();
    expect(result.notice.length).toBeGreaterThan(0);
    expect(
      result.providers.find((provider: { id: string }) => provider.id === "github"),
    ).toMatchObject({ id: "github", connections: [], cliSupported: true });
    expect(
      result.providers.find((provider: { id: string }) => provider.id === "figma"),
    ).toMatchObject({ id: "figma", connections: [], cliSupported: false });
    expect(state.resolveCalls).toBe(0);
  });

  test("reports an authenticated CLI with no saved Link and no credential resolution", async () => {
    const state = installAccess();
    const ctx = context();
    let probes = 0;
    const probe: typeof getCliLinkStatus = async (providerId, options) => {
      probes += 1;
      expect(providerId).toBe("github");
      expect(options).toMatchObject({ cwd, signal: ctx.signal });
      return {
        providerId,
        command: "gh",
        installed: true,
        authenticated: true,
        account: "cli-account",
      };
    };
    const result = JSON.parse(await linkActionTool({ provider: "github" }, ctx, probe));

    expect(result).toMatchObject({
      kind: "provider_actions",
      connections: [],
      cli: { command: "gh", installed: true, authenticated: true, account: "cli-account" },
    });
    expect(result.actions ?? []).toHaveLength(0);
    expect(result.notice).toBeString();
    expect(probes).toBe(1);
    expect(state.resolveCalls).toBe(0);
  });

  test("keeps unreadable and expired or invalid saved Links visible without offering actions", async () => {
    const state = installAccess([
      githubCredential("unreadable", false),
      {
        ...githubCredential("expired", true),
        oauthStatus: { state: "expired", hasRefreshToken: true },
      },
      {
        ...githubCredential("invalid", true),
        oauthStatus: { state: "invalid", hasRefreshToken: false },
      },
    ]);
    const result = JSON.parse(await linkActionTool({}, context(), unexpectedProbe));
    const github = result.providers.find((provider: { id: string }) => provider.id === "github");

    expect(github.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "unreadable", state: "unavailable" }),
        expect.objectContaining({ id: "expired", state: "expired" }),
        expect.objectContaining({ id: "invalid", state: "invalid" }),
      ]),
    );
    expect(github.actions ?? []).toHaveLength(0);
    expect(state.resolveCalls).toBe(0);
  });

  test("identifies saved server OAuth separately from available local actions", async () => {
    const state = installAccess([
      {
        id: "figma-server",
        type: "oauth",
        label: "Figma server OAuth",
        hasSecret: true,
        meta: { linkProvider: "figma", linkExecutionRuntime: "server" },
      },
    ]);
    const result = JSON.parse(await linkActionTool({}, context(), unexpectedProbe));
    const figma = result.providers.find((provider: { id: string }) => provider.id === "figma");

    expect(figma.connections).toEqual([
      expect.objectContaining({ id: "figma-server", runtime: "server", backend: "oauth" }),
    ]);
    expect(figma.actions ?? []).toHaveLength(0);
    expect(state.resolveCalls).toBe(0);
  });

  test.each(["project", "isolated"] as const)(
    "%s scope never probes host CLI or lists user credentials",
    async (scope) => {
      const state = installAccess(
        [githubCredential("user-private-link", true)],
        [githubCredential("project-link", false)],
      );
      const raw = await linkActionTool({ provider: "github" }, context(scope), unexpectedProbe);
      const result = JSON.parse(raw);

      expect(result.cli).toMatchObject({ state: "skipped" });
      expect(result.cli.reason).toBeString();
      expect(result.connections).toEqual([
        expect.objectContaining({ id: "project-link", state: "unavailable" }),
      ]);
      expect(raw).not.toContain("user-private-link");
      expect(state.scopes.length).toBeGreaterThan(0);
      expect(state.scopes.every((accessScope) => accessScope === "project")).toBe(true);
      expect(state.resolveCalls).toBe(0);
    },
  );

  test("querying a provider without a supported CLI reports that the probe was skipped", async () => {
    installAccess();
    const result = JSON.parse(
      await linkActionTool({ provider: "figma" }, context(), unexpectedProbe),
    );

    expect(result).toMatchObject({
      kind: "provider_actions",
      connections: [],
      cli: { state: "skipped" },
    });
    expect(result.cli.reason).toBeString();
  });

  test("an action still requires a saved Link and cannot fall back to an unbound CLI", async () => {
    const state = installAccess();
    const result = JSON.parse(
      await linkActionTool(
        { provider: "github", action: "list_repositories" },
        context(),
        unexpectedProbe,
      ),
    );

    expect(result.kind).toBe("error");
    expect(result.error).toContain("No usable saved GitHub Link");
    expect(result.error).toContain("LinkAction");
    expect(state.resolveCalls).toBe(0);
  });
});
