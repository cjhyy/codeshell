import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Credential } from "../credentials/types.js";
import type { RemoteLinkExecutionDiagnostic } from "./remote.js";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../../../../scripts/bun-test-completion.mjs";

if (process.env.CODESHELL_REFRESH_CLASSIFICATION_CHILD === "1") {
  let port = 0;
  const originalHttp = http.request;
  const originalFetch = globalThis.fetch;
  const httpExports = { ...(await import("node:http")) };
  const httpsExports = { ...(await import("node:https")) };
  const assertOrigin = (value: string | URL) => {
    const url = new URL(value);
    if (url.origin !== `http://127.0.0.1:${port}`)
      throw new Error("Refresh fixture denied outside network");
  };
  http.request = function (...args: any[]) {
    assertOrigin(String(args[0]));
    return originalHttp.apply(this, args as Parameters<typeof http.request>);
  } as typeof http.request;
  https.request = function () {
    throw new Error("Refresh fixture denied outside network");
  } as typeof https.request;
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      assertOrigin(input instanceof Request ? input.url : input);
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  // Bind named builtin exits before any producer imports. This child confines
  // its module mocks and isolated application HOME to this one fixture suite.
  mock.module("node:http", () => ({ ...httpExports, default: http, request: http.request }));
  mock.module("node:https", () => ({ ...httpsExports, default: https, request: https.request }));
  const { CredentialStore } = await import("../credentials/store.js");
  const { PlaintextCipher } = await import("../credentials/cipher.js");
  const { executeRemoteLinkAction } = await import("./remote.js");
  let directory: string;
  let server: ReturnType<typeof http.createServer>;
  let store: InstanceType<typeof CredentialStore>;
  let credential: Credential;
  let status: number;
  let errorBody: unknown;
  let drop: boolean;
  let refreshes: number;
  let actions: number;
  let consumed: boolean;
  let diagnostic: RemoteLinkExecutionDiagnostic[];
  const grantId = "12345678-1234-1234-1234-123456789def";
  const input = {
    id: "selected",
    scope: "full" as const,
    grantId,
    action: "list_repositories",
    params: {},
  };
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "refresh-rejection-"));
    status = 400;
    errorBody = { error: "invalid_request", message: "PRIVATE-UPSTREAM-TEXT" };
    drop = false;
    refreshes = actions = 0;
    consumed = false;
    diagnostic = [];
    server = http.createServer(async (req, res) => {
      for await (const _part of req) {
        /* Consume the request before replying. */
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth/token") {
        refreshes++;
        // Models the broker's rotating refresh order: invalid_scope may be
        // returned after revokeToken, unlike pre-consumption client rejection.
        if (drop || (errorBody as { error?: string })?.error === "invalid_scope") consumed = true;
        if (drop) {
          req.socket.destroy();
          return;
        }
        res.statusCode = status;
        res.end(JSON.stringify(errorBody));
      } else {
        actions++;
        res.end(JSON.stringify({ result: [{ full_name: "owner/repo" }] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    const issuer = `http://127.0.0.1:${port}`;
    store = new CredentialStore(undefined, new PlaintextCipher(), directory);
    credential = {
      id: "selected",
      type: "oauth",
      label: "Synthetic connection",
      secret: JSON.stringify({
        version: 1,
        accessToken: "synthetic-access",
        refreshToken: `synthetic-refresh-${directory}`,
        tokenType: "Bearer",
        clientId: "synthetic-client",
        issuer,
        expiresAt: new Date(0).toISOString(),
        scope: "github:list_repositories",
      }),
      meta: {
        linkProvider: "github",
        linkExecutionBackend: "remote",
        linkExecutionRuntime: "server",
        linkRemoteState: "connected",
        linkRemoteIssuer: issuer,
        linkRemoteConnectionId: "12345678-1234-1234-1234-123456789abc",
        linkRemoteGrantId: grantId,
        linkAccountId: "synthetic-account",
        linkResourceLabels: ["owner/repo"],
        linkCapabilityIds: ["github.list_repositories"],
      },
    };
    store.save("user", credential);
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    port = 0;
    rmSync(directory, { recursive: true, force: true });
  });
  const execute = () =>
    executeRemoteLinkAction(input, { store, onDiagnostic: (event) => diagnostic.push(event) });
  test("socket and fetch guards reject external requests", () => {
    expect(() => http.request("http://127.0.0.1:1")).toThrow("denied outside network");
    expect(() => https.request("https://example.invalid")).toThrow("denied outside network");
    expect(() => fetch("https://example.invalid")).toThrow("denied outside network");
  });
  test.each([
    [400, "invalid_request"],
    [400, "invalid_client"],
    [401, "invalid_client"],
    [400, "unauthorized_client"],
    [400, "unsupported_grant_type"],
  ] as const)(
    "refresh %s %s preserves the unconsumed credential and can recover",
    async (code, rejection) => {
      status = code;
      errorBody = { error: rejection, message: "PRIVATE-UPSTREAM-TEXT" };
      await expect(execute()).rejects.toMatchObject({
        code: "configuration_error",
        httpStatus: code,
        brokerErrorCode: rejection,
      });
      expect(store.resolve(input.id)).toEqual(credential);
      expect(consumed).toBe(false);
      expect(refreshes).toBe(1);
      expect(actions).toBe(0);
      expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE-UPSTREAM-TEXT");
      status = 200;
      errorBody = {
        access_token: "replacement-access",
        refresh_token: "replacement-refresh",
        expires_in: 900,
        token_type: "Bearer",
        scope: "github:list_repositories",
      };
      await expect(execute()).resolves.toHaveProperty("repositories");
      expect(refreshes).toBe(2);
      expect(actions).toBe(1);
    },
  );
  test.each(["invalid_grant", "grant_revoked", "connection_revoked"] as const)(
    "refresh %s persists definite revocation without replay",
    async (rejection) => {
      errorBody = { error: rejection };
      await expect(execute()).rejects.toMatchObject({
        code: "reconnect",
        brokerErrorCode: rejection,
      });
      expect(store.resolve(input.id)?.meta?.linkRemoteState).toBe("reconnect");
      await expect(execute()).rejects.toMatchObject({ code: "reconnect" });
      expect(refreshes).toBe(1);
      expect(actions).toBe(0);
    },
  );
  test.each([
    [400, { error: "invalid_scope" }],
    [400, { error: "unreviewed-code", message: "PRIVATE-UPSTREAM-TEXT" }],
    [400, { error: "invalid_request", oversized: "PRIVATE".repeat(1000) }],
    [500, { error: "invalid_request" }],
    [200, { access_token: "replacement-without-valid-rotation" }],
  ] as const)(
    "refresh status %s with uncertain consumption is never replayed",
    async (code, body) => {
      status = code;
      errorBody = body;
      await expect(execute()).rejects.toMatchObject({ code: "refresh_outcome_unknown" });
      if (body.error === "invalid_scope") expect(consumed).toBe(true);
      expect(store.resolve(input.id)?.meta?.linkRemoteState).toBe("reconnect");
      await expect(execute()).rejects.toMatchObject({ code: "reconnect" });
      expect(refreshes).toBe(1);
      expect(actions).toBe(0);
      expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
      expect(JSON.stringify(diagnostic)).not.toContain("unreviewed-code");
    },
  );
  test("a lost refresh response retains the consumed marker across a reopened store", async () => {
    drop = true;
    await expect(execute()).rejects.toMatchObject({ code: "refresh_outcome_unknown" });
    expect(consumed).toBe(true);
    store = new CredentialStore(undefined, new PlaintextCipher(), directory);
    drop = false;
    await expect(execute()).rejects.toMatchObject({ code: "reconnect" });
    expect(refreshes).toBe(1);
    expect(actions).toBe(0);
  });
} else {
  test("isolated refresh rejection fixture completes with exact-origin guards", async () => {
    const directory = mkdtempSync(join(tmpdir(), "refresh-classification-child-"));
    const report = join(directory, "junit.xml");
    const child = spawn(
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
          CODESHELL_REFRESH_CLASSIFICATION_CHILD: "1",
        },
        stdio: "inherit",
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(result).toEqual({ code: 0, signal: null });
      expect(assertBunTestCompletion(report)).toEqual({ tests: 15, skipped: 0 });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
