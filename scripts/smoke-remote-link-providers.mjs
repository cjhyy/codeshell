/** Built Host SDK → independent Link HTTP/OAuth/SQLite → production provider adapters.
 * Upstream OAuth/API responses are synthetic; this is not real-account acceptance.
 * Usage: node scripts/smoke-remote-link-providers.mjs /absolute/services/apps/link-server/http.mjs
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import {
  CredentialStore,
  executeRemoteLinkAction,
  linkActionTool,
  REMOTE_LINK_PROVIDER_ADAPTERS,
} from "../packages/core/dist/index.js";
import { createLinkService } from "../packages/server/dist/index.links.js";

assert.ok(process.argv[2], "Pass the independently selected Link server http.mjs entry");
const serviceEntry = pathToFileURL(resolve(process.argv[2]));
const { startLinkServer } = await import(serviceEntry.href);
const { createResourceProvider } = await import(new URL("resource-providers.mjs", serviceEntry));
const { createGitHubProvider } = await import(new URL("github.mjs", serviceEntry));
const { oauthDefinitions } = await import(new URL("oauth-provider.mjs", serviceEntry));
const root = await mkdtemp(join(tmpdir(), "codeshell-all-provider-http-"));
process.env.HOME = join(root, "home");
const probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const issuer = `http://127.0.0.1:${port}`;
const page = "123456781234123412341234567890ab";
const team = "12345678-1234-1234-1234-1234567890ab";
const resource = {
  github: "owner/repo",
  gitlab: "17",
  sentry: "owner-org",
  vercel: "prj_one",
  slack: "C12345",
  notion: page,
  linear: team,
  todoist: "one-project",
  airtable: "app1234567890abc",
  figma: "fileOne",
};
const fixtures = {
  gitlab: {
    projects: [{ id: 17, name: "One", path_with_namespace: "owner/repo" }],
    issues: [{ id: 1, project_id: 17, title: "Issue" }],
  },
  sentry: {
    organizations: [{ id: "1", slug: resource.sentry, name: "Org" }],
    projects: [{ id: "1", slug: "project", name: "Project" }],
  },
  vercel: {
    projects: [{ id: resource.vercel, name: "One" }],
    deployments: [{ uid: "dpl_one", projectId: resource.vercel, url: "fixture.vercel.app" }],
  },
  slack: {
    channels: [{ id: resource.slack, name: "one" }],
    messages: [{ ts: "1", text: "Hello" }],
  },
  notion: {
    results: [
      {
        id: team,
        object: "page",
        properties: { title: { type: "title", title: [{ plain_text: "One" }] } },
      },
    ],
  },
  linear: {
    teams: [{ id: team, name: "One", key: "ONE" }],
    issues: [{ id: "issue-one", title: "Issue", team: { id: team, name: "One", key: "ONE" } }],
  },
  todoist: {
    projects: [{ id: resource.todoist, name: "One" }],
    tasks: [{ id: "task-one", project_id: resource.todoist, content: "Task" }],
  },
  airtable: {
    bases: [{ id: resource.airtable, name: "One" }],
    tables: [{ id: "tblone", name: "One" }],
  },
  figma: {
    file: {
      name: "One",
      version: "1",
      document: { children: [{ id: "0:1", name: "Page", type: "CANVAS" }] },
    },
    comments: [{ id: "comment-one", message: "Hello" }],
  },
};
const calls = [];
function upstreamFetch(id) {
  const definition =
    id === "github"
      ? { token: "https://github.com/login/oauth/access_token" }
      : oauthDefinitions[id];
  return async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname,
      headers = new Headers(init.headers);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    calls.push({ id, path, method: init.method ?? "GET" });
    let value;
    if (url.href === definition.token || url.href === definition.refreshUrl) {
      const body = definition.json
        ? JSON.parse(init.body)
        : Object.fromEntries(new URLSearchParams(init.body));
      if (definition.basic)
        assert.equal(
          headers.get("authorization"),
          `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
        );
      else {
        assert.equal(body.client_id, "client-id");
        assert.equal(body.client_secret, "client-secret");
      }
      value = {
        access_token: `UPSTREAM-${id}`,
        refresh_token: `UPSTREAM-REFRESH-${id}`,
        token_type: id === "slack" ? "bot" : "bearer",
        expires_in: 3600,
        ...(definition.scope ? { scope: definition.scope } : {}),
      };
      if (id === "sentry") value.user = { id: "user-one", name: "Alice" };
      if (id === "slack") Object.assign(value, { ok: true, team: { id: "team-one" } });
      if (id === "notion")
        Object.assign(value, {
          bot_id: "bot-one",
          workspace_id: "workspace-one",
          workspace_name: "Workspace",
        });
      if (id === "vercel")
        Object.assign(value, {
          user_id: "user-one",
          team_id: "team_one",
          installation_id: "icfg_one",
        });
      if (id === "figma") value.user_id_string = "123";
    } else {
      assert.equal(headers.get("authorization"), `Bearer UPSTREAM-${id}`);
      const f = fixtures[id];
      if (id === "github") {
        value =
          path === "/user"
            ? { id: 1, login: "alice" }
            : path === "/user/repos"
              ? [{ full_name: resource.github, private: true }]
              : path.endsWith("/readme") || path.includes("/contents/")
                ? {
                    type: "file",
                    encoding: "base64",
                    content: Buffer.from("Hello").toString("base64"),
                    path: path.endsWith("/readme") ? "README.md" : "docs/guide.md",
                    size: 5,
                    sha: "sha",
                  }
                : path.endsWith("/issues")
                  ? init.method === "POST"
                    ? { number: 9, title: "Approved issue" }
                    : [
                        { number: 7, title: "Issue" },
                        { number: 8, pull_request: {} },
                      ]
                  : /\/issues\/\d+$/.test(path)
                    ? { number: 7, title: "Issue" }
                    : path.endsWith("/pulls")
                      ? [{ number: 8, title: "Pull" }]
                      : /\/pulls\/\d+$/.test(path)
                        ? { number: 8, title: "Pull" }
                        : { id: 1, full_name: resource.github };
      }
      if (id === "gitlab")
        value = path.endsWith("/user")
          ? { id: 1, username: "alice" }
          : path.endsWith("/issues")
            ? f.issues
            : /\/projects\/17$/.test(path)
              ? f.projects[0]
              : f.projects;
      if (id === "sentry") value = path.includes("/projects/") ? f.projects : f.organizations;
      if (id === "vercel") {
        value =
          path === "/v2/user"
            ? { user: { id: "user-one", username: "alice" } }
            : path.includes("deployments")
              ? { deployments: f.deployments }
              : { projects: f.projects };
        if (path !== "/v2/user") assert.equal(url.searchParams.get("teamId"), "team_one");
      }
      if (id === "slack")
        value = path.endsWith("auth.test")
          ? { ok: true, team_id: "team-one", user_id: "user-one", team: "Team" }
          : path.endsWith("conversations.list")
            ? { ok: true, channels: f.channels, response_metadata: { next_cursor: "" } }
            : { ok: true, messages: f.messages, has_more: false };
      if (id === "notion") {
        assert.equal(headers.get("notion-version"), "2022-06-28");
        value = path.endsWith("users/me")
          ? { id: "bot-one", name: "Alice" }
          : path.endsWith("search")
            ? { results: f.results, has_more: false, next_cursor: null }
            : f.results[0];
      }
      if (id === "linear") {
        const body = JSON.parse(init.body);
        value = {
          data: body.query.includes("assignedIssues")
            ? { viewer: { assignedIssues: { nodes: f.issues, pageInfo: { hasNextPage: false } } } }
            : body.query.includes("teams(")
              ? { teams: { nodes: f.teams, pageInfo: { hasNextPage: false } } }
              : { viewer: { id: "user-one", name: "Alice" } },
        };
      }
      if (id === "todoist")
        value = path.endsWith("/user")
          ? { id: "user-one", full_name: "Alice" }
          : path.endsWith("/projects")
            ? { results: f.projects, next_cursor: null }
            : { results: f.tasks, next_cursor: null };
      if (id === "airtable")
        value = path.endsWith("whoami")
          ? { id: "user-one", email: "alice@example.test" }
          : path.endsWith("/tables")
            ? { tables: f.tables }
            : { bases: f.bases };
      if (id === "figma")
        value = path.endsWith("/me")
          ? { id: "123", handle: "alice" }
          : path.endsWith("/comments")
            ? { comments: f.comments }
            : f.file;
    }
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  };
}
const providers = Object.fromEntries(
  REMOTE_LINK_PROVIDER_ADAPTERS.map(({ id }) => {
    const config = {
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl: `${issuer}/oauth/upstream/${id}/callback`,
      integrationSlug: "codeshell-fixture",
      fetchImpl: upstreamFetch(id),
    };
    return [
      id,
      id === "github" ? createGitHubProvider(config) : createResourceProvider(id, config),
    ];
  }),
);
const app = await startLinkServer({
  port,
  publicOrigin: issuer,
  ownerPassword: "long-fixture-password",
  databasePath: join(root, "link.sqlite"),
  masterKey: randomBytes(32),
  providers,
});
let host;
try {
  const request = (path, init = {}) =>
    fetch(new URL(path, issuer), { redirect: "manual", ...init });
  const form = (path, body, cookie) =>
    request(path, {
      method: "POST",
      headers: {
        origin: issuer,
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(body),
    });
  const login = await form("/login", { password: "long-fixture-password" });
  assert.equal(login.status, 303);
  const adminCookie = login.headers.getSetCookie()[0].split(";")[0];
  const snapshot = await (
    await request("/api/v1/links", { headers: { cookie: adminCookie } })
  ).json();
  const clientResponse = await request("/api/v1/links/clients", {
    method: "POST",
    headers: {
      origin: issuer,
      cookie: adminCookie,
      "x-csrf-token": snapshot.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "All-provider Host fixture",
      redirectUris: ["http://localhost:4900/callback"],
    }),
  });
  assert.equal(clientResponse.status, 201);
  const client = await clientResponse.json();
  const store = new CredentialStore(join(root, "project"));
  host = createLinkService({
    store,
    remoteLink: () => ({ issuer, clientId: client.id, redirectUri: client.redirectUris[0] }),
  });
  const owner = { ownerId: "fixture-owner", authorize: () => true };
  await host.refreshRemoteCatalog(owner);
  const advertised = host
    .snapshot()
    .providers.filter((provider) =>
      provider.connectionMethods.some((method) => method.id === "remote-link"),
    )
    .map((provider) => provider.id);
  assert.deepEqual(new Set(advertised), new Set(Object.keys(providers)));
  const connected = [];
  let executedActions = 0;
  for (const adapter of REMOTE_LINK_PROVIDER_ADAPTERS) {
    const id = adapter.id,
      cookieJar = new Map();
    const browserRequest = async (url) => {
      assert.equal(new URL(url, issuer).origin, issuer);
      const response = await request(url, {
        headers: { cookie: [...cookieJar.values()].join("; ") },
      });
      for (const value of response.headers.getSetCookie()) {
        const cookie = value.split(";")[0];
        cookieJar.set(cookie.slice(0, cookie.indexOf("=")), cookie);
      }
      return response;
    };
    const started = await host.startRemoteAuth(owner, {
      providerId: id,
      methodId: "remote-link",
      label: `${adapter.name} fixture`,
      connectionId: `remote-${id}`,
      expectedRevision: null,
    });
    let response = await browserRequest(started.redirect.authorizationUrl);
    assert.equal(response.status, 303, id);
    const upstream = new URL(response.headers.get("location"));
    assert.equal(upstream.origin, providers[id].authorizationOrigin, id);
    response = await browserRequest(
      `/oauth/upstream/${id}/callback?${new URLSearchParams({ code: "fixture", state: upstream.searchParams.get("state") })}`,
    );
    assert.equal(response.status, 303, id);
    response = await browserRequest(response.headers.get("location"));
    assert.equal(response.status, 200, id);
    let consent = await response.text();
    const hidden = (name) => {
      const value = consent.match(new RegExp(`name="${name}" value="([^"]+)"`));
      assert.ok(value, `${id} missing ${name}`);
      return value[1];
    };
    const browserCookie = [...cookieJar.values()].join("; ");
    assert.equal(
      (await request("/api/v1/links", { headers: { cookie: browserCookie } })).status,
      401,
    );
    if (id === "figma") {
      response = await form(
        "/oauth/resources",
        {
          csrf: hidden("csrf"),
          intent: hidden("intent"),
          connectionId: hidden("connectionId"),
          file_keys: resource.figma,
        },
        browserCookie,
      );
      assert.equal(response.status, 200);
      consent = await response.text();
    }
    assert.ok(
      consent.includes(id === "github" ? "alice" : "Alice") ||
        consent.includes("alice") ||
        consent.includes(id === "notion" ? "Workspace" : "Team"),
      `${id} account in consent`,
    );
    response = await form(
      "/oauth/authorize",
      {
        csrf: hidden("csrf"),
        intent: hidden("intent"),
        connectionId: hidden("connectionId"),
        decision: "allow",
        [id === "github" ? "repository_0" : "resource_0"]: resource[id],
      },
      browserCookie,
    );
    assert.equal(response.status, 303, id);
    const completed = await host.completeRemoteAuth(
      owner,
      started.id,
      response.headers.get("location"),
    );
    const credential = store.resolve(completed.connection.id);
    assert.equal(credential.meta.linkProvider, id);
    assert.deepEqual(
      new Set(credential.meta.linkCapabilityIds),
      new Set(adapter.actions.map((action) => `${id}.${action}`)),
    );
    assert.deepEqual(
      credential.meta.linkResourceGroups[0].items.map((item) => item.id),
      [resource[id]],
    );
    assert.ok(!credential.secret.includes("UPSTREAM-"));
    connected.push(credential);
    for (const action of adapter.actions) {
      let params = {};
      if (id === "github" && action !== "list_repositories")
        params = {
          owner: "owner",
          repo: "repo",
          ...(action === "get_file"
            ? { path: "docs/guide.md", ref: "main" }
            : action === "get_issue"
              ? { issue_number: 7 }
              : action === "get_pull_request"
                ? { pull_number: 8 }
                : action === "create_issue"
                  ? { title: "Explicitly approved fixture" }
                  : {}),
        };
      if (id === "sentry" && action === "list_projects") params = { organization: resource.sentry };
      if (id === "slack" && action === "get_channel_history") params = { channel: resource.slack };
      if (id === "notion" && action === "get_page") params = { page_id: page };
      if (id === "vercel") params = { team_id: "team_one" };
      if (id === "airtable" && action === "list_tables") params = { base_id: resource.airtable };
      if (id === "figma")
        params = { file_url_or_key: `https://www.figma.com/design/${resource.figma}/Test` };
      const result = JSON.parse(
        await linkActionTool(
          { provider: id, action, connectionId: credential.id, params },
          { cwd: join(root, "project"), settingsScope: "full", askUser: async () => "允许执行" },
        ),
      );
      assert.equal(result.kind, "action_result", `${id}/${action}: ${JSON.stringify(result)}`);
      assert.equal(result.runtime, "server");
      assert.ok(result.data && typeof result.data === "object");
      for (const values of Object.values(result.data).filter(Array.isArray))
        assert.equal(values.length, 1, `${id}/${action} selected result`);
      executedActions++;
    }
    const secret = JSON.parse(credential.secret);
    secret.expiresAt = new Date(Date.now() - 1000).toISOString();
    store.save("user", { ...credential, secret: JSON.stringify(secret) });
    await executeRemoteLinkAction({
      cwd: join(root, "project"),
      scope: "full",
      id: credential.id,
      grantId: credential.meta.linkRemoteGrantId,
      action: adapter.actions[0],
      params: id === "figma" ? { file_key: resource.figma } : {},
    });
    assert.notEqual(
      JSON.parse(store.resolve(credential.id).secret).refreshToken,
      secret.refreshToken,
    );
  }
  assert.equal(executedActions, 26);
  const github = store.resolve("remote-github"),
    githubSecret = JSON.parse(github.secret);
  const other = connected.find((credential) => credential.meta.linkProvider === "gitlab");
  const denied = await request(
    `/api/v1/data/connections/${other.meta.linkRemoteConnectionId}/actions/list_projects`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubSecret.accessToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  assert.ok([401, 403].includes(denied.status), "cross-provider connection access is rejected");
  for (const credential of connected) {
    const revoke = await request(`/api/v1/links/grants/${credential.meta.linkRemoteGrantId}`, {
      method: "DELETE",
      headers: {
        origin: issuer,
        cookie: adminCookie,
        "x-csrf-token": snapshot.csrf,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(revoke.status, 200);
    const adapter = REMOTE_LINK_PROVIDER_ADAPTERS.find(
      ({ id }) => id === credential.meta.linkProvider,
    );
    await assert.rejects(() =>
      executeRemoteLinkAction({
        cwd: join(root, "project"),
        scope: "full",
        id: credential.id,
        grantId: credential.meta.linkRemoteGrantId,
        action: adapter.actions[0],
        params: adapter.id === "figma" ? { file_key: resource.figma } : {},
      }),
    );
    const reviewed = host.snapshot().connections.find(({ id }) => id === credential.id);
    await host.disconnect(owner, reviewed.id, reviewed.revision);
  }
  assert.equal(store.list().length, 0);
  console.log(
    JSON.stringify({
      providers: connected.length,
      actions: executedActions,
      builtHost: true,
      independentHttpService: true,
      productionProviderAdapters: true,
      selectedResources: true,
      publicAccountIsolation: true,
      downstreamRotation: true,
      crossProviderRejected: true,
      revocation: true,
      hostDisconnect: true,
      upstreamRequests: calls.length,
      upstream: "synthetic OAuth/API fixture; real-account acceptance pending",
    }),
  );
} finally {
  host?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
