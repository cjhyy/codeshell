import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@cjhyy/code-shell-core";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(reuseRemoteConnection = true) {
  const directory = mkdtempSync(join(tmpdir(), "remote-link-reuse-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  let connectionId = randomUUID();
  const grants = new Map<string, string>();
  const revoked: string[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/oauth/token") {
      const grantId = randomUUID();
      grants.set(`access-${grantId}`, grantId);
      res.end(
        JSON.stringify({
          access_token: `access-${grantId}`,
          refresh_token: `refresh-${grantId}`,
          token_type: "Bearer",
          expires_in: 900,
          scope: "github:list_repositories",
        }),
      );
    } else if (req.url === "/api/v1/data/authorization") {
      const grantId = grants.get(req.headers.authorization!.replace("Bearer ", ""));
      res.end(
        JSON.stringify({
          version: 1,
          providerId: "github",
          connectionId,
          grantId,
          account: { id: "42", login: "fixture" },
          scopes: ["github:list_repositories"],
          repositories: ["owner/repo"],
        }),
      );
    } else if (req.url === "/oauth/revoke") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      revoked.push(new URLSearchParams(Buffer.concat(chunks).toString()).get("token")!);
      res.end("{}");
    } else {
      res.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Install the exact-origin guard before importing any Core or worker code.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    ((url: string | URL | Request, init?: RequestInit) => {
      if (new URL(url instanceof Request ? url.url : url).origin !== issuer)
        throw new Error("Unexpected network origin in remote Link fixture");
      return originalFetch(url, init);
    }) as typeof fetch,
    { preconnect: originalFetch.preconnect },
  );
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });
  const [{ CredentialStore, PlaintextCipher }, { createLinkService }] = await Promise.all([
    import("@cjhyy/code-shell-core"),
    import("./service.js"),
  ]);
  const store = new CredentialStore(directory, new PlaintextCipher(), join(directory, "user"));
  const service = createLinkService({
    store,
    reuseRemoteConnection,
    remoteLink: () => ({
      issuer,
      clientId: "fixture-client",
      redirectUri: "http://127.0.0.1:4900/link/callback",
    }),
    readRemoteCatalog: async () => ["github"],
  });
  cleanups.push(() => service.close());
  const context = { ownerId: "fixture", authorize: () => true };
  async function connect(override = {}) {
    const job = await service.startAuthorization(
      context,
      {
        providerId: "github",
        methodId: "remote-link",
        label: "New login label",
        expectedRevision: null,
        ...override,
      },
      "remote-link",
    );
    if (job.step?.kind !== "redirect") throw new Error("Missing redirect step");
    const url = new URL(job.step.authorizationUrl);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("code", "fixture-code");
    return service.completeRemoteAuth(context, job.id, callback.href);
  }
  return {
    service,
    store,
    revoked,
    connect,
    anotherConnection() {
      connectionId = randomUUID();
    },
  };
}

test("Host opt-in reuses an authenticated remote connection and retires only its old grant", async () => {
  const f = await fixture();
  const first = await f.connect();
  const original = f.store.resolve(first.connection!.id)!;
  f.store.save("user", { ...original, label: "My saved GitHub" });
  const second = await f.connect();
  expect(second.connection).toMatchObject({ id: original.id, label: "My saved GitHub" });
  expect(f.store.list()).toHaveLength(1);
  expect(f.store.resolve(original.id)?.secret).not.toBe(original.secret);
  expect(f.revoked).toEqual([JSON.parse(original.secret!).refreshToken]);
  expect(f.store.remoteLinkRetirementCount()).toBe(0);
});

test("ordinary authorizations and explicit create IDs retain their create-only behavior", async () => {
  const ordinary = await fixture(false);
  await ordinary.connect();
  await ordinary.connect();
  expect(ordinary.store.list()).toHaveLength(2);
  expect(ordinary.revoked).toEqual([]);
  // Finish the first fixture before installing another exact-origin guard.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  const optedIn = await fixture();
  await optedIn.connect();
  await optedIn.connect({ connectionId: "explicit-created-connection" });
  expect(optedIn.store.list()).toHaveLength(2);
  expect(optedIn.revoked).toEqual([]);
});

test.each(["connection", "provider", "issuer"] as const)(
  "authenticated identity matching keeps different %s connections independent",
  async (field) => {
    const f = await fixture();
    const first = await f.connect();
    let existing = f.store.resolve(first.connection!.id)!;
    if (field === "connection") f.anotherConnection();
    else {
      existing = {
        ...existing,
        meta: {
          ...existing.meta,
          ...(field === "provider"
            ? { linkProvider: "figma" }
            : { linkRemoteIssuer: "https://different-link.example" }),
        },
      };
      f.store.save("user", existing);
    }
    const second = await f.connect();
    expect(second.connection!.id).not.toBe(existing.id);
    expect(f.store.list()).toHaveLength(2);
    expect(f.store.resolve(existing.id)).toEqual(existing);
    expect(f.revoked).toEqual([]);
  },
);

test("ambiguous existing connections fail closed and revoke the newly minted grant", async () => {
  const f = await fixture();
  const first = await f.connect();
  const original = f.store.resolve(first.connection!.id)!;
  const duplicate: Credential = { ...original, id: "duplicate-remote-connection" };
  f.store.save("user", duplicate);
  await expect(f.connect()).rejects.toMatchObject({ code: "conflict", status: 409 });
  expect(f.store.list()).toEqual([original, duplicate]);
  expect(f.revoked).toHaveLength(1);
  expect(f.revoked[0]).not.toBe(JSON.parse(original.secret!).refreshToken);
  expect(f.store.remoteLinkRetirementCount()).toBe(0);
});

test("automatic reuse cannot overwrite a connection changed before the credential CAS", async () => {
  const f = await fixture();
  const first = await f.connect();
  const original = f.store.resolve(first.connection!.id)!;
  const changed = { ...original, label: "Changed by another Host" };
  const compareAndSwap = f.store.compareAndSwap.bind(f.store);
  f.store.compareAndSwap = (scope, id, expected, next, retirement) => {
    if (expected?.id === original.id) f.store.save("user", changed);
    return compareAndSwap(scope, id, expected, next, retirement);
  };
  await expect(f.connect()).rejects.toMatchObject({ code: "conflict", status: 409 });
  expect(f.store.list()).toEqual([changed]);
  expect(f.revoked).toHaveLength(1);
  expect(f.revoked[0]).not.toBe(JSON.parse(original.secret!).refreshToken);
  expect(f.store.remoteLinkRetirementCount()).toBe(0);
});

test("project overrides never become the destination of automatic user credential reuse", async () => {
  const f = await fixture();
  const first = await f.connect();
  const original = f.store.resolve(first.connection!.id)!;
  const project = { ...original, label: "Project managed" };
  f.store.save("project", project);
  const second = await f.connect();
  expect(second.connection!.id).not.toBe(original.id);
  expect(f.store.list()).toHaveLength(2);
  expect(f.store.resolve(original.id)).toEqual(project);
  expect(f.revoked).toEqual([]);
});
