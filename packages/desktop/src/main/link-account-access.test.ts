import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudAccountStore, SavedCloudAccount } from "./cloud-account-store.js";
import type { CaptureLinkAccountAccess } from "./link-account-access.js";
import type { NativeLinkAuthorizationInput } from "./remote-link-manager.js";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../../../../scripts/bun-test-completion.mjs";

if (process.env.CODESHELL_LINK_ACCOUNT_ACCESS_FIXTURE !== "1") {
  test("Desktop Link account leases and native IPC stay isolated from operator state", async () => {
    const root = mkdtempSync(join(tmpdir(), "link-account-access-suite-"));
    const report = join(root, "junit.xml");
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          fileURLToPath(import.meta.url),
          "--reporter",
          "junit",
          "--reporter-outfile",
          report,
        ],
        {
          env: {
            ...createBunTestEnvironment(process.env, root),
            CODESHELL_LINK_ACCOUNT_ACCESS_FIXTURE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`.trim());
      const completed = assertBunTestCompletion(report);
      expect(completed.tests).toBe(25);
      expect(completed.skipped).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
} else {
  const origin = "https://account.example";
  const issuer = "https://catalog.example";
  const cleanups: Array<() => void | Promise<void>> = [];
  const opened: NativeLinkAuthorizationInput[] = [];
  let closed = 0;
  let catalogRequests = 0;
  let deniedRequests = 0;
  let catalogGate: Promise<void> | undefined;
  let catalogEntered = () => {};
  const httpOrigins = new Set<string>();
  const originalFetch = globalThis.fetch;
  // Before Core imports: only a synthetic response for this exact catalog
  // endpoint is admitted. No actual provider, OAuth, or account network exists.
  globalThis.fetch = Object.assign(
    (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (
        httpOrigins.has(new URL(request.url).origin) &&
        new URL(request.url).pathname.startsWith("/api/v1/links/")
      )
        return originalFetch(request);
      if (request.url !== `${issuer}/api/v1/links/providers` || request.method !== "GET") {
        deniedRequests++;
        throw new Error("Link account fixture refuses uncontrolled network");
      }
      catalogRequests++;
      catalogEntered();
      await catalogGate;
      return Response.json({
        version: 1,
        providers: [
          {
            id: "github",
            actions: ["list_repositories"],
            scopes: ["github:list_repositories"],
            methods: [
              {
                id: "remote-link",
                authKind: "oauth",
                defaultAuthModeId: "browser",
                authModes: [{ id: "browser", kind: "redirect" }],
              },
            ],
          },
        ],
      });
    }) as typeof fetch,
    { preconnect: originalFetch.preconnect },
  );
  mock.module("electron", () => ({
    app: { isPackaged: false, once: () => {} },
    BrowserWindow: { fromWebContents: () => undefined },
    shell: {
      openExternal: async () => {
        throw new Error("Fixture must never open an external browser");
      },
    },
  }));
  mock.module("./remote-link-window.js", () => ({
    openNativeLinkAuthorization: async (input: NativeLinkAuthorizationInput) => {
      opened.push(input);
      return { close: () => closed++ };
    },
  }));
  mock.module("./desktop-logger.js", () => ({ dlog: () => {} }));
  const [
    { CredentialStore, PlaintextCipher },
    { createLinkService },
    accountAccess,
    accountModule,
  ] = await Promise.all([
    import("@cjhyy/code-shell-core"),
    import("@cjhyy/code-shell-server/links"),
    import("./link-account-access.js"),
    import("./cloud-account-manager.js"),
  ]);
  const { createLinkAccountAccess, requireLinkAccountAccess, linkAccountExecutionOptions } =
    accountAccess;
  const { CloudAccountManager } = accountModule;
  const { registerRemoteLinkIpc } = await import("./remote-link-ipc.js");
  const { createLinkHttp } = await import("../../../server/src/links/http.js");

  beforeEach(() => {
    process.env.CODE_SHELL_REMOTE_LINK_ISSUER = issuer;
    process.env.CODE_SHELL_REMOTE_LINK_CLIENT_ID = "fixture-client";
    process.env.CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN = "http://127.0.0.1:43827";
    opened.length = 0;
    closed = 0;
    catalogRequests = 0;
    deniedRequests = 0;
    catalogGate = undefined;
    catalogEntered = () => {};
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    expect(deniedRequests).toBe(0);
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  function grant(overrides: Partial<SavedCloudAccount> = {}): SavedCloudAccount {
    return {
      origin,
      account: { id: randomUUID(), username: "fixture" },
      sessionId: randomUUID(),
      accessToken: "a".repeat(43),
      refreshToken: "r".repeat(43),
      accessTokenExpiresAt: Date.now() + 600_000,
      refreshTokenExpiresAt: Date.now() + 86_400_000,
      kind: "account",
      audience: origin,
      ...overrides,
    };
  }
  function account(initial?: SavedCloudAccount, storageError = false) {
    let saved = initial;
    let next = initial ?? grant();
    const requests: string[] = [];
    const store = {
      load: () => {
        if (storageError) throw new Error("Synthetic account storage failure");
        return saved;
      },
      preflight: () => {},
      save: (value: SavedCloudAccount) => {
        saved = value;
      },
      forget: () => {
        saved = undefined;
      },
    } as unknown as CloudAccountStore;
    const manager = new CloudAccountManager({
      store,
      request: async (request) => {
        requests.push(request.path);
        if (request.path === "/api/v1/account/logout") return { ok: true };
        if (request.path === "/api/v1/account/login") return next;
        throw new Error("Unexpected synthetic account request");
      },
      openExternal: async () => {
        throw new Error("Account fixture cannot open a browser");
      },
      changed: () => {},
    });
    return {
      manager,
      capture: createLinkAccountAccess(manager),
      requests,
      login: async (value = grant()) => {
        next = value;
        return manager.signIn("login", {
          origin,
          username: "fixture",
          password: "synthetic-password-123456",
        });
      },
    };
  }
  class Contents extends EventEmitter {
    mainFrame = {};
    destroyed = false;
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit("destroyed");
    }
  }
  function ipc(captureAccount?: CaptureLinkAccountAccess) {
    const root = mkdtempSync(join(tmpdir(), "link-account-ipc-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const store = new CredentialStore(cwd);
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const sender = new Contents();
    const event = { sender, senderFrame: sender.mainFrame };
    const native = registerRemoteLinkIpc({
      ipcMain: { handle: (name, handler) => void handlers.set(name, handler) },
      requireRendererProjectPath: async (path) => {
        if (path !== cwd) throw new Error("Unexpected project");
        return cwd;
      },
      isMainWindow: (contents) => contents === (sender as any),
      withMutation: async (_path, write) => write(),
      onChanged: () => {},
      ...(captureAccount ? { captureAccount } : {}),
    });
    cleanups.push(() => {
      sender.destroy();
      rmSync(root, { recursive: true, force: true });
    });
    return {
      native,
      store,
      call: (name: string, ...args: unknown[]) => handlers.get(name)!(event, cwd, ...args),
      start: (mode = "remote-link", method = "remote-link") =>
        handlers.get("links:authorizationStart")!(
          event,
          cwd,
          randomUUID(),
          {
            providerId: "github",
            methodId: method,
            label: "Synthetic account-gated Link",
            expectedRevision: null,
          },
          mode,
        ),
    };
  }
  function savedRemote(store: InstanceType<typeof CredentialStore>) {
    const credential = {
      id: `saved-remote-${randomUUID()}`,
      type: "oauth" as const,
      label: "Preserved third-party grant",
      secret: JSON.stringify({
        version: 1,
        accessToken: "synthetic-provider-access",
        refreshToken: "synthetic-provider-refresh",
        expiresAt: "2099-01-01T00:00:00Z",
        issuer,
        clientId: "fixture-client",
      }),
      meta: {
        linkProvider: "github",
        linkConnectionMethod: "remote-link",
        linkExecutionRuntime: "server" as const,
        linkExecutionBackend: "remote" as const,
        linkRemoteState: "connected" as const,
        linkRemoteIssuer: issuer,
        linkRemoteConnectionId: randomUUID(),
        linkRemoteGrantId: randomUUID(),
        linkAccountId: "provider-account",
        linkCapabilityIds: ["github.list_repositories"],
        agentExposable: false,
      },
    };
    store.save("project", credential);
    return store.resolve(credential.id)!;
  }
  async function http(captureRemoteAuthority: CaptureLinkAccountAccess) {
    const root = mkdtempSync(join(tmpdir(), "link-account-http-"));
    const store = new CredentialStore(root, new PlaintextCipher(), join(root, "user"));
    const route = createLinkHttp({
      store,
      captureRemoteAuthority,
      ownerId: async () => "fixture-mobile-owner",
      isAuthorized: async () => true,
      remoteLink: () => ({
        issuer,
        clientId: "fixture-client",
        redirectUri: "http://127.0.0.1:43827/link/callback",
      }),
      onAuthorizationDiagnostic: () => {},
    });
    const server = createServer((request, response) => {
      if (request.headers.origin !== apiOrigin) {
        response.writeHead(403).end();
        return;
      }
      void route.handle(request, response).then((handled) => {
        if (!handled) response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const apiOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    httpOrigins.add(apiOrigin);
    cleanups.push(async () => {
      await route.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      httpOrigins.delete(apiOrigin);
      rmSync(root, { recursive: true, force: true });
    });
    const post = (path: string, body: unknown) =>
      fetch(apiOrigin + "/api/v1/links" + path, {
        method: "POST",
        headers: { origin: apiOrigin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return {
      store,
      post,
      start: (mode = "remote-link", method = "remote-link") =>
        post("/authorizations", {
          providerId: "github",
          methodId: method,
          authModeId: mode,
          label: "Synthetic mobile Link",
          expectedRevision: null,
        }),
    };
  }

  test("missing Host account authority fails closed", () => {
    expect(() => requireLinkAccountAccess()).toThrow("CodeShell");
    expect(() => linkAccountExecutionOptions(undefined)).toThrow("CodeShell");
  });
  test.each(["signed-out", "storage-error"] as const)(
    "%s accounts cannot capture a server Link lease",
    (state) => {
      const f = account(undefined, state === "storage-error");
      expect(f.manager.status().state).toBe(state);
      expect(() => f.capture()).toThrow();
      expect(f.requests).toEqual([]);
    },
  );
  test.each([
    { state: "signing-in", origin, account: { id: randomUUID() } },
    { state: "signed-in", account: { id: randomUUID() } },
    { state: "signed-in", origin },
    { state: "signed-in", origin, account: {} },
    { state: "signed-in", origin, account: { id: "" } },
  ])("partial account status %j cannot mint a lease", (status) => {
    let captures = 0;
    const capture = createLinkAccountAccess({
      status: () => status as any,
      captureRootAccount: (() => {
        captures++;
        return { signal: new AbortController().signal, current: () => {} };
      }) as any,
    });
    expect(() => capture()).toThrow();
    expect(captures).toBe(0);
  });
  test("real signed-in account lease can start a real remote Link job", async () => {
    const f = account(grant());
    const root = mkdtempSync(join(tmpdir(), "link-account-service-"));
    const store = new CredentialStore(root, new PlaintextCipher(), join(root, "user"));
    const service = createLinkService({
      store,
      remoteLink: () => ({
        issuer,
        clientId: "fixture-client",
        redirectUri: "http://127.0.0.1:43827/link/callback",
      }),
      readRemoteCatalog: async () => ["github"],
      onAuthorizationDiagnostic: () => {},
    });
    cleanups.push(async () => {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    });
    const lease = requireLinkAccountAccess(f.capture);
    const job = await service.startAuthorization(
      {
        ownerId: "fixture",
        signal: lease.signal,
        authorize: () => {
          lease.current();
          return true;
        },
      },
      {
        providerId: "github",
        methodId: "remote-link",
        label: "Synthetic remote Link",
        expectedRevision: null,
      },
      "remote-link",
    );
    expect(job).toMatchObject({ state: "pending", step: { kind: "redirect" } });
    expect(store.list()).toEqual([]);
    expect(f.requests).toEqual([]);
  });
  test("logout and same-identity login invalidate the original lease", async () => {
    const initial = grant();
    const f = account(initial);
    const old = f.capture();
    old.current();
    await f.manager.logout();
    expect(old.signal.aborted).toBe(true);
    expect(() => old.current()).toThrow();
    await f.login(grant({ account: initial.account }));
    expect(f.manager.status().account?.id).toBe(initial.account.id);
    expect(() => old.current()).toThrow();
    expect(() => f.capture().current()).not.toThrow();
  });
  test("execution options preserve caller authorization and cancellation", async () => {
    const f = account(grant());
    const caller = new AbortController();
    let checks = 0;
    let permitted = true;
    const options = linkAccountExecutionOptions(f.capture, {
      signal: caller.signal,
      assertAuthorized: () => {
        checks++;
        if (!permitted) throw new Error("Caller operation is no longer current");
      },
    });
    options.assertAuthorized();
    expect(checks).toBe(2);
    permitted = false;
    expect(options.assertAuthorized).toThrow("Caller operation");
    permitted = true;
    caller.abort();
    expect(options.signal.aborted).toBe(true);
    expect(options.assertAuthorized).toThrow();
    const accountBound = linkAccountExecutionOptions(f.capture);
    await f.manager.logout();
    expect(accountBound.signal.aborted).toBe(true);
    expect(accountBound.assertAuthorized).toThrow();
  });
  test.each(["missing", "signed-out", "storage-error"] as const)(
    "native remote authorization with %s account fails before discovery or browser launch",
    async (state) => {
      const f = account(undefined, state === "storage-error");
      const native = ipc(state === "missing" ? undefined : f.capture);
      const saved = savedRemote(native.store);
      await expect(native.start()).rejects.toThrow();
      expect(catalogRequests).toBe(0);
      expect(opened).toHaveLength(0);
      expect(native.store.resolve(saved.id)).toEqual(saved);
    },
  );
  test("native signed-in remote authorization keeps tokens out of IPC", async () => {
    const f = account(grant());
    const native = ipc(f.capture);
    const job = await native.start();
    expect(job).toMatchObject({ state: "pending", step: { kind: "redirect" } });
    expect(catalogRequests).toBe(1);
    expect(opened).toHaveLength(1);
    expect(JSON.stringify(job)).not.toContain("synthetic-provider");
    await f.manager.logout();
    for (let count = 0; count < 100 && closed === 0; count++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBeGreaterThan(0);
  });
  test("logout during native discovery prevents adoption without touching saved grants", async () => {
    const f = account(grant());
    const native = ipc(f.capture);
    const saved = savedRemote(native.store);
    const entered = deferred();
    const gate = deferred();
    catalogEntered = entered.resolve;
    catalogGate = gate.promise;
    const pending = native.start();
    await entered.promise;
    await f.manager.logout();
    gate.resolve();
    const result = await pending.catch(() => undefined);
    expect(result?.state).not.toBe("pending");
    expect(result?.state).not.toBe("connected");
    expect(opened).toHaveLength(0);
    expect(native.store.resolve(saved.id)).toEqual(saved);
  });
  test("old native OAuth jobs remain invalid after same-account login", async () => {
    const initial = grant();
    const f = account(initial);
    const native = ipc(f.capture);
    const saved = savedRemote(native.store);
    const job = await native.start();
    await f.manager.logout();
    await f.login(grant({ account: initial.account }));
    await expect(native.call("links:authorizationOpen", job.id)).rejects.toThrow();
    expect(native.store.resolve(saved.id)).toEqual(saved);
    expect(opened).toHaveLength(1);
  });
  test.each(["missing", "signed-out", "storage-error"] as const)(
    "local token authorization remains usable with %s CodeShell account",
    async (state) => {
      const f = account(undefined, state === "storage-error");
      const native = ipc(state === "missing" ? undefined : f.capture);
      const job = await native.start("token", "fine-grained-pat");
      expect(job).toMatchObject({ state: "pending", step: { kind: "credential-input" } });
      expect(catalogRequests).toBe(0);
      expect(opened).toHaveLength(0);
    },
  );

  test("GitHub account login may prepare OAuth before login without adopting a grant", async () => {
    const f = account();
    const native = ipc(f.capture);
    const saved = savedRemote(native.store);
    const abort = new AbortController();
    const prepared = await native.native.prepareGitHubLink(abort.signal, () => true);
    try {
      expect(f.manager.status().state).toBe("signed-out");
      expect(new URL(prepared.authorizationUrl).pathname).toBe("/oauth/authorize");
      expect(catalogRequests).toBeGreaterThan(0);
      expect(opened).toHaveLength(0);
      expect(native.store.resolve(saved.id)).toEqual(saved);
    } finally {
      prepared.cancel();
    }
  });

  test("mobile HTTP remote authorization rejects a signed-out Host before discovery", async () => {
    const f = account();
    const mobile = await http(f.capture);
    const saved = savedRemote(mobile.store);
    const response = await mobile.start();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "login_required" });
    expect(catalogRequests).toBe(0);
    expect(mobile.store.resolve(saved.id)).toEqual(saved);
  });

  test.each(["logout", "same-account-login"] as const)(
    "pending mobile remote OAuth refuses its old lease after %s",
    async (action) => {
      const initial = grant();
      const f = account(initial);
      const mobile = await http(f.capture);
      const saved = savedRemote(mobile.store);
      const started = await mobile.start();
      expect(started.status).toBe(200);
      const job = await started.json();
      expect(job).toMatchObject({ state: "pending", step: { kind: "redirect" } });
      const authorization = new URL(job.step.authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("code", "synthetic-code-never-exchanged");
      await f.manager.logout();
      if (action === "same-account-login") await f.login(grant({ account: initial.account }));
      const completed = await mobile.post(`/authorizations/${job.id}/complete`, {
        callbackUrl: callback.href,
      });
      expect(completed.status).toBe(401);
      expect(await completed.json()).toMatchObject({ code: "login_required" });
      expect(catalogRequests).toBe(1);
      expect(mobile.store.resolve(saved.id)).toEqual(saved);
      expect(mobile.store.list()).toHaveLength(1);
    },
  );

  test("mobile local token authorization never captures remote account authority", async () => {
    let captures = 0;
    const mobile = await http(() => {
      captures++;
      throw new Error("Remote account authority is deliberately unavailable");
    });
    const response = await mobile.start("token", "fine-grained-pat");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "pending",
      step: { kind: "credential-input" },
    });
    expect(captures).toBe(0);
    expect(catalogRequests).toBe(0);
  });
}
