import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialStore,
  PlaintextCipher,
  type RemoteLinkConfiguration,
} from "@cjhyy/code-shell-core";
import { createLinkHttp } from "./http.js";
import type { LinkAuthorization } from "./types.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const input = {
  providerId: "github",
  methodId: "remote-link",
  label: "Remote GitHub",
  expectedRevision: null,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "host-remote-link-"));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  const store = new CredentialStore(undefined, new PlaintextCipher(), directory);
  const connectionId = randomUUID();
  const grants = new Map<string, string>();
  const requests: Array<{ path: string; body: Record<string, string> }> = [];
  const entered = deferred();
  let gate: Promise<void> | undefined;
  let revocationFails = false;
  const issuer = await listen(
    createServer(async (req, res) => {
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(Buffer.from(chunk));
      const body = Object.fromEntries(new URLSearchParams(Buffer.concat(parts).toString()));
      requests.push({ path: req.url!, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth/token") {
        entered.resolve();
        await gate;
        const grantId = randomUUID(),
          access = `access-${grantId}`;
        grants.set(access, grantId);
        res.end(
          JSON.stringify({
            access_token: access,
            refresh_token: `refresh-${grantId}`,
            token_type: "Bearer",
            expires_in: 900,
            scope: "github:list_repositories",
          }),
        );
      } else if (req.url === "/api/v1/data/authorization") {
        const access = req.headers.authorization!.replace("Bearer ", "");
        res.end(
          JSON.stringify({
            version: 1,
            providerId: "github",
            connectionId,
            grantId: grants.get(access),
            account: { id: 1, login: "fixture" },
            scopes: ["github:list_repositories"],
            repositories: ["owner/repo"],
          }),
        );
      } else if (req.url === "/oauth/revoke") {
        res.statusCode = revocationFails ? 503 : 200;
        res.end("{}");
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    }),
  );
  let config: RemoteLinkConfiguration | undefined = {
    issuer,
    clientId: "fixture-client",
    clientSecret: "host-private-client-secret",
    redirectUri: "http://localhost:4900/link/callback",
  };
  let clock = Date.now();
  const denied = new Set<string>();
  const http = createLinkHttp({
    store,
    remoteLink: () => config,
    now: () => clock,
    ownerId: async (req) => req.headers["x-owner"] as string | undefined,
    isAuthorized: async (req) => !denied.has(req.headers["x-owner"] as string),
  });
  cleanups.push(async () => http.close());
  const origin = await listen(
    createServer((req, res) => {
      if (req.headers.origin !== origin) {
        res.writeHead(403).end();
        return;
      }
      void http.handle(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    }),
  );
  const api = (path: string, method = "GET", body?: unknown, owner = "one") =>
    fetch(origin + "/api/v1/links" + path, {
      method,
      headers: {
        origin,
        "x-owner": owner,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const start = async (override = {}, owner = "one") => {
    const res = await api("/authorizations/remote", "POST", { ...input, ...override }, owner);
    expect(res.status).toBe(200);
    return (await res.json()) as LinkAuthorization;
  };
  const callback = (job: LinkAuthorization) => {
    const url = new URL(config!.redirectUri);
    url.searchParams.set(
      "state",
      new URL(job.redirect!.authorizationUrl).searchParams.get("state")!,
    );
    url.searchParams.set("code", "fixture-code");
    return url.href;
  };
  const complete = (job: LinkAuthorization, owner = "one") =>
    api(`/authorizations/${job.id}/complete`, "POST", { callbackUrl: callback(job) }, owner);
  return {
    store,
    http,
    api,
    start,
    callback,
    complete,
    requests,
    entered,
    delay: (promise: Promise<void>) => {
      gate = promise;
    },
    setConfig: (value: Partial<RemoteLinkConfiguration>) => {
      config = { ...config!, ...value };
    },
    disable: () => {
      config = undefined;
    },
    deny: (owner: string) => denied.add(owner),
    advance: () => {
      clock += 11 * 60_000;
    },
    failRevocation: (value: boolean) => {
      revocationFails = value;
    },
  };
}
test("authenticated HTTP authorization saves only through Host and remote disconnect revokes the grant", async () => {
  const f = await fixture();
  const job = await f.start();
  expect(JSON.stringify(job)).not.toContain("host-private-client-secret");
  expect(JSON.stringify(job)).not.toContain("verifier");
  expect(f.store.list("full")).toHaveLength(0);
  const result = await f.complete(job);
  expect(result.status).toBe(200);
  const done = await result.json();
  const snapshot = await (await f.api("")).json();
  expect(snapshot.capabilities.remoteAuth).toBe(true);
  expect(snapshot.connections[0]).toMatchObject({
    runtime: "server",
    authSource: "remote-link",
    status: "connected",
  });
  expect(JSON.stringify(snapshot)).not.toContain("refresh-");
  expect(JSON.stringify(snapshot)).not.toContain("host-private-client-secret");
  const saved = f.store.resolve(done.connection.id)!;
  expect(saved.meta?.agentExposable).toBe(false);
  expect(JSON.parse(saved.secret!).clientSecret).toBe("host-private-client-secret");
  expect((await f.complete(job)).status).toBe(409);
  expect(
    (
      await f.api(`/connections/${done.connection.id}`, "DELETE", {
        expectedRevision: done.connection.revision,
      })
    ).status,
  ).toBe(200);
  expect(f.store.resolve(done.connection.id)).toBeUndefined();
  expect(f.requests.filter((req) => req.path === "/oauth/token")).toHaveLength(1);
  expect(f.requests.filter((req) => req.path === "/oauth/revoke")).toHaveLength(1);
});
test("another login cannot inspect, complete or cancel an authorization, and logout prevents exchange", async () => {
  const f = await fixture(),
    job = await f.start();
  expect((await f.api(`/authorizations/${job.id}`, "GET", undefined, "two")).status).toBe(404);
  expect((await f.complete(job, "two")).status).toBe(404);
  expect((await f.api(`/authorizations/${job.id}`, "DELETE", undefined, "two")).status).toBe(404);
  f.deny("one");
  expect((await f.complete(job)).status).toBe(401);
  expect(f.requests).toHaveLength(0);
});
test("a changed reviewed connection cannot be overwritten by an in-flight callback", async () => {
  const f = await fixture();
  const done = await (await f.complete(await f.start())).json();
  const job = await f.start({
    connectionId: done.connection.id,
    expectedRevision: done.connection.revision,
  });
  const wait = deferred();
  f.delay(wait.promise);
  const pending = f.complete(job);
  // The first authorization has already resolved entered; wait for the second actual token request.
  while (f.requests.filter((req) => req.path === "/oauth/token").length < 2)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const renamed = await f.http.service.rename(
    { ownerId: "two", authorize: () => true },
    done.connection.id,
    "Other device",
    done.connection.revision,
  );
  wait.resolve();
  expect((await pending).status).toBe(409);
  expect(f.store.resolve(done.connection.id)?.label).toBe("Other device");
  expect(f.http.service.snapshot().connections[0]?.revision).toBe(renamed.revision);
  expect(f.requests.filter((req) => req.path === "/oauth/revoke")).toHaveLength(1);
});
test("cancelled owners and duplicate callbacks cannot persist or replay a code", async () => {
  const f = await fixture(),
    job = await f.start(),
    wait = deferred();
  f.delay(wait.promise);
  const pending = f.complete(job);
  await f.entered.promise;
  expect((await f.complete(job)).status).toBe(409);
  f.http.cancelOwner("one");
  wait.resolve();
  expect((await pending).status).toBe(401);
  expect(f.store.list("full")).toHaveLength(0);
  expect(f.requests.filter((req) => req.path === "/oauth/token")).toHaveLength(1);
  expect(f.requests.filter((req) => req.path === "/oauth/revoke")).toHaveLength(1);
});
test("changed trusted configuration, expiry and restart invalidate private attempts", async () => {
  const f = await fixture(),
    job = await f.start();
  const callbackUrl = f.callback(job);
  f.setConfig({ clientId: "changed-client" });
  expect((await f.api(`/authorizations/${job.id}/complete`, "POST", { callbackUrl })).status).toBe(
    409,
  );
  const expired = await f.start();
  f.advance();
  expect((await f.complete(expired)).status).toBe(404);
  f.http.close();
  expect((await f.complete(expired)).status).toBe(503);
  expect(f.requests).toHaveLength(0);
});
test("failed remote revocation disables local use and can be retried without erasing the grant", async () => {
  const f = await fixture(),
    done = await (await f.complete(await f.start())).json();
  f.failRevocation(true);
  expect(
    (
      await f.api(`/connections/${done.connection.id}`, "DELETE", {
        expectedRevision: done.connection.revision,
      })
    ).status,
  ).toBe(503);
  const disabled = f.http.service.snapshot().connections[0]!;
  expect(disabled.status).toBe("unavailable");
  expect(f.store.resolve(disabled.id)?.meta?.linkRemoteState).toBe("reconnect");
  f.failRevocation(false);
  expect(
    (await f.api(`/connections/${disabled.id}`, "DELETE", { expectedRevision: disabled.revision }))
      .status,
  ).toBe(200);
  expect(f.store.list("full")).toHaveLength(0);
});
test("untrusted configuration fields and foreign callbacks never reach the issuer", async () => {
  const f = await fixture();
  expect(
    (await f.api("/authorizations/remote", "POST", { ...input, issuer: "http://localhost:1" }))
      .status,
  ).toBe(400);
  const job = await f.start();
  expect(
    (
      await f.api(`/authorizations/${job.id}/complete`, "POST", {
        callbackUrl: "http://localhost:9999/wrong?state=wrong&code=bad",
      })
    ).status,
  ).toBe(422);
  expect(f.requests).toHaveLength(0);
  f.disable();
  expect((await f.api("/authorizations/remote", "POST", input)).status).toBe(503);
});
