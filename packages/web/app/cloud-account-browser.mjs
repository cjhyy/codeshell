/** Production Web entry against a controlled loopback HTTP authority fixture.
 * No Account bearer, provider, worker, real Cloud authority or physical device.
 * Build Web first; invoke with Node and an optional absolute receipt path.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const staticRoot = resolve(here, "../dist-app");
const { chromium } = createRequire(join(root, "packages/desktop/package.json"))("playwright");
const executablePath = chromium.executablePath();
await access(executablePath);
const scratch = await mkdtemp(join(tmpdir(), "codeshell-cloud-web-browser-"));
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const checks = [];
let state, origin, browser;
const requests = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.host, new URL(origin).host);
    const path = new URL(req.url, origin).pathname;
    requests.push({ method: req.method, path });
    function json(value, status = 200) {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    }
    if (path === "/api/v1/auth/status") {
      const value = {
        initialized: true,
        mode: "cloud-account",
        authenticated: state.authenticated,
        ...(state.authenticated ? { session: { ...state.session } } : {}),
      };
      if (state.delayStatus) {
        state.pendingStatus.push(() => json(value));
        return;
      }
      if (state.statusCode) return json({ error: "fixture authority refused" }, state.statusCode);
      return json(value);
    }
    if (path === "/api/v1/auth/logout") {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, undefined);
      let raw = "";
      for await (const chunk of req) raw += chunk;
      assert.equal(raw, "{}");
      if (!state.confirmLogout) return json({ authenticated: false });
      state.authenticated = false;
      return json({ revoked: true });
    }
    if (path === "/api/v1/projects") {
      if (state.projectCode) return json({}, state.projectCode);
      return json({
        runtime: "docker",
        available: true,
        projects: [
          {
            id: projectId,
            name: "Controlled Cloud project",
            status: "running",
            generation: 1,
            createdAt: 1,
          },
        ],
      });
    }
    if (path.includes("/api/v1/configuration"))
      return json({
        workspace: { path: "/controlled", settingsScope: "local", skillDirectories: [] },
        defaults: {},
        connections: [],
        catalog: [],
        skills: [],
        mcpServers: [],
        restartRequired: false,
      });
    if (path.startsWith("/api/")) return json({ error: "unexpected controlled API" }, 404);
    const file = path.startsWith("/assets/")
      ? resolve(staticRoot, `.${path}`)
      : join(staticRoot, "index.html");
    assert.ok(file.startsWith(staticRoot + "/"));
    const bytes = await readFile(file);
    res.writeHead(200, {
      "content-type": path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    res.end(bytes);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end("controlled fixture failed");
  }
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath,
    headless: true,
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      USERPROFILE: scratch,
      XDG_CONFIG_HOME: scratch,
      XDG_CACHE_HOME: scratch,
      TMPDIR: tmpdir(),
    },
  });
  for (const width of [390, 1440]) {
    state = {
      authenticated: false,
      confirmLogout: true,
      pendingStatus: [],
      session: {
        id: randomUUID(),
        kind: "cloud-management",
        audience: origin,
        installationId: randomUUID(),
        accountOrigin: "https://accounts.fixture.invalid",
        accountId: randomUUID(),
        managementEpoch: randomUUID(),
        expiresAt: Date.now() + 600_000,
      },
    };
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      serviceWorkers: "block",
    });
    const unexpected = [];
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      unexpected.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    // This test proves the built auth/project UI. It deliberately does not
    // claim a worker or WebSocket consumer; no socket leaves the fixture.
    await context.routeWebSocket("**/*", (socket) => socket.close({ code: 1000 }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const visible = async (label) =>
      page.getByRole("button", { name: label, exact: true }).waitFor();
    const focus = () =>
      page.evaluate(() => globalThis.window.dispatchEvent(new globalThis.Event("focus")));
    async function enter() {
      state.authenticated = true;
      state.statusCode = 0;
      state.projectCode = 0;
      state.session.id = randomUUID();
      await page.goto(`${origin}/?project=${projectId}`);
      await page.locator(".workbench-main").waitFor();
      if (width === 390) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
      await visible("退出此 Cloud 工作台");
    }
    state.statusCode = 401;
    await page.goto(origin);
    await visible("重试连接");
    assert.equal(await page.locator("input[type=password]").count(), 0);
    state.statusCode = 0;
    await page.getByRole("button", { name: "重试连接", exact: true }).click();
    await visible("重新检查 Cloud 登录");
    assert.equal(await page.locator("input[type=password]").count(), 0);
    checks.push(`${width}:cold-401-retries-without-guessing-Hub-login`);
    checks.push(`${width}:signed-out-Cloud-instruction`);
    await enter();
    assert.equal(await page.getByText("设备与退出", { exact: true }).count(), 0);
    assert.equal(await page.getByText("账号与设备", { exact: true }).count(), 0);
    checks.push(`${width}:real-project-route-no-Hub-devices`);
    if (width === 390)
      await page
        .getByRole("dialog", { name: "工作台导航", exact: true })
        .getByRole("button", { name: "收起侧栏", exact: true })
        .click();
    await page
      .getByRole("textbox", { name: "任务内容", exact: true })
      .fill("old scoped session draft");
    state.session.id = randomUUID();
    await focus();
    await page.waitForFunction(() => globalThis.document.querySelector("textarea")?.value === "");
    if (width === 390) await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await visible("退出此 Cloud 工作台");
    checks.push(`${width}:same-account-new-grant-remounts-old-draft`);
    state.confirmLogout = false;
    await page.getByRole("button", { name: "退出此 Cloud 工作台", exact: true }).click();
    await page.getByText(/未能确认退出/).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "退出此 Cloud 工作台", exact: true }).isEnabled(),
      true,
    );
    state.confirmLogout = true;
    await page.getByRole("button", { name: "退出此 Cloud 工作台", exact: true }).click();
    await visible("重新检查 Cloud 登录");
    checks.push(`${width}:unconfirmed-logout-retry-confirmed-exit`);
    await enter();
    state.statusCode = 401;
    await focus();
    await visible("重新检查 Cloud 登录");
    assert.equal(await page.locator("input[type=password]").count(), 0);
    checks.push(`${width}:authority-401-gates-Cloud`);
    await enter();
    state.statusCode = 404;
    await focus();
    await visible("重新检查 Cloud 登录");
    checks.push(`${width}:known-Cloud-cannot-downgrade`);
    await enter();
    state.delayStatus = true;
    const pending = page.waitForRequest((req) => req.url() === origin + "/api/v1/auth/status");
    await focus();
    await pending;
    await page.getByRole("button", { name: "退出此 Cloud 工作台", exact: true }).click();
    await visible("重新检查 Cloud 登录");
    state.delayStatus = false;
    for (const release of state.pendingStatus.splice(0)) release();
    await page.waitForLoadState("networkidle");
    await visible("重新检查 Cloud 登录");
    checks.push(`${width}:late-status-cannot-reopen-after-logout`);
    state.authenticated = true;
    state.projectCode = 404;
    await page.goto(`${origin}/?project=${projectId}`);
    await visible("刷新项目");
    assert.equal(await page.locator(".workbench-main").count(), 0);
    await visible("退出此 Cloud 工作台");
    checks.push(`${width}:project-404-does-not-open-legacy-workspace`);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.window.innerWidth,
      ),
      false,
    );
    checks.push(`${width}:no-horizontal-overflow-or-page-errors`);
    await context.close();
  }
  assert.equal(
    requests.some(({ path }) => /auth\/(setup|login|sessions)/.test(path)),
    false,
  );
  const receipt = {
    version: 1,
    phase: "controlled-production-Web-entry",
    node: process.version,
    browser: browser.version(),
    widths: [390, 1440],
    checks,
    indexSha256: createHash("sha256")
      .update(await readFile(join(staticRoot, "index.html")))
      .digest("hex"),
    physicalMobile: false,
    productionAuthority: false,
    realWebSocketConsumer: false,
    providerCalls: 0,
    credentialExchangeCalls: 0,
  };
  if (process.argv[2])
    await writeFile(resolve(process.argv[2]), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const release of state?.pendingStatus ?? []) release();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}
