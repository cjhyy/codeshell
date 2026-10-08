/* global window, document, sessionStorage */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const { chromium } = require("playwright");

/** Actual Web/Electron UI + independent system browser. Only the upstream OAuth response is controlled. */
export async function verifyCloudLinkBrowserUI({
  desktop,
  page,
  hubOrigin,
  issuer,
  screenshots,
  readLinkState,
}) {
  let browser, context;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dialogs = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept().catch(() => {});
  });
  const countWindows = () =>
    desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const initialWindows = desktop ? await countWindows() : undefined;
  const ownerCookieNames = new Set(
    desktop
      ? await desktop.evaluate(async ({ BrowserWindow }, origin) => {
          const window = BrowserWindow.getAllWindows().find((item) =>
            item.webContents.getURL().startsWith(origin),
          );
          return (await window.webContents.session.cookies.get({ url: origin })).map(
            (cookie) => cookie.name,
          );
        }, hubOrigin)
      : (await page.context().cookies(hubOrigin)).map((cookie) => cookie.name),
  );
  try {
    if (desktop) {
      await desktop.evaluate(({ shell }) => {
        process.__codeshellCloudBrowserFixture = { original: shell.openExternal, urls: [] };
        shell.openExternal = async (url) => {
          process.__codeshellCloudBrowserFixture.urls.push(String(url));
        };
      });
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
    } else context = page.context();
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
    await page.goto(hubOrigin + "/?view=links");
    const begin = async () => {
      const provider = page
        .locator(".links-provider")
        .filter({ has: page.getByRole("heading", { name: "GitHub", exact: true }) });
      await provider.getByRole("button", { name: "添加连接", exact: true }).click();
      const open = page.getByRole("button", { name: /^打开授权页面/ });
      await open.waitFor();
      let authorizationPage;
      if (desktop) {
        const before = await desktop.evaluate(
          () => process.__codeshellCloudBrowserFixture.urls.length,
        );
        await open.click();
        let launch;
        const deadline = Date.now() + 10_000;
        while (!launch) {
          launch = await desktop.evaluate(
            (_electron, index) => process.__codeshellCloudBrowserFixture.urls[index],
            before,
          );
          if (Date.now() >= deadline)
            throw new Error("Cloud window did not hand off to the system browser");
          if (!launch) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const url = new URL(launch);
        assert.equal(url.origin, hubOrigin);
        assert.equal(url.pathname, "/link/authorize");
        assert.match(url.searchParams.get("ticket"), /^[A-Za-z0-9_-]{43}$/);
        assert.ok(
          (await context.cookies(hubOrigin)).every((cookie) => !ownerCookieNames.has(cookie.name)),
          "System browser must not receive cloud owner cookies",
        );
        authorizationPage = await context.newPage();
        // Playwright's routes can miss a later URL in a server redirect chain.
        // Intercept only the real upstream navigation at Chromium's request stage.
        const cdp = await context.newCDPSession(authorizationPage);
        await cdp.send("Fetch.enable", {
          patterns: [{ urlPattern: "https://github.com/*", requestStage: "Request" }],
        });
        cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
          try {
            const target = new URL(request.url);
            assert.equal(target.pathname, "/login/oauth/authorize");
            assert.ok(target.searchParams.get("state"));
            const callback = new URL("/oauth/upstream/github/callback", issuer);
            callback.search = new URLSearchParams({
              code: "fixture-alice",
              state: target.searchParams.get("state"),
            }).toString();
            await cdp.send("Fetch.fulfillRequest", {
              requestId,
              responseCode: 303,
              responseHeaders: [{ name: "location", value: callback.href }],
            });
          } catch (error) {
            errors.push(error.message);
            await cdp
              .send("Fetch.failRequest", { requestId, errorReason: "Aborted" })
              .catch(() => {});
          }
        });
        await authorizationPage.goto(launch);
        assert.equal(
          await countWindows(),
          initialWindows,
          "OAuth must not create an embedded Electron window",
        );
      } else {
        const opened = page.waitForEvent("popup");
        await open.click();
        authorizationPage = await opened;
      }
      authorizationPage.setDefaultTimeout(15_000);
      authorizationPage.on("pageerror", (error) => errors.push(error.message));
      await authorizationPage
        .getByRole("button", { name: "允许读取和创建 Issue", exact: true })
        .waitFor()
        .catch(async (error) => {
          await authorizationPage.screenshot({
            path: join(screenshots, "external-consent-failure.png"),
            fullPage: true,
          });
          console.log(
            "External consent diagnostics",
            JSON.stringify({
              path: new URL(authorizationPage.url()).pathname,
              body: (await authorizationPage.locator("body").innerText()).slice(0, 900),
              screenshots,
            }),
          );
          throw error;
        });
      assert.equal(
        new URL(page.url()).origin,
        hubOrigin,
        "Original workbench remains on its own origin",
      );
      assert.equal(await authorizationPage.locator(".account-name").innerText(), "alice");
      assert.ok(!(await authorizationPage.locator("body").innerText()).includes("admin-private"));
      return authorizationPage;
    };
    let authorizationPage = await begin();
    await authorizationPage.screenshot({
      path: join(screenshots, "external-consent.png"),
      fullPage: true,
    });
    await authorizationPage.locator('input[type="checkbox"][value="owner/repo"]').check();
    await authorizationPage
      .getByRole("button", { name: "允许读取和创建 Issue", exact: true })
      .click();
    await authorizationPage
      .getByText("授权已处理。请返回原工作台查看连接结果；可以关闭此页面。", { exact: true })
      .waitFor();
    assert.equal(new URL(authorizationPage.url()).pathname, "/link/authorization-result");
    assert.equal(new URL(authorizationPage.url()).search, "");
    await page.getByText("GitHub · alice", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("codeshell.remote-link.authorization.v1")),
      null,
    );
    if (desktop) {
      assert.ok(ownerCookieNames.size > 0, "Fixture workbench has an authenticated owner");
      assert.ok(
        (await context.cookies(hubOrigin)).every((cookie) => !ownerCookieNames.has(cookie.name)),
        "Loopback ports share cookie hosts; only the Link browser cookie may be present",
      );
      assert.equal((await context.request.get(hubOrigin + "/api/v1/links")).status(), 401);
      assert.equal(await page.evaluate(() => typeof window.codeshell), "undefined");
    }
    await page.screenshot({ path: join(screenshots, "external-connected.png"), fullPage: true });
    await authorizationPage.close();
    await page.getByRole("button", { name: "断开", exact: true }).click();
    await page.getByRole("button", { name: "确认断开", exact: true }).click();
    await page.getByText("连接已断开。", { exact: true }).waitFor();
    const link = await readLinkState();
    assert.ok(link.grants.length > 0 && link.grants.every((grant) => grant.revoked));
    authorizationPage = await begin();
    await authorizationPage.getByRole("button", { name: "取消", exact: true }).click();
    await authorizationPage
      .getByText("授权已处理。请返回原工作台查看连接结果；可以关闭此页面。", { exact: true })
      .waitFor();
    await page.getByText("授权已取消。", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, [], "Browser handoff must preserve the workbench without navigation");
    await authorizationPage.close();
    return {
      mode: desktop ? "Electron + isolated system Chromium" : "Chromium popup",
      callbacks: "original owner and project",
      embeddedWindows: 0,
      upstream: "controlled fixture",
    };
  } finally {
    if (desktop)
      await desktop
        .evaluate(({ shell }) => {
          shell.openExternal = process.__codeshellCloudBrowserFixture.original;
          delete process.__codeshellCloudBrowserFixture;
        })
        .catch(() => {});
    if (browser) await browser.close();
  }
}
