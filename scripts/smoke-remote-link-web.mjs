/** Real browser flow through the built Web app, Node Hub and independent Link.
 * GitHub responses are controlled; this does not claim a real provider login.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
// The verifier takes a separately built/selected service entry. No product depends on sibling sources.
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/smoke-remote-link-web.mjs /absolute/path/to/link-server/http.mjs",
  );
const { startLinkServer } = await import(pathToFileURL(resolve(process.argv[2])).href);
import { startHeadlessServer } from "../packages/server/dist/serve/headless-server.js";
import { resolveWorkerEntry } from "../packages/server/dist/serve/cli.js";
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const { chromium } = require("playwright");
let hub, browser;
const root = await mkdtemp(join(tmpdir(), "codeshell-link-real-http-"));
process.env.HOME = join(root, "home");
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const issuer = `http://127.0.0.1:${port}`;
const hubProbe = createServer();
await new Promise((done) => hubProbe.listen(0, "127.0.0.1", done));
const hubPort = hubProbe.address().port;
await new Promise((done) => hubProbe.close(done));
const hubOrigin = `http://127.0.0.1:${hubPort}`;
const screenshots = await mkdtemp(join(tmpdir(), "codeshell-remote-link-web-ui-"));
let calls = 0;
const app = await startLinkServer({
  port,
  publicOrigin: issuer,
  ownerPassword: "long-private-fixture-password",
  databasePath: join(root, "link.sqlite"),
  masterKey: randomBytes(32),
  provider: {
    async begin(state) {
      return {
        url: `https://github.com/login/oauth/authorize?state=${state}`,
        verifier: "fixture",
      };
    },
    async exchange() {
      return {
        account: { id: "1", login: "alice" },
        credential: { access_token: "UPSTREAM-ONLY-IN-LINK" },
      };
    },
    async action(action, input, credential, resources) {
      assert.equal(credential.access_token, "UPSTREAM-ONLY-IN-LINK");
      assert.deepEqual(resources, ["owner/repo"]);
      calls++;
      return action === "get_issue"
        ? { number: input.number, title: "real Link route" }
        : [{ id: 1, full_name: "owner/repo" }];
    },
  },
});
try {
  const request = (path, init = {}) => fetch(issuer + path, { redirect: "manual", ...init });
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
  const login = await form("/login", { password: "long-private-fixture-password" });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const snapshot = await (await request("/api/v1/links", { headers: { cookie } })).json();
  const upstream = await form(
    "/api/v1/links/providers/github/authorize",
    { csrf: snapshot.csrf },
    cookie,
  );
  const state = new URL(upstream.headers.get("location")).searchParams.get("state");
  assert.equal(
    (
      await request(`/oauth/upstream/github/callback?code=one&state=${state}`, {
        headers: { cookie },
      })
    ).status,
    303,
  );
  const linked = await (await request("/api/v1/links", { headers: { cookie } })).json();
  const client = await (
    await request("/api/v1/links/clients", {
      method: "POST",
      headers: {
        origin: issuer,
        cookie,
        "x-csrf-token": snapshot.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Host integration fixture",
        redirectUris: [hubOrigin + "/link/callback"],
      }),
    })
  ).json();
  hub = await startHeadlessServer({
    host: "127.0.0.1",
    port: hubPort,
    publicOrigin: hubOrigin,
    authMode: "hub",
    cwd: join(root, "workspace"),
    dataDir: join(root, "hub"),
    workerEntryPath: resolveWorkerEntry(),
    execPath: process.execPath,
    staticRootDir: new URL("../packages/web/dist-app", import.meta.url).pathname,
    remoteLink: { issuer, clientId: client.id, redirectUri: client.redirectUris[0] },
  });
  browser = await chromium.launch({ headless: true });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const setup = width === 390;
    const auth = await context.request.post(
      hubOrigin + `/api/v1/auth/${setup ? "setup" : "login"}`,
      {
        headers: { origin: hubOrigin },
        data: {
          username: "admin",
          password: "fixture-password-at-least-sixteen",
          ...(setup ? { token: hub.bootstrapToken } : {}),
        },
      },
    );
    assert.equal(auth.status(), 200);
    const equal = cookie.indexOf("=");
    await context.addCookies([
      {
        name: cookie.slice(0, equal),
        value: cookie.slice(equal + 1),
        url: issuer,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage(),
      failures = [];
    let completes = 0;
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/authorizations\/[^/]+\/complete/.test(request.url()))
        completes++;
    });
    await page.goto(hubOrigin + "/?view=links");
    await page.getByRole("button", { name: "通过 Link 添加账号", exact: true }).click();
    await page.getByRole("button", { name: "前往 Link 授权", exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, `editor-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "前往 Link 授权", exact: true }).click();
    await page.getByRole("button", { name: "允许只读访问", exact: true }).waitFor();
    await page.locator('textarea[name="repositories"]').fill("owner/repo");
    await page.getByRole("button", { name: "允许只读访问", exact: true }).click();
    await page.getByText("已连接 alice，授权已保存到原项目。", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).search, "");
    assert.equal(completes, 1);
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("codeshell.remote-link.authorization.v1")),
      null,
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(screenshots, `callback-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: "返回原项目", exact: true }).click();
    await page.getByText("GitHub · alice", { exact: true }).waitFor();
    await page.getByRole("button", { name: "断开", exact: true }).click();
    await page.getByRole("button", { name: "确认断开", exact: true }).click();
    await page.getByText("连接已断开。", { exact: true }).waitFor();
    const current = await (
      await context.request.get(hubOrigin + "/api/v1/links", { headers: { origin: hubOrigin } })
    ).json();
    assert.equal(current.connections.length, 0);
    const linkState = await (await request("/api/v1/links", { headers: { cookie } })).json();
    assert.ok(linkState.grants.length > 0 && linkState.grants.every((grant) => grant.revoked));
    assert.equal(completes, 1);
    // Refusal returns to the same Host and cancels the private attempt without exchanging a code.
    await page.getByRole("button", { name: "通过 Link 添加账号", exact: true }).click();
    await page.getByRole("button", { name: "前往 Link 授权", exact: true }).click();
    await page.getByRole("button", { name: "拒绝", exact: true }).click();
    await page.getByText("授权已取消，没有新增连接。", { exact: true }).waitFor();
    assert.equal(completes, 1);
    assert.deepEqual(failures, []);
    await context.close();
  }
  console.log(
    JSON.stringify({
      browser: "Chromium",
      widths: [390, 1440],
      realHub: true,
      realStandaloneLink: true,
      upstream: "controlled fixture",
      callback: true,
      refusal: true,
      disconnect: true,
      screenshots,
    }),
  );
} finally {
  await browser?.close();
  await hub?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
