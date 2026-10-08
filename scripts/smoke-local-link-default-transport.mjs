/** Public SDK, default transport, and actual lost-response HTTP fixtures; synthetic tokens only. */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "codeshell-local-link-default-"));
let active;
let fixtureError;
let fetchCalls = 0;
const server = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    active.calls.push({ path: request.url, method: request.method });
    if (active.mode === "refresh") {
      assert.equal(request.method, "POST");
      assert.ok(["/login/oauth/access_token", "/oauth/token"].includes(request.url));
      assert.equal(new URLSearchParams(body).get("grant_type"), "refresh_token");
    } else {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/repos/acme/demo/issues");
      assert.equal(JSON.parse(body).title, "Explicit fixture write");
      assert.equal(request.headers.authorization, "Bearer synthetic-access");
    }
    // The upstream has consumed the request. Its response never reaches the client.
    request.socket.destroy();
  } catch (error) {
    fixtureError = error;
    response.writeHead(500);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const originalRequest = https.request;
const originalFetch = globalThis.fetch;
// Only the physical socket destination changes. SDK defaults, fixed provider URLs,
// credential custody, request options, and persistent failure states remain real.
https.request = (input, options, callback) => {
  const url = new URL(input);
  assert.ok(["github.com", "api.github.com", "gitlab.com"].includes(url.hostname));
  assert.equal(url.protocol, "https:");
  assert.equal(options.agent, false);
  return httpRequest(`http://127.0.0.1:${port}${url.pathname}${url.search}`, options, callback);
};
syncBuiltinESMExports();
globalThis.fetch = async () => {
  fetchCalls++;
  throw new Error("Default Link transport must not delegate a rotating exchange or write to fetch");
};
try {
  const { CredentialStore, executeLocalOAuthLinkAction } =
    await import("../packages/core/dist/index.js");
  const results = [];
  for (const [provider, mode] of [
    ["github", "refresh"],
    ["gitlab", "refresh"],
    ["github", "write"],
  ]) {
    active = { provider, mode, calls: [] };
    const storage = join(directory, `${provider}-${mode}`);
    const store = new CredentialStore(directory, undefined, storage);
    const verifiedAt = new Date().toISOString();
    store.save("user", {
      id: "selected-link",
      type: "link",
      label: provider,
      secret: JSON.stringify({
        version: 1,
        accessToken: "synthetic-access",
        refreshToken: `synthetic-${provider}-${mode}`,
        tokenEndpoint:
          provider === "github"
            ? "https://github.com/login/oauth/access_token"
            : "https://gitlab.com/oauth/token",
        clientId: "public-client",
        expiresAt: mode === "refresh" ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
        scope: provider === "gitlab" ? "read_api" : "",
      }),
      meta: {
        linkProvider: provider,
        linkExecutionRuntime: "local",
        linkExecutionBackend: "http-token",
        linkAuthSource: "browser-oauth",
        agentExposable: false,
        linkAccountId: "42",
        linkLastVerifiedAt: verifiedAt,
        linkCapabilityIds: [
          `${provider}.${mode === "write" ? "create_issue" : provider === "github" ? "get_issue" : "list_projects"}`,
        ],
      },
    });
    const input = {
      id: "selected-link",
      scope: "full",
      accountId: "42",
      verifiedAt,
      action:
        mode === "write" ? "create_issue" : provider === "github" ? "get_issue" : "list_projects",
      params:
        mode === "write"
          ? { owner: "acme", repo: "demo", title: "Explicit fixture write" }
          : provider === "github"
            ? { owner: "acme", repo: "demo", issue_number: 1 }
            : {},
    };
    await assert.rejects(executeLocalOAuthLinkAction(input, { store }));
    assert.equal(active.calls.length, 1);
    if (mode === "refresh") {
      assert.equal(store.resolve(input.id).meta.linkOAuthState, "reconnect");
      // Reopening the same durable credential must not resend an uncertain rotation.
      const reopened = new CredentialStore(directory, undefined, storage);
      await assert.rejects(executeLocalOAuthLinkAction(input, { store: reopened }), {
        code: "reconnect",
      });
      assert.equal(active.calls.length, 1);
    }
    if (fixtureError) throw fixtureError;
    results.push({ provider, mode, physicalRequests: active.calls.length });
  }
  assert.equal(fetchCalls, 0);
  console.log(
    JSON.stringify({
      result: "passed",
      publicSdk: true,
      defaultTransport: true,
      lostResponseFixtures: results,
      fetchCalls,
      realAccountAcceptance: false,
    }),
  );
} finally {
  https.request = originalRequest;
  syncBuiltinESMExports();
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
