import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Credential } from "../credentials/types.js";
import { asGlobalFetch } from "../testing/fetch-stub.js";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../../../../scripts/bun-test-completion.mjs";

const cases = [
  "fixture rejects outside fetch and socket requests before producer imports can escape",
  "remote refresh can finish after run revocation but sends no action",
  "one revoked caller does not poison another caller's shared remote rotation",
  "remote action results are discarded if the run is revoked during the response",
  "local OAuth rotation persists after revocation without sending the approved write",
  "unchanged local OAuth custody refreshes and sends its action successfully",
  "remote LinkAction refresh notifications preserve only unchanged authority",
  "remote LinkAction refresh notifications preserve only grant authority",
  "remote LinkAction refresh notifications preserve only reconnect authority",
  "concurrent remote LinkAction calls share a normal refresh without invalidating either run",
  "local OAuth read refresh cannot retry the action after its run was revoked",
  "local OAuth results are discarded when custody is lost during an action",
];
const caseName = process.env.CODESHELL_LINK_RUN_AUTHORITY_CASE;

if (process.env.CODESHELL_LINK_RUN_AUTHORITY_CHILD === "1" && caseName) {
  const runCase = (name: string, body: () => void | Promise<void>) => {
    if (name === caseName) test(name, body);
  };
  const runEach =
    <T extends string>(values: readonly T[]) =>
    (template: string, body: (value: T) => void | Promise<void>) => {
      for (const value of values) runCase(template.replace("%s", value), () => body(value));
    };
  let allowedPort = 0;
  let deniedNetwork = 0;
  const originalFetch = globalThis.fetch;
  const originalHttpExports = { ...(await import("node:http")) };
  const originalHttpsExports = { ...(await import("node:https")) };
  const originalHttp = http.request;
  const originalHttps = https.request;
  function assertLocal(url: URL) {
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      Number(url.port) !== allowedPort
    ) {
      deniedNetwork++;
      throw new Error("Link authority fixture denied outside network");
    }
  }
  globalThis.fetch = asGlobalFetch(async (input, init) => {
    assertLocal(new URL(input instanceof Request ? input.url : String(input)));
    return originalFetch(input, init);
  });
  http.request = function (...args: any[]) {
    assertLocal(new URL(String(args[0])));
    return originalHttp.apply(this, args as Parameters<typeof http.request>);
  } as typeof http.request;
  https.request = function (..._args: any[]) {
    deniedNetwork++;
    throw new Error("Link authority fixture denied outside network");
  } as typeof https.request;
  // Bun does not reliably synchronize builtin named imports after mutation.
  // Bind the guarded exits before producers load, preserving every other export.
  mock.module("node:http", () => ({
    ...originalHttpExports,
    default: http,
    request: http.request,
  }));
  mock.module("node:https", () => ({
    ...originalHttpsExports,
    default: https,
    request: https.request,
  }));

  // Import producers only after the exact-origin socket guard is installed.
  const { CredentialStore } = await import("../credentials/store.js");
  const { executeRemoteLinkAction } = await import("./remote.js");
  const { executeLocalOAuthLinkAction } = await import("./local-oauth.js");
  const { localCredentialAccess, setDefaultCredentialAccess } =
    await import("../credentials/access.js");
  const { linkActionTool } = await import("./link-action-tool.js");
  const clock = Date.parse("2026-10-15T12:00:00Z");
  const now = () => clock;
  const connectionId = "12345678-1234-1234-1234-123456789abc";
  const grantId = "12345678-1234-1234-1234-123456789def";
  let directory: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let issuer: string;
  let store: InstanceType<typeof CredentialStore>;
  let tokenWait: Promise<void> | undefined;
  let actionWait: Promise<void> | undefined;
  let tokenEntered: () => void;
  let actionEntered: () => void;
  let failFirstAction: boolean;
  let counts: { refresh: number; account: number; action: number };
  const releases: Array<() => void> = [];

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "codeshell-link-run-authority-"));
    store = new CredentialStore(directory, undefined, join(directory, "user"));
    tokenWait = undefined;
    actionWait = undefined;
    tokenEntered = () => {};
    actionEntered = () => {};
    failFirstAction = false;
    counts = { refresh: 0, account: 0, action: 0 };
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    server ??= Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.arrayBuffer();
        const path = new URL(request.url).pathname;
        if (path === "/oauth/token" || path === "/local/token") {
          counts.refresh++;
          tokenEntered();
          await tokenWait;
          return json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
            scope: path === "/oauth/token" ? "github:list_repositories" : "repo",
          });
        } else if (path === "/local/account") {
          counts.account++;
          return json({ id: 42, login: "fixture" });
        } else {
          counts.action++;
          actionEntered();
          await actionWait;
          if (failFirstAction && counts.action === 1) {
            return json({ message: "expired" }, 401);
          } else {
            return json(
              path.startsWith("/api/v1/")
                ? { result: [{ id: 1, full_name: "owner/repo" }] }
                : { number: 1, title: "fixture protected result" },
            );
          }
        }
      },
    });
    allowedPort = server.port!;
    issuer = `http://127.0.0.1:${allowedPort}`;
  });

  afterEach(async () => {
    setDefaultCredentialAccess(null);
    for (const release of releases.splice(0)) release();
    rmSync(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    try {
      expect(deniedNetwork).toBe(caseName === cases[0] ? 2 : 0);
    } finally {
      await server?.stop(true);
      allowedPort = 0;
      globalThis.fetch = originalFetch;
      http.request = originalHttp;
      https.request = originalHttps;
      mock.module("node:http", () => originalHttpExports);
      mock.module("node:https", () => originalHttpsExports);
    }
  });

  function authority() {
    let current = true;
    return {
      revoke: () => (current = false),
      assertAuthorized: () => {
        if (!current) throw new Error("trusted run was revoked");
      },
    };
  }
  function blockToken() {
    const entered = deferred();
    const release = deferred();
    tokenEntered = entered.resolve;
    tokenWait = release.promise;
    releases.push(release.resolve);
    return { entered: entered.promise, release: release.resolve };
  }
  function blockAction() {
    const entered = deferred();
    const release = deferred();
    actionEntered = entered.resolve;
    actionWait = release.promise;
    releases.push(release.resolve);
    return { entered: entered.promise, release: release.resolve };
  }
  function remote(expired = true, layer: "user" | "project" = "user") {
    const credential: Credential = {
      id: "remote",
      type: "oauth",
      label: "Remote fixture",
      secret: JSON.stringify({
        version: 1,
        accessToken: "initial-access",
        refreshToken: `remote-refresh-${directory}`,
        tokenType: "Bearer",
        clientId: "fixture-client",
        issuer,
        expiresAt: new Date(expired ? 0 : clock + 3600000).toISOString(),
        scope: "github:list_repositories",
      }),
      meta: {
        linkProvider: "github",
        linkExecutionRuntime: "server",
        linkExecutionBackend: "remote",
        linkRemoteIssuer: issuer,
        linkRemoteConnectionId: connectionId,
        linkRemoteGrantId: grantId,
        linkRemoteState: "connected",
        linkAccountId: "42",
        linkResourceLabels: ["owner/repo"],
        linkCapabilityIds: ["github.list_repositories"],
        linkLastVerifiedAt: "2026-10-15T00:00:00Z",
      },
    };
    store.save(layer, credential);
    return {
      id: "remote",
      scope: "full" as const,
      grantId,
      action: "list_repositories",
      params: {},
    };
  }
  function local(expired = true, write = true) {
    store.save("user", {
      id: "local",
      type: "link",
      label: "Local fixture",
      secret: JSON.stringify({
        version: 1,
        accessToken: "initial-access",
        refreshToken: `local-refresh-${directory}`,
        tokenType: "Bearer",
        clientId: "fixture-client",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        expiresAt: new Date(clock + (expired ? -1000 : 3600000)).toISOString(),
        scope: "repo",
      }),
      meta: {
        linkProvider: "github",
        linkExecutionRuntime: "local",
        linkExecutionBackend: "http-token",
        linkAuthSource: "browser-oauth",
        linkAccountId: "42",
        linkLastVerifiedAt: "2026-10-15T00:00:00Z",
        linkCapabilityIds: ["github.get_issue", "github.create_issue"],
      },
    });
    return {
      id: "local",
      scope: "full" as const,
      accountId: "42",
      verifiedAt: "2026-10-15T00:00:00Z",
      action: write ? "create_issue" : "get_issue",
      params: {
        owner: "owner",
        repo: "repo",
        ...(write ? { title: "fixture" } : { issue_number: 1 }),
      },
    };
  }
  const localFetch = asGlobalFetch(async (input, _init) => {
    const url = String(input);
    const path =
      url === "https://github.com/login/oauth/access_token"
        ? "/local/token"
        : url === "https://api.github.com/user"
          ? "/local/account"
          : url === "https://api.github.com/repos/owner/repo/issues" ||
              url === "https://api.github.com/repos/owner/repo/issues/1"
            ? "/local/action"
            : undefined;
    if (!path) throw new Error(`Unexpected fixture request: ${url}`);
    const target = new URL(path, issuer);
    assertLocal(target);
    // Local OAuth's injected fetch boundary uses detached in-memory Responses:
    // even an isolated Bun 1.3.11 process can crash on its HTTP 401/refresh path.
    // The real helper, store/CAS rotation and all await gates still run; remote
    // actions above retain their production transport over real loopback HTTP.
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === "/local/token") {
      counts.refresh++;
      tokenEntered();
      await tokenWait;
      return json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "repo",
      });
    }
    if (path === "/local/account") {
      counts.account++;
      return json({ id: 42, login: "fixture" });
    }
    counts.action++;
    actionEntered();
    await actionWait;
    return failFirstAction && counts.action === 1
      ? json({ message: "expired" }, 401)
      : json({ number: 1, title: "fixture protected result" });
  });

  runCase(
    "fixture rejects outside fetch and socket requests before producer imports can escape",
    async () => {
      await expect(fetch("https://outside.invalid/probe")).rejects.toThrow("denied outside");
      expect(() => https.request("https://outside.invalid/probe")).toThrow("denied outside");
    },
  );

  runCase("remote refresh can finish after run revocation but sends no action", async () => {
    const input = remote();
    const gate = authority();
    const blocked = blockToken();
    const pending = executeRemoteLinkAction(input, {
      store,
      now,
      assertAuthorized: gate.assertAuthorized,
    });
    await blocked.entered;
    gate.revoke();
    blocked.release();
    await expect(pending).rejects.toThrow("trusted run was revoked");
    expect(counts).toEqual({ refresh: 1, account: 0, action: 0 });
    expect(store.resolve("remote")?.meta?.linkRemoteState).toBe("connected");
    expect(JSON.parse(store.resolve("remote")!.secret).refreshToken).toBe("rotated-refresh");
  });

  runCase(
    "one revoked caller does not poison another caller's shared remote rotation",
    async () => {
      const input = remote();
      const gate = authority();
      const blocked = blockToken();
      const first = executeRemoteLinkAction(input, {
        store,
        now,
        assertAuthorized: gate.assertAuthorized,
      });
      await blocked.entered;
      const second = executeRemoteLinkAction(input, { store, now, assertAuthorized: () => {} });
      gate.revoke();
      blocked.release();
      await expect(first).rejects.toThrow("trusted run was revoked");
      expect(await second).toEqual({ repositories: [{ id: 1, full_name: "owner/repo" }] });
      expect(counts).toEqual({ refresh: 1, account: 0, action: 1 });
    },
  );

  runCase(
    "remote action results are discarded if the run is revoked during the response",
    async () => {
      const input = remote(false);
      const gate = authority();
      const blocked = blockAction();
      const pending = executeRemoteLinkAction(input, {
        store,
        now,
        assertAuthorized: gate.assertAuthorized,
      });
      await blocked.entered;
      gate.revoke();
      blocked.release();
      await expect(pending).rejects.toThrow("trusted run was revoked");
      expect(counts.action).toBe(1);
    },
  );

  runCase(
    "local OAuth rotation persists after revocation without sending the approved write",
    async () => {
      const input = local();
      const gate = authority();
      const blocked = blockToken();
      const pending = executeLocalOAuthLinkAction(input, {
        store,
        now,
        fetchImpl: localFetch,
        assertAuthorized: gate.assertAuthorized,
      });
      await blocked.entered;
      gate.revoke();
      blocked.release();
      await expect(pending).rejects.toThrow("trusted run was revoked");
      expect(counts).toEqual({ refresh: 1, account: 1, action: 0 });
      expect(store.resolve("local")?.meta?.linkOAuthState).toBe("connected");
      expect(JSON.parse(store.resolve("local")!.secret).refreshToken).toBe("rotated-refresh");
    },
  );

  runCase("unchanged local OAuth custody refreshes and sends its action successfully", async () => {
    const input = local();
    expect(
      await executeLocalOAuthLinkAction(input, {
        store,
        now,
        fetchImpl: localFetch,
        assertAuthorized: () => {},
      }),
    ).toEqual({ number: 1, title: "fixture protected result" });
    expect(counts).toEqual({ refresh: 1, account: 1, action: 1 });
  });

  runEach(["unchanged", "grant", "reconnect"] as const)(
    "remote LinkAction refresh notifications preserve only %s authority",
    async (change) => {
      remote(true, "project");
      let notify: (() => void) | undefined;
      setDefaultCredentialAccess({
        ...localCredentialAccess,
        subscribe(listener) {
          notify = listener;
          return () => {
            notify = undefined;
          };
        },
      });
      const blocked = blockToken();
      const pending = linkActionTool(
        { provider: "github", connectionId: "remote", action: "list_repositories", params: {} },
        {
          cwd: directory,
          settingsScope: "project",
        } as import("../tool-system/context.js").ToolContext,
      );
      await blocked.entered;
      expect(store.resolve("remote")?.meta?.linkRemoteState).toBe("refreshing");
      expect(notify).toBeDefined();
      if (change !== "unchanged") {
        const current = store.resolve("remote")!;
        store.save("project", {
          ...current,
          meta: {
            ...current.meta,
            ...(change === "grant"
              ? { linkRemoteGrantId: "replacement-grant" }
              : { linkRemoteState: "reconnect" as const }),
          },
        });
      }
      notify!();
      blocked.release();
      const result = JSON.parse(await pending);
      if (change === "unchanged") {
        expect(result.kind).toBe("action_result");
        expect(result.data).toEqual({ repositories: [{ id: 1, full_name: "owner/repo" }] });
        expect(counts).toEqual({ refresh: 1, account: 0, action: 1 });
      } else {
        expect(result.kind).toBe("error");
        expect(result.data).toBeUndefined();
        expect(counts).toEqual({ refresh: 1, account: 0, action: 0 });
      }
    },
  );

  runCase(
    "concurrent remote LinkAction calls share a normal refresh without invalidating either run",
    async () => {
      remote(true, "project");
      const listeners = new Set<() => void>();
      setDefaultCredentialAccess({
        ...localCredentialAccess,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      });
      const blocked = blockToken();
      const args = {
        provider: "github",
        connectionId: "remote",
        action: "list_repositories",
        params: {},
      };
      const ctx = {
        cwd: directory,
        settingsScope: "project",
      } as import("../tool-system/context.js").ToolContext;
      const first = linkActionTool(args, ctx);
      const second = linkActionTool(args, ctx);
      await blocked.entered;
      expect(listeners.size).toBe(2);
      for (const listener of listeners) listener();
      blocked.release();
      expect((await Promise.all([first, second])).map((result) => JSON.parse(result).kind)).toEqual(
        ["action_result", "action_result"],
      );
      expect(counts).toEqual({ refresh: 1, account: 0, action: 2 });
    },
  );

  runCase(
    "local OAuth read refresh cannot retry the action after its run was revoked",
    async () => {
      const input = local(false, false);
      const gate = authority();
      const blocked = blockToken();
      failFirstAction = true;
      const pending = executeLocalOAuthLinkAction(input, {
        store,
        now,
        fetchImpl: localFetch,
        assertAuthorized: gate.assertAuthorized,
      });
      await blocked.entered;
      gate.revoke();
      blocked.release();
      await expect(pending).rejects.toThrow("trusted run was revoked");
      expect(counts).toEqual({ refresh: 1, account: 1, action: 1 });
    },
  );

  runCase("local OAuth results are discarded when custody is lost during an action", async () => {
    const input = local(false);
    const gate = authority();
    const blocked = blockAction();
    const pending = executeLocalOAuthLinkAction(input, {
      store,
      now,
      fetchImpl: localFetch,
      assertAuthorized: gate.assertAuthorized,
    });
    await blocked.entered;
    gate.revoke();
    blocked.release();
    await expect(pending).rejects.toThrow("trusted run was revoked");
    expect(counts.action).toBe(1);
  });
} else if (process.env.CODESHELL_LINK_RUN_AUTHORITY_CHILD === "1") {
  for (const name of cases) {
    test(name, () => runConfinedChild(name), 20_000);
  }
} else {
  test("confined Link run authority child completes all 12 regressions", async () => {
    await runConfinedChild();
    console.log("Independent Link run authority JUnit: 12 tests, 0 skipped, 0 failures.");
  }, 30_000);
}

