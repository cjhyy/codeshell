import { describe, expect, test } from "bun:test";
import type { CredentialAccess, CredentialMetadata } from "../credentials/access.js";
import type { CliLinkProviderId, CliLinkStatus } from "./cli.js";
import { getLinkStatus } from "./status.js";

function saved(overrides: Partial<CredentialMetadata> = {}): CredentialMetadata {
  return {
    id: "link-github-cli",
    type: "link",
    label: "GitHub",
    hasSecret: true,
    secretHint: "****tail",
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: "local",
      linkExecutionBackend: "cli",
      linkAccountId: "42",
      linkAccountLabel: "octocat",
      linkLastVerifiedAt: "2026-09-05T00:00:00.000Z",
      appUrl: "https://example.test/?token=not-for-the-agent",
    },
    ...overrides,
  };
}

function access(credentials: CredentialMetadata[]): Pick<CredentialAccess, "listMasked"> {
  return { listMasked: () => credentials };
}

function loggedIn(providerId: CliLinkProviderId): CliLinkStatus {
  return { providerId, command: "gh", installed: true, authenticated: true, account: "octocat" };
}

describe("Link status", () => {
  test("discovers a working CLI when no Link credentials were registered", async () => {
    const result = await getLinkStatus(
      { provider: " GitHub " },
      { credentialAccess: access([]), getCliStatus: async (id) => loggedIn(id) },
    );
    expect(result.credentialStore.state).toBe("checked");
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({
      id: "github",
      connections: [],
      cli: { state: "checked", installed: true, authenticated: true, account: "octocat" },
    });
    expect(result.guidance).toContain("without a usable saved Link");
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
  });

  test("retains unreadable saved credentials alongside a working CLI without exposing hints", async () => {
    const result = await getLinkStatus(
      { provider: "github" },
      {
        credentialAccess: access([saved({ hasSecret: false })]),
        getCliStatus: async (id) => loggedIn(id),
      },
    );
    expect(result.providers[0]?.connections).toEqual([
      {
        id: "link-github-cli",
        account: "octocat",
        backend: "cli",
        runtime: "local",
        verifiedAt: "2026-09-05T00:00:00.000Z",
        state: "unavailable",
        reason: "Saved credential is missing or cannot be read. Reconnect this Link.",
      },
    ]);
    expect(result.providers[0]?.cli).toMatchObject({ authenticated: true });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("****tail");
    expect(serialized).not.toContain("secretHint");
    expect(serialized).not.toContain("appUrl");
    expect(serialized).not.toContain("not-for-the-agent");
    expect(serialized).not.toContain("linkAccountId");
  });

  test("reports saved OAuth expiry and invalid records without returning diagnostic payloads", async () => {
    const result = await getLinkStatus(
      { provider: "github", probeCli: false },
      {
        credentialAccess: access([
          saved({ id: "expired", oauthStatus: { state: "expired", error: "private-error-body" } }),
          saved({ id: "invalid", oauthStatus: { state: "invalid", error: "private-error-body" } }),
          saved({ id: "missing", oauthStatus: { state: "missing" } }),
          saved({ id: "unreadable-expired", hasSecret: false, oauthStatus: { state: "expired" } }),
        ]),
      },
    );
    expect(result.providers[0]?.connections.map((connection) => connection.state)).toEqual([
      "expired",
      "invalid",
      "unavailable",
      "unavailable",
    ]);
    expect(JSON.stringify(result)).not.toContain("private-error-body");
  });

  test("reports incomplete local bindings without misclassifying valid server connections", async () => {
    const original = saved();
    const result = await getLinkStatus(
      { provider: "github", probeCli: false },
      {
        credentialAccess: access([
          saved({ id: "unbound", meta: { ...original.meta, linkAccountId: undefined } }),
          saved({ id: "server", meta: { ...original.meta, linkExecutionRuntime: "server" } }),
          saved({
            id: "legacy-local",
            meta: { ...original.meta, linkExecutionRuntime: undefined },
          }),
          saved({ id: "ready" }),
          { id: "ordinary", type: "token", label: "github", hasSecret: true },
        ]),
      },
    );
    expect(result.providers[0]?.connections.map((connection) => connection.state)).toEqual([
      "invalid",
      "ready",
      "unavailable",
      "ready",
    ]);
    expect(result.guidance).toContain("stored metadata, not live token validity");
    expect(result.providers[0]?.connections[2]?.reason).toContain("no execution runtime");
  });

  test("includes server OAuth Link entries and preserves their authorization state", async () => {
    const oauth = (id: string, state: "valid" | "expired" | "invalid"): CredentialMetadata => ({
      id,
      type: "oauth",
      label: "Figma MCP",
      hasSecret: true,
      oauthStatus: { state, error: "private-diagnostic-payload" },
      meta: {
        oauthProvider: "figma",
        mcpServerName: "figma",
        mcpServerUrl: "https://example.test/?token=private-query-token",
      },
    });
    const result = await getLinkStatus(
      { provider: "figma", probeCli: false },
      {
        credentialAccess: access([
          oauth("figma-oauth", "valid"),
          oauth("figma-expired", "expired"),
          oauth("figma-invalid", "invalid"),
          { ...oauth("figma-unreadable", "valid"), hasSecret: false },
          { ...oauth("unrelated-mcp", "valid"), meta: { oauthProvider: "unrelated-mcp" } },
        ]),
      },
    );
    expect(
      result.providers[0]?.connections.map(({ state, runtime, backend }) => ({
        state,
        runtime,
        backend,
      })),
    ).toEqual([
      { state: "ready", runtime: "server", backend: "oauth" },
      { state: "expired", runtime: "server", backend: "oauth" },
      { state: "invalid", runtime: "server", backend: "oauth" },
      { state: "unavailable", runtime: "server", backend: "oauth" },
    ]);
    expect(result.guidance).toContain("server/MCP tools");
    expect(JSON.stringify(result)).not.toContain("private-diagnostic-payload");
    expect(JSON.stringify(result)).not.toContain("private-query-token");
  });

  test("matches legacy OAuth provider IDs without inferring unrelated credentials", async () => {
    const result = await getLinkStatus(
      { provider: "figma", probeCli: false },
      {
        credentialAccess: access([
          { id: "figma-oauth", type: "oauth", label: "Figma", hasSecret: true },
          { id: "figma-oauth", type: "token", label: "Figma", hasSecret: true },
          { id: "unrelated", type: "oauth", label: "Figma", hasSecret: true },
        ]),
      },
    );
    expect(result.providers[0]?.connections).toEqual([
      { id: "figma-oauth", backend: "oauth", runtime: "server", state: "ready" },
    ]);
  });

  test("reports missing CLIs and rejected authentication separately", async () => {
    const result = await getLinkStatus(
      {},
      {
        credentialAccess: access([]),
        getCliStatus: async (id) => ({
          providerId: id,
          command: id === "github" ? "gh" : "glab",
          installed: id !== "github",
          authenticated: false,
          message: "not logged in; token=arbitrary-secret-value",
        }),
      },
    );
    expect(result.providers.find((provider) => provider.id === "github")?.cli).toMatchObject({
      installed: false,
      message: "gh is not installed",
    });
    expect(result.providers.find((provider) => provider.id === "gitlab")?.cli).toMatchObject({
      installed: true,
      authenticated: false,
      message: "CLI authentication was not accepted. Check the CLI account or reconnect this Link.",
    });
    expect(JSON.stringify(result)).not.toContain("arbitrary-secret-value");
  });

  test("does not mistake a network failure for a signed-out account", async () => {
    const result = await getLinkStatus(
      { provider: "github" },
      {
        credentialAccess: access([]),
        getCliStatus: async (id) => ({
          ...loggedIn(id),
          authenticated: false,
          message: "network request failed: Bearer arbitrary-private-value",
        }),
      },
    );
    expect(result.providers[0]?.cli).toMatchObject({
      message: "CLI status check could not reach the provider; login state could not be confirmed.",
    });
    expect(JSON.stringify(result)).not.toContain("arbitrary-private-value");
  });

  test.each(["project", "isolated"] as const)("%s scope never probes host CLIs", async (scope) => {
    let checks = 0;
    let seenScope: unknown;
    const result = await getLinkStatus(
      { provider: "github", cwd: "/repo", settingsScope: scope },
      {
        credentialAccess: {
          listMasked(cwd, scope) {
            expect(cwd).toBe("/repo");
            seenScope = scope;
            return [];
          },
        },
        getCliStatus: async (id) => {
          checks += 1;
          return loggedIn(id);
        },
      },
    );
    expect(seenScope).toBe("project");
    expect(checks).toBe(0);
    expect(result.providers[0]?.cli).toMatchObject({ state: "skipped", reasonCode: "scope" });
  });

  test("enumerates the entire catalog and respects explicitly disabled CLI checks", async () => {
    let checks = 0;
    const result = await getLinkStatus(
      { probeCli: false },
      {
        credentialAccess: access([]),
        getCliStatus: async (id) => {
          checks += 1;
          return loggedIn(id);
        },
      },
    );
    expect(result.providers).toHaveLength(10);
    expect(checks).toBe(0);
    expect(result.providers.find((provider) => provider.id === "github")?.cli).toMatchObject({
      state: "skipped",
      reasonCode: "disabled",
    });
    expect(result.providers.find((provider) => provider.id === "figma")?.cli).toMatchObject({
      state: "skipped",
      reasonCode: "unsupported",
    });
  });

  test("preserves store failures as unknown while still checking the CLI", async () => {
    const result = await getLinkStatus(
      { provider: "github" },
      {
        credentialAccess: {
          listMasked: () => {
            throw new Error("decrypt secret=never-output");
          },
        },
        getCliStatus: async (id) => loggedIn(id),
      },
    );
    expect(result.credentialStore).toMatchObject({ state: "error" });
    expect(result.credentialStore.reason).toContain("unknown");
    expect(result.providers[0]?.cli).toMatchObject({ authenticated: true });
    expect(JSON.stringify(result)).not.toContain("never-output");
  });

  test("does not leak thrown CLI errors", async () => {
    const result = await getLinkStatus(
      { provider: "github" },
      {
        credentialAccess: access([]),
        getCliStatus: async () => {
          throw new Error("unexpected arbitrary-token-material");
        },
      },
    );
    expect(result.providers[0]?.cli).toMatchObject({ state: "error" });
    expect(JSON.stringify(result)).not.toContain("arbitrary-token-material");
  });

  test("reports unreadable store diagnostics while preserving records from readable scopes", async () => {
    const result = await getLinkStatus(
      { provider: "github", cwd: "/repo", settingsScope: "full", probeCli: false },
      {
        credentialAccess: {
          listMasked() {
            throw new Error("legacy fallback must not be called");
          },
          listMaskedWithStatus(cwd, scope) {
            expect(cwd).toBe("/repo");
            expect(scope).toBe("full");
            return { credentials: [saved()], readable: false };
          },
        },
      },
    );
    expect(result.credentialStore).toMatchObject({ state: "error" });
    expect(result.credentialStore.reason).toContain("unknown");
    expect(result.providers[0]?.connections).toHaveLength(1);
    expect(result.providers[0]?.connections[0]?.state).toBe("ready");
  });

  test("accepts healthy empty store diagnostics without a legacy fallback", async () => {
    const result = await getLinkStatus(
      { provider: "github", probeCli: false },
      {
        credentialAccess: {
          listMasked() {
            throw new Error("legacy fallback must not be called");
          },
          listMaskedWithStatus: () => ({ credentials: [], readable: true }),
        },
      },
    );
    expect(result.credentialStore.state).toBe("checked");
    expect(result.providers[0]?.connections).toEqual([]);
  });

  test("rejects unknown providers before accessing credentials or CLIs", async () => {
    await expect(
      getLinkStatus(
        { provider: "unknown" },
        {
          credentialAccess: {
            listMasked: () => {
              throw new Error("must not read");
            },
          },
        },
      ),
    ).rejects.toThrow("Unknown local Link provider: unknown");
  });

  test("bounds parallel CLI checks and passes workspace and cancellation signal", async () => {
    let running = 0;
    let maximum = 0;
    let checks = 0;
    const signal = new AbortController().signal;
    await getLinkStatus(
      { cwd: "/repo", settingsScope: "full", signal },
      {
        credentialAccess: access([]),
        getCliStatus: async (id, options) => {
          expect(options).toEqual({ cwd: "/repo", signal });
          checks += 1;
          running += 1;
          maximum = Math.max(maximum, running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          running -= 1;
          return loggedIn(id);
        },
      },
    );
    expect(checks).toBe(5);
    expect(maximum).toBe(3);
  });

  test("propagates cancellation even when the CLI adapter catches abort as failed authentication", async () => {
    const controller = new AbortController();
    await expect(
      getLinkStatus(
        { provider: "github", signal: controller.signal },
        {
          credentialAccess: access([]),
          getCliStatus: async (id) => {
            controller.abort("private-abort-details");
            return { ...loggedIn(id), authenticated: false, message: "aborted" };
          },
        },
      ),
    ).rejects.toThrow("Link status check cancelled");
  });
});
