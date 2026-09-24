import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../credentials/store.js";
import { localCredentialAccess, setDefaultCredentialAccess } from "../credentials/access.js";
import {
  beginRemoteLinkAuthorization,
  completeRemoteLinkAuthorization,
  executeRemoteLinkAction,
} from "./remote.js";
import { linkActionTool } from "./link-action-tool.js";
import type { ToolContext } from "../tool-system/context.js";
let root: string;
let previousHome: string | undefined;
let server: ReturnType<typeof createServer>;
let issuer: string;
let requests: Array<{ path: string; body: any; authorization?: string }>;
let tokenMode: "ok" | "lost" | "delay";
let release: (() => void) | undefined;
let actionWait: Promise<void> | undefined;
let clock: number;
let actionStatus: number;
let scopes: string[];
const connectionId = "12345678-1234-1234-1234-123456789abc";
const grantId = "12345678-1234-1234-1234-123456789def";
beforeEach(async () => {
  previousHome = process.env.HOME;
  root = mkdtempSync(join(tmpdir(), "remote-link-"));
  process.env.HOME = join(root, "home");
  clock = Date.now();
  actionStatus = 200;
  scopes = ["github:list_repositories", "github:list_issues", "github:get_issue"];
  requests = [];
  tokenMode = "ok";
  actionWait = undefined;
  server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const raw = Buffer.concat(parts).toString();
    const body = req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(raw))
      : raw
        ? JSON.parse(raw)
        : {};
    requests.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/oauth/token") {
      if (tokenMode === "lost") {
        req.socket.destroy();
        return;
      }
      if (tokenMode === "delay")
        await new Promise<void>((done) => {
          release = done;
        });
      res.end(
        JSON.stringify({
          access_token: "DOWNSTREAM-ACCESS",
          refresh_token: "ROTATING-" + requests.length,
          expires_in: 900,
          token_type: "Bearer",
          scope: scopes.join(" "),
        }),
      );
    } else if (req.url === "/api/v1/data/authorization") {
      res.end(
        JSON.stringify({
          version: 1,
          grantId,
          connectionId,
          providerId: "github",
          account: { id: "1", login: "alice" },
          scopes,
          repositories: ["owner/repo"],
        }),
      );
    } else {
      if (actionStatus !== 200) {
        res.statusCode = actionStatus;
        res.end(JSON.stringify({ error: "provider might echo DOWNSTREAM-ACCESS here" }));
        return;
      }
      if (actionWait) await actionWait;
      const result = req.url?.endsWith("list_repositories")
        ? [{ full_name: "owner/repo", id: 1, unrelated: "omit" }]
        : req.url?.endsWith("list_issues")
          ? [
              { number: 1, title: "Issue" },
              { number: 2, pull_request: {} },
            ]
          : {
              number: body.number,
              title: "Issue",
              body: "Untrusted external content",
              extra: "omit",
            };
      res.end(JSON.stringify({ result }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  release?.();
  release = undefined;
  setDefaultCredentialAccess(null);
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});
async function connect() {
  const attempt = beginRemoteLinkAuthorization(
    { issuer, clientId: "registered-client", redirectUri: "http://localhost:4900/callback" },
    clock,
  );
  const credential = await completeRemoteLinkAuthorization(
    attempt,
    `${attempt.configuration.redirectUri}?code=one&state=${attempt.state}`,
    "remote-github",
    "GitHub via Link",
    { now: clock },
  );
  const store = new CredentialStore(root);
  store.save("user", credential);
  return { credential, store, attempt };
}
const input = (action = "list_repositories", params = {}) => ({
  cwd: root,
  id: "remote-github",
  scope: "full" as const,
  grantId,
  action,
  params,
});
test("PKCE exchange discovers the selected account and restricts action shapes without exposing tokens", async () => {
  const { credential, attempt } = await connect();
  expect(new URL(attempt.authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
  expect(requests[0]?.body.code_verifier).toBe(attempt.verifier);
  expect(credential.meta).toMatchObject({
    linkAccountLabel: "alice",
    linkRemoteConnectionId: connectionId,
    agentExposable: false,
  });
  expect(JSON.stringify(credential.meta)).not.toContain("DOWNSTREAM");
  expect(await executeRemoteLinkAction(input())).toEqual({
    repositories: [{ id: 1, full_name: "owner/repo" }],
  });
  expect(
    await executeRemoteLinkAction(input("list_issues", { owner: "Owner", repo: "Repo" })),
  ).toEqual({ issues: [{ number: 1, title: "Issue" }] });
  expect(requests.at(-1)?.body).toEqual({ repository: "owner/repo", state: "open", page: 1 });
  expect(
    await executeRemoteLinkAction(
      input("get_issue", { owner: "owner", repo: "repo", issue_number: 7 }),
    ),
  ).toEqual({ number: 7, title: "Issue", body: "Untrusted external content" });
  await expect(
    executeRemoteLinkAction(
      input("get_issue", { owner: "other", repo: "private", issue_number: 7 }),
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
  for (const purpose of ["use", "mcp", "link"] as const)
    await expect(
      localCredentialAccess.resolveValue!({ cwd: root, id: credential.id, scope: "full", purpose }),
    ).rejects.toThrow("Host-owned");
  await expect(
    localCredentialAccess.resolveOAuthAccess!({ id: credential.id, scope: "full" }),
  ).rejects.toThrow("MCP");
  expect(localCredentialAccess.envExposures(root, "full")).toEqual({});
  expect(localCredentialAccess.listMasked(root, "full")[0]?.secretHint).toBe("****");
});
test("concurrent actions rotate a refresh token once and persist its replacement before use", async () => {
  const { store } = await connect();
  clock += 16 * 60_000;
  const result = await Promise.all(
    Array.from({ length: 4 }, () => executeRemoteLinkAction(input(), { now: () => clock })),
  );
  expect(result).toHaveLength(4);
  expect(requests.filter((request) => request.body.grant_type === "refresh_token")).toHaveLength(1);
  expect(store.resolve("remote-github")?.meta?.linkRemoteState).toBe("connected");
});
test("uncertain rotation persists reconnect status and never resends the old refresh token", async () => {
  const { store } = await connect();
  clock += 16 * 60_000;
  tokenMode = "lost";
  await expect(executeRemoteLinkAction(input(), { now: () => clock })).rejects.toMatchObject({
    code: "reconnect",
  });
  expect(store.resolve("remote-github")?.meta?.linkRemoteState).toBe("reconnect");
  tokenMode = "ok";
  await expect(executeRemoteLinkAction(input(), { now: () => clock })).rejects.toMatchObject({
    code: "reconnect",
  });
  expect(requests.filter((request) => request.body.grant_type === "refresh_token")).toHaveLength(1);
});
test("disconnect during refresh cannot revive a credential and an orphaned refresh is never replayed", async () => {
  const { store, credential } = await connect();
  clock += 16 * 60_000;
  tokenMode = "delay";
  const task = executeRemoteLinkAction(input(), { now: () => clock });
  while (!release) await new Promise((done) => setTimeout(done, 5));
  store.remove("user", credential.id);
  release();
  await expect(task).rejects.toMatchObject({ code: "changed" });
  expect(store.resolve(credential.id)).toBeUndefined();
  store.save("user", {
    ...credential,
    meta: { ...credential.meta, linkRemoteState: "refreshing" },
  });
  await expect(executeRemoteLinkAction(input(), { now: () => clock })).rejects.toMatchObject({
    code: "busy",
  });
  expect(requests.filter((request) => request.body.grant_type === "refresh_token")).toHaveLength(1);
});
test("scope and connection selection do not fall back to another account", async () => {
  const { store } = await connect();
  store.save("user", {
    id: "local-github",
    type: "link",
    label: "Local",
    secret: "PAT-NEVER-SENT",
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: "local",
      linkLastVerifiedAt: new Date(clock + 1000).toISOString(),
    },
  });
  const context = { cwd: root, settingsScope: "full" } as ToolContext;
  expect(
    JSON.parse(await linkActionTool({ provider: "github", action: "list_repositories" }, context))
      .kind,
  ).toBe("connection_required");
  const result = JSON.parse(
    await linkActionTool(
      { provider: "github", action: "list_repositories", connectionId: "remote-github" },
      context,
    ),
  );
  expect(result).toMatchObject({
    kind: "action_result",
    runtime: "server",
    connectionId: "remote-github",
    data: { repositories: [{ full_name: "owner/repo" }] },
  });
  store.patch("user", "remote-github", {
    meta: { ...store.resolve("remote-github")!.meta, linkRemoteState: "reconnect" },
  });
  expect(
    JSON.parse(await linkActionTool({ provider: "github", action: "list_repositories" }, context))
      .kind,
  ).toBe("connection_required");
  const count = requests.length;
  await expect(executeRemoteLinkAction({ ...input(), scope: "project" })).rejects.toMatchObject({
    code: "changed",
  });
  expect(requests).toHaveLength(count);
});
test("mismatched callbacks and insecure issuers are rejected before any request", async () => {
  expect(() =>
    beginRemoteLinkAuthorization({
      issuer: "http://remote.example",
      clientId: "id",
      redirectUri: "http://localhost/cb",
    }),
  ).toThrow();
  const attempt = beginRemoteLinkAuthorization({
    issuer,
    clientId: "id",
    redirectUri: "http://localhost/cb",
  });
  for (const url of [
    "http://other/cb?code=one",
    "http://localhost/cb?code=one&state=wrong",
    `http://localhost/cb?code=a&code=b&state=${attempt.state}`,
  ])
    await expect(completeRemoteLinkAuthorization(attempt, url, "id", "label")).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

test("removing a connection while a provider is responding discards the result", async () => {
  const { store, credential } = await connect();
  let finish!: () => void;
  actionWait = new Promise<void>((done) => {
    finish = done;
  });
  const running = executeRemoteLinkAction(input());
  while (!requests.some((request) => request.path.endsWith("list_repositories")))
    await new Promise((done) => setTimeout(done, 5));
  store.remove("user", credential.id);
  finish();
  await expect(running).rejects.toMatchObject({ code: "changed" });
});

test("a consumed authorization attempt cannot exchange its code twice", async () => {
  const { attempt } = await connect();
  const count = requests.length;
  await expect(
    completeRemoteLinkAuthorization(
      attempt,
      `${attempt.configuration.redirectUri}?code=one&state=${attempt.state}`,
      "other",
      "Other",
    ),
  ).rejects.toMatchObject({ code: "reconnect" });
  expect(requests).toHaveLength(count);
});

test("a narrowed token cannot execute removed actions and cannot expand again", async () => {
  const { store } = await connect();
  clock += 16 * 60_000;
  scopes = ["github:list_repositories"];
  await expect(
    executeRemoteLinkAction(input("get_issue", { owner: "owner", repo: "repo", issue_number: 1 }), {
      now: () => clock,
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(store.resolve("remote-github")?.meta?.linkCapabilityIds).toEqual([
    "github.list_repositories",
  ]);
  clock += 16 * 60_000;
  scopes.push("github:get_issue");
  await expect(executeRemoteLinkAction(input(), { now: () => clock })).rejects.toMatchObject({
    code: "reconnect",
  });
});

test("remote revocation becomes reconnect status and never leaks provider error bodies", async () => {
  const { store } = await connect();
  actionStatus = 401;
  await expect(executeRemoteLinkAction(input())).rejects.toMatchObject({ code: "reconnect" });
  expect(store.resolve("remote-github")?.meta?.linkRemoteState).toBe("reconnect");
  const count = requests.length;
  try {
    await executeRemoteLinkAction(input());
  } catch (error) {
    expect(String(error)).not.toContain("DOWNSTREAM-ACCESS");
  }
  expect(requests).toHaveLength(count);
});