async function runConfinedChild(name?: string) {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-link-authority-child-"));
  const report = join(directory, "junit.xml");
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Use the guarded runner's HOME/credential isolation and complete-JUnit
    // contract, as operation-reconcile.test.ts does for its HTTP fixture.
    // Suite and case children never inherit the parent's native HTTP state.
    // Each exact case reports one executed test, with no skipped tests; the
    // suite child reports and validates all twelve executed case wrappers.
    child = spawn(
      realpathSync(process.execPath),
      [
        "test",
        "--timeout",
        "30000",
        fileURLToPath(import.meta.url),
        "--reporter",
        "junit",
        "--reporter-outfile",
        report,
      ],
      {
        env: {
          ...createBunTestEnvironment(process.env, directory),
          CODESHELL_LINK_RUN_AUTHORITY_CHILD: "1",
          ...(name ? { CODESHELL_LINK_RUN_AUTHORITY_CASE: name } : {}),
        },
        stdio: "inherit",
      },
    );
    timer = setTimeout(() => child?.kill("SIGKILL"), name ? 15_000 : 25_000);
    const result = await new Promise((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(result).toEqual({ code: 0, signal: null });
    const summary = assertBunTestCompletion(report);
    expect(summary).toEqual({ tests: name ? 1 : cases.length, skipped: 0 });
  } finally {
    clearTimeout(timer);
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
}
