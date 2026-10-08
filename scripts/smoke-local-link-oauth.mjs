/** Public SDK → actual upstream HTTP fixtures. Synthetic tokens only. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, executeLocalOAuthLinkAction } from "../packages/core/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "codeshell-local-oauth-sdk-"));
const calls = {
  github: { refresh: 0, account: 0, read: 0, write: 0 },
  gitlab: { refresh: 0, account: 0, read: 0 },
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture");
    const provider = url.pathname.startsWith("/github/") ? "github" : "gitlab";
    const path = url.pathname.slice(provider.length + 1);
    const count = calls[provider];
    let data;
    if (path === "/token") {
      count.refresh++;
      let body = "";
      for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("client_id"), "public-client");
      assert.equal(form.has("client_secret"), false);
      if (provider === "gitlab") assert.equal(form.get("scope"), "read_api");
      data = {
        access_token: `${provider}-rotated-access`,
        refresh_token: `${provider}-rotated-refresh`,
        token_type: "bearer",
        expires_in: 7200,
        ...(provider === "gitlab" ? { scope: "read_api" } : {}),
      };
    } else if (path === "/user") {
      count.account++;
      assert.equal(request.headers.authorization, `Bearer ${provider}-rotated-access`);
      data = { id: 42, login: "owner", username: "owner" };
    } else {
      assert.equal(request.headers["private-token"], undefined);
      if (request.method === "POST") {
        count.write++;
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: "Expired write; never replay" }));
        return;
      }
      count.read++;
      assert.equal(request.headers.authorization, `Bearer ${provider}-rotated-access`);
      data =
        provider === "github"
          ? { number: 1, title: "Fixture issue" }
          : [{ id: 7, name: "Fixture project" }];
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "fixture_contract_failed" }));
    server.emit("fixture-error", error);
  }
});
let fixtureError;
server.on("fixture-error", (error) => {
  fixtureError = error;
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
try {
  for (const provider of ["github", "gitlab"]) {
    const store = new CredentialStore(directory, undefined, join(directory, provider));
    const verifiedAt = new Date().toISOString();
    store.save("user", {
      id: "selected-link",
      type: "link",
      label: provider,
      secret: JSON.stringify({
        version: 1,
        accessToken: "expired",
        refreshToken: `${provider}-refresh`,
        tokenEndpoint:
          provider === "github"
            ? "https://github.com/login/oauth/access_token"
            : "https://gitlab.com/oauth/token",
        clientId: "public-client",
        expiresAt: "2000-01-01T00:00:00Z",
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
        linkCapabilityIds:
          provider === "github"
            ? ["github.get_issue", "github.create_issue"]
            : ["gitlab.list_projects"],
      },
    });
    const fetchImpl = (input, init) => {
      const target = new URL(String(input));
      assert.equal(init.redirect, "error");
      const token =
        target.pathname === "/login/oauth/access_token" || target.pathname === "/oauth/token";
      const user = target.pathname === "/user" || target.pathname === "/api/v4/user";
      const expectedHost =
        provider === "github" ? (token ? "github.com" : "api.github.com") : "gitlab.com";
      assert.equal(target.hostname, expectedHost);
      return fetch(
        `http://127.0.0.1:${port}/${provider}${token ? "/token" : user ? "/user" : target.pathname}${target.search}`,
        init,
      );
    };
    const input = {
      id: "selected-link",
      scope: "full",
      accountId: "42",
      verifiedAt,
      action: provider === "github" ? "get_issue" : "list_projects",
      params: provider === "github" ? { owner: "acme", repo: "demo", issue_number: 1 } : {},
    };
    const result = await executeLocalOAuthLinkAction(input, { store, fetchImpl });
    assert.ok(result);
    assert.equal(JSON.stringify(result).includes("rotated"), false);
    assert.equal(store.resolve("selected-link").meta.linkOAuthState, "connected");
    if (provider === "github")
      await assert.rejects(
        executeLocalOAuthLinkAction(
          {
            ...input,
            action: "create_issue",
            params: { owner: "acme", repo: "demo", title: "Explicit fixture write" },
          },
          { store, fetchImpl },
        ),
        { code: "reconnect" },
      );
  }
  if (fixtureError) throw fixtureError;
  assert.deepEqual(calls, {
    github: { refresh: 1, account: 1, read: 1, write: 1 },
    gitlab: { refresh: 1, account: 1, read: 1 },
  });
  console.log(
    JSON.stringify({
      result: "passed",
      publicSdk: true,
      providers: 2,
      realHttpFixtures: true,
      calls,
      realAccountAcceptance: false,
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
