/* global window, document, sessionStorage */
/** Real browser flow through the built Web app, Node Hub and independent Link.
 * GitHub responses are controlled; this does not claim a real provider login.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
// The verifier takes a separately built/selected service entry. No product depends on sibling sources.
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/smoke-remote-link-web.mjs /absolute/path/to/link-server/http.mjs [web|electron|paired|native] [candidate.app]",
  );
const { startLinkServer } = await import(pathToFileURL(resolve(process.argv[2])).href);
import { startHeadlessServer } from "../packages/server/dist/serve/headless-server.js";
import { resolveWorkerEntry } from "../packages/server/dist/serve/cli.js";
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const { chromium, _electron } = require("playwright");
import {
  launchCodeShellElectron,
  findCodeShellWindow,
} from "../packages/desktop/scripts/electron-harness.mjs";
import { verifyNativeLinkUI } from "./verify-native-link-ui.mjs";
import { verifyCloudLinkBrowserUI } from "./verify-cloud-link-browser-ui.mjs";
const mode = process.argv[3] ?? "web";
const packagedApplication = process.argv[4] ?? process.env.CODESHELL_LINK_SMOKE_APP;
assert.ok(
  !packagedApplication || mode === "native",
  "Packaged application is supported in native mode",
);
const widths = mode === "web" ? [390, 1440] : mode === "electron" ? [1280] : [390];
assert.ok(
  ["web", "electron", "paired", "native"].includes(mode),
  "Expected web, electron, paired or native mode",
);
let hub, browser, desktop, localWindow, paired;
let pairedProject;
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
let hubOrigin = `http://127.0.0.1:${hubPort}`;
const screenshots = await mkdtemp(join(tmpdir(), "codeshell-remote-link-web-ui-"));
const app = await startLinkServer({
  port,
  publicOrigin: issuer,
  ownerPassword: "long-private-fixture-password",
  databasePath: join(root, "link.sqlite"),
  masterKey: randomBytes(32),
  provider: {
    async begin(state) {
      return {
        url: `https://github.com/login/oauth/authorize?client_id=fixture-client&state=${state}`,
        verifier: "fixture",
      };
    },
    async exchange(url) {
      const code = url.searchParams.get("code");
      const accounts = {
        "fixture-alice": { id: "1", login: "alice" },
        "fixture-bob": { id: "2", login: "bob" },
        "admin-one": { id: "101", login: "admin-private-one" },
        "admin-two": { id: "102", login: "admin-private-two" },
      };
      assert.ok(accounts[code], "Unknown upstream fixture account");
      return {
        account: accounts[code],
        credential: { access_token: "UPSTREAM-ONLY-IN-LINK" },
      };
    },
    async repositories() {
      return { repositories: [{ fullName: "owner/repo", private: true }], truncated: false };
    },
    async action(action, input, credential, resources) {
      assert.equal(credential.access_token, "UPSTREAM-ONLY-IN-LINK");
      assert.deepEqual(resources, ["owner/repo"]);
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
  const seedUpstream = async (code) => {
    const upstream = await form(
      "/api/v1/links/providers/github/authorize",
      { csrf: snapshot.csrf },
      cookie,
    );
    const state = new URL(upstream.headers.get("location")).searchParams.get("state");
    assert.equal(
      (
        await request(`/oauth/upstream/github/callback?code=${code}&state=${state}`, {
          headers: { cookie },
        })
      ).status,
      303,
    );
  };
  // Admin-managed connections must never appear in public GitHub consent.
  await seedUpstream("admin-one");
  await seedUpstream("admin-two");
  if (mode !== "web") {
    const desktopHome = join(root, "desktop-home");
    const localProjects = [join(desktopHome, "project-a"), join(desktopHome, "project-b")];
    for (const project of localProjects) await mkdir(project, { recursive: true });
    pairedProject = await realpath(localProjects[0]);
    await mkdir(join(desktopHome, ".code-shell", "desktop"), { recursive: true });
    await writeFile(
      join(desktopHome, ".code-shell/settings.json"),
      JSON.stringify({ autoUpdates: false }),
    );
    await writeFile(
      join(desktopHome, ".code-shell/desktop/recents.json"),
      JSON.stringify(
        localProjects.map((path, i) => ({
          path,
          name: `Link project ${i ? "B" : "A"}`,
          lastOpenedAt: Date.now() - i,
        })),
      ),
    );
    if (packagedApplication) {
      const application = resolve(packagedApplication);
      const publicKeys = [
        "CODE_SHELL_REMOTE_LINK_ISSUER",
        "CODE_SHELL_REMOTE_LINK_CLIENT_ID",
        "CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN",
      ];
      const publicConfig = Object.fromEntries(
        publicKeys.map((key) => [
          key,
          execFileSync(
            "/usr/libexec/PlistBuddy",
            ["-c", `Print :LSEnvironment:${key}`, join(application, "Contents/Info.plist")],
            { encoding: "utf8" },
          ).trim(),
        ]),
      );
      assert.ok(
        publicKeys.every((key) => publicConfig[key]),
        "Missing bundled public Link configuration",
      );
      desktop = await _electron.launch({
        executablePath: join(application, "Contents/MacOS/code-shell"),
        args: [`--user-data-dir=${join(desktopHome, "electron-user-data")}`],
        cwd: localProjects[0],
        timeout: 30000,
        env: {
          ...process.env,
          HOME: desktopHome,
          USERPROFILE: desktopHome,
          CODE_SHELL_HOME: join(desktopHome, ".code-shell"),
          CODE_SHELL_NO_DEVTOOLS: "1",
          CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
          DISABLE_AUTOUPDATER: "1",
          ...publicConfig,
        },
      });
      assert.equal(await desktop.evaluate(({ app }) => app.isPackaged), true);
    } else {
      desktop = await launchCodeShellElectron({
        appDir: resolve("packages/desktop"),
        home: desktopHome,
      });
    }
    localWindow = await findCodeShellWindow(desktop);
    const viewOnly = localWindow.getByRole("button", { name: /仅查看|View only/i });
    if (
      await viewOnly.waitFor({ state: "visible", timeout: 2500 }).then(
        () => true,
        () => false,
      )
    )
      await viewOnly.click();
    for (const project of localProjects)
      await localWindow.evaluate((cwd) => window.codeshell.setTrust(cwd, "trusted"), project);
    if (mode === "paired") {
      // Exercise the real loopback fallback without opening a LAN listener. OAuth deliberately
      // rejects plaintext LAN callback addresses; production uses a registered HTTPS tunnel.
      await desktop.evaluate(() => {
        process.getBuiltinModule("os").networkInterfaces = () => ({});
        process.getBuiltinModule("module").syncBuiltinESMExports();
      });
      paired = await localWindow.evaluate(() =>
        window.codeshell.mobileRemote.start({ mode: "lan" }),
      );
      hubOrigin = new URL(paired.url).origin;
      assert.equal(new URL(hubOrigin).hostname, "127.0.0.1");
    }
  }
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
        name: "CodeShell",
        redirectUris: [
          mode === "native"
            ? "http://127.0.0.1:43827/link/callback"
            : hubOrigin + (mode === "paired" ? "/mobile/link/callback" : "/link/callback"),
        ],
      }),
    })
  ).json();
  if (mode === "native") {
    await verifyNativeLinkUI({
      desktop,
      win: localWindow,
      issuer,
      client,
      screenshots,
      readLinkState: async () => (await request("/api/v1/links", { headers: { cookie } })).json(),
    });
  } else {
    if (mode === "paired") {
      await desktop.evaluate((_electron, config) => Object.assign(process.env, config), {
        CODE_SHELL_REMOTE_LINK_WEB_ORIGIN: hubOrigin,
        CODE_SHELL_REMOTE_LINK_ISSUER: issuer,
        CODE_SHELL_REMOTE_LINK_CLIENT_ID: client.id,
      });
    } else
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
    if (mode !== "electron") browser = await chromium.launch({ headless: true });
    for (const width of widths) {
      let context, page;
      if (mode === "electron") {
        const opened = desktop.waitForEvent("window");
        await localWindow.evaluate((url) => window.codeshell.openCloudWorkbench(url), hubOrigin);
        page = await opened;
        await page.waitForURL(hubOrigin + "/");
        context = page.context();
      } else {
        context = await browser.newContext({ viewport: { width, height: 1000 } });
        page = await context.newPage();
      }
      const setup = width === 390;
      if (mode === "web") {
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
      } else if (mode === "electron") {
        assert.equal(await page.evaluate(() => typeof window.codeshell), "undefined");
        assert.equal(
          await page.evaluate(
            async ({ origin, token }) =>
              (
                await fetch(origin + "/api/v1/auth/setup", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    username: "admin",
                    password: "fixture-password-at-least-sixteen",
                    token,
                  }),
                })
              ).status,
            { origin: hubOrigin, token: hub.bootstrapToken },
          ),
          200,
        );
      }
      if (mode === "web" || mode === "electron") {
        console.log(
          "Link browser handoff:",
          JSON.stringify(
            await verifyCloudLinkBrowserUI({
              desktop: mode === "electron" ? desktop : undefined,
              page,
              hubOrigin,
              issuer,
              screenshots,
              readLinkState: async () =>
                (await request("/api/v1/links", { headers: { cookie } })).json(),
            }),
          ),
        );
        if (mode === "electron") await page.close();
        else await context.close();
        continue;
      }
      if (mode === "electron") {
        // This remote BrowserWindow also uses an isolated Electron Session.
        await desktop.evaluate(
          ({ BrowserWindow }, { hubOrigin, issuer }) => {
            const window = BrowserWindow.getAllWindows().find((item) =>
              item.webContents.getURL().startsWith(hubOrigin),
            );
            if (!window) throw new Error("Missing remote workbench window");
            window.webContents.session.webRequest.onBeforeRequest(
              { urls: ["https://github.com/*"] },
              (details, done) => {
                const target = new URL(details.url);
                if (
                  details.resourceType !== "mainFrame" ||
                  target.pathname !== "/login/oauth/authorize"
                )
                  return done({ cancel: true });
                const callback = new URL("/oauth/upstream/github/callback", issuer);
                callback.search = new URLSearchParams({
                  code: "fixture-alice",
                  state: target.searchParams.get("state"),
                }).toString();
                done({ redirectURL: callback.href });
              },
            );
          },
          { hubOrigin, issuer },
        );
      } else {
        // Playwright routes only the first URL in a server redirect chain.
        // Replace the provider redirect at the issuer, preserving its browser cookie.
        await context.route(issuer + "/oauth/authorize?**", async (route) => {
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
          const location = response.headers().location;
          if (location && new URL(location, issuer).origin === "https://github.com") {
            const target = new URL(location);
            assert.equal(target.pathname, "/login/oauth/authorize");
            const callback = new URL("/oauth/upstream/github/callback", issuer);
            callback.search = new URLSearchParams({
              code: "fixture-alice",
              state: target.searchParams.get("state"),
            }).toString();
            return route.fulfill({
              response,
              headers: { ...response.headers(), location: callback.href },
            });
          }
          return route.fulfill({ response });
        });
        await context.route("https://github.com/**", (route) => route.abort());
      }
      page.setDefaultTimeout(15000);
      const failures = [],
        dialogs = [];
      page.on("dialog", (dialog) => {
        dialogs.push(dialog.type());
        void dialog.accept().catch(() => {});
      });
      let completes = 0;
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("request", (request) => {
        if (request.method() === "POST" && /\/authorizations\/[^/]+\/complete/.test(request.url()))
          completes++;
      });
      if (mode === "paired") {
        await page.goto(paired.pairingUrl);
        await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
        await page
          .getByRole("combobox", { name: "选择项目", exact: true })
          .selectOption({ label: "Link project A" });
        await page.getByRole("button", { name: "Link", exact: true }).click();
      } else await page.goto(hubOrigin + "/?view=links");
      const beginGitHubAuthorization = async () => {
        const provider = page.locator(".links-provider").filter({
          has: page.getByRole("heading", { name: "GitHub", exact: true }),
        });
        await provider.getByRole("button", { name: "添加连接", exact: true }).click();
      };
      console.log("Link verifier: opening authorization", mode);
      await page.locator(".links-provider").first().waitFor();
      await page.screenshot({ path: join(screenshots, `catalog-${width}.png`), fullPage: true });
      let pendingJob;
      if (mode === "paired")
        await page.route(/\/api\/v1\/links\/authorizations(?:\/remote)?(?:\?|$)/, async (route) => {
          // Observe the genuine creation response before cross-origin navigation discards its body.
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
          pendingJob = await response.json();
          await route.fulfill({ response });
        });
      await beginGitHubAuthorization();
      console.log("Link verifier: waiting for public GitHub consent", mode);
      await page
        .getByRole("button", { name: "允许读取和创建 Issue", exact: true })
        .waitFor()
        .catch(async (error) => {
          await page.screenshot({
            path: join(screenshots, `consent-failure-${width}.png`),
            fullPage: true,
          });
          console.log(
            "Public consent diagnostics",
            JSON.stringify({
              path: new URL(page.url()).pathname,
              body: (await page.locator("body").innerText()).slice(0, 800),
              screenshots,
            }),
          );
          throw error;
        });
      assert.equal(await page.locator('input[name="password"]').count(), 0);
      assert.equal(await page.locator(".account-name").innerText(), "alice");
      assert.ok(!(await page.locator("body").innerText()).includes("admin-private"));
      assert.equal(await page.locator('select[name="connectionId"]').count(), 0);
      await page.screenshot({ path: join(screenshots, `consent-${width}.png`), fullPage: true });
      if (mode === "electron") {
        assert.equal(await page.evaluate(() => typeof window.codeshell), "undefined");
        assert.equal(
          await desktop.evaluate(
            ({ BrowserWindow }, origin) =>
              BrowserWindow.getAllWindows()
                .find((w) => w.webContents.getURL().startsWith(origin))
                ?.getTitle(),
            issuer,
          ),
          `Link 授权 · ${new URL(issuer).host}`,
        );
      }
      if (mode === "paired") {
        const otherProject = await realpath(join(root, "desktop-home/project-b"));
        const wrongProject = await context.request.post(
          hubOrigin +
            `/api/v1/links/authorizations/${pendingJob.id}/complete?workspace=` +
            encodeURIComponent(otherProject),
          {
            headers: { origin: hubOrigin },
            data: { callbackUrl: hubOrigin + "/mobile/link/callback?code=unused&state=wrong" },
          },
        );
        assert.equal(
          wrongProject.status(),
          404,
          "An attempt belongs to its original project handler",
        );
      }
      await page.locator('input[type="checkbox"][value="owner/repo"]').check();
      await page.getByRole("button", { name: "允许读取和创建 Issue", exact: true }).click();
      await page.getByText("已连接 alice，授权已保存到原项目。", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).search, "");
      assert.equal(completes, 1);
      assert.equal(
        await page.evaluate(() => sessionStorage.getItem("codeshell.remote-link.authorization.v1")),
        null,
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      await page.screenshot({ path: join(screenshots, `callback-${width}.png`), fullPage: true });
      await page.getByRole("link", { name: "返回原项目", exact: true }).click();
      await page.getByText("GitHub · alice", { exact: true }).waitFor();
      if (mode === "paired") {
        const back = new URL(page.url());
        assert.equal(back.pathname, "/mobile/");
        assert.equal(back.searchParams.get("workspace"), pairedProject);
        const wrong = await page.evaluate(
          async (cwd) => {
            const response = await fetch(
              "/api/v1/links/authorizations/00000000-0000-4000-8000-000000000000?workspace=" +
                encodeURIComponent(cwd),
            );
            return response.status;
          },
          join(root, "outside-project"),
        );
        assert.equal(wrong, 403);
      }
      await page.getByRole("button", { name: "断开", exact: true }).click();
      await page.getByRole("button", { name: "确认断开", exact: true }).click();
      await page.getByText("连接已断开。", { exact: true }).waitFor();
      const current = await page.evaluate(
        async (workspace) =>
          (
            await fetch(
              "/api/v1/links" + (workspace ? "?workspace=" + encodeURIComponent(workspace) : ""),
            )
          ).json(),
        mode === "paired" ? pairedProject : undefined,
      );
      assert.equal(current.connections.length, 0);
      const linkState = await (await request("/api/v1/links", { headers: { cookie } })).json();
      assert.ok(linkState.grants.length > 0 && linkState.grants.every((grant) => grant.revoked));
      assert.equal(completes, 1);
      // Refusal returns to the same Host and cancels the private attempt without exchanging a code.
      await beginGitHubAuthorization();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByText("授权已取消，没有新增连接。", { exact: true }).waitFor();
      assert.equal(completes, 1);
      if (mode === "paired") {
        await page.getByRole("link", { name: "返回原项目", exact: true }).click();
        await beginGitHubAuthorization();
        await page.getByRole("button", { name: "允许读取和创建 Issue", exact: true }).waitFor();
        const devices = await localWindow.evaluate(() =>
          window.codeshell.mobileRemote.listDevices(),
        );
        assert.equal(devices.length, 1);
        await localWindow.evaluate(
          (id) => window.codeshell.mobileRemote.revokeDevice(id),
          devices[0].id,
        );
        await page.locator('input[type="checkbox"][value="owner/repo"]').check();
        await page.getByRole("button", { name: "允许读取和创建 Issue", exact: true }).click();
        await page
          .getByText("原登录已失效。请返回工作台登录，并重新发起授权。", { exact: true })
          .waitFor();
        const credentials = await localWindow.evaluate(
          (cwd) => window.codeshell.credentials.list(cwd),
          pairedProject,
        );
        assert.ok(
          !credentials.some((c) => c.id.startsWith("link-remote-")),
          "Revoked device saved a connection",
        );
        assert.equal(completes, 2);
      }
      if (mode === "electron") {
        await desktop.evaluate(({ BrowserWindow }, origin) => {
          const contents = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith(origin),
          ).webContents;
          contents.once("will-navigate", (event) => {
            contents.__blockedLinkNavigation = event.defaultPrevented;
          });
        }, hubOrigin);
        await page.evaluate(() => {
          window.location.assign("https://unrelated.invalid/");
        });
        assert.equal(
          await desktop.evaluate(
            ({ BrowserWindow }, origin) =>
              BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(origin))
                ?.webContents.__blockedLinkNavigation,
            hubOrigin,
          ),
          true,
        );
        assert.equal(new URL(page.url()).origin, hubOrigin);
      }
      assert.deepEqual(failures, []);
      assert.deepEqual(dialogs, [], "OAuth submit must not trigger an unsaved editor dialog");
      if (mode === "electron") await page.close();
      else await context.close();
    }
    console.log(
      JSON.stringify({
        browser: mode === "electron" ? "Electron" : "Chromium",
        mode,
        widths,
        realHub: mode !== "paired",
        realDesktop: mode !== "web",
        realStandaloneLink: true,
        upstream: "controlled fixture",
        noLinkLogin: true,
        adminConnectionsHidden: true,
        callback: true,
        refusal: true,
        disconnect: true,
        revokedDeviceCallbackRejected: mode === "paired",
        screenshots,
      }),
    );
  }
} catch (error) {
  console.error(
    String(error instanceof Error ? error.message : error).replace(
      /https?:\/\/[^\s"'<>]+/g,
      "[redacted-url]",
    ),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (desktop) {
    const child = desktop.process();
    let timer;
    await Promise.race([
      desktop.close().catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  await hub?.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
