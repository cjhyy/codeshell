/* global window */
/* Real Desktop UI and standalone Link HTTP, using an isolated system-browser fixture. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const { chromium } = require("playwright");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error) =>
  String(error instanceof Error ? error.message : error).replace(
    /https?:\/\/[^\s"'<>]+/g,
    "[redacted-url]",
  );
async function until(read, accept, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await sleep(50);
  }
  throw new Error(message);
}
function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
export async function verifyNativeLinkUI({
  desktop,
  win,
  issuer,
  client,
  readLinkState,
  screenshots,
}) {
  const errors = [];
  const onError = (error) => errors.push(safeError(error));
  win.on("pageerror", onError);
  win.setDefaultTimeout(15000);
  const callback = new URL(client.redirectUris[0]);
  assert.equal(callback.hostname, "127.0.0.1");
  assert.equal(callback.pathname, "/link/callback");
  const port = Number(callback.port);
  assert.equal(await listening(port), false, "Fixture callback port is already occupied");
  let browser;
  try {
    await desktop.evaluate(
      ({ shell, safeStorage }, config) => {
        Object.assign(process.env, config);
        process.__codeshellSystemBrowserFixture = {
          original: shell.openExternal,
          encryptionAvailable: safeStorage.isEncryptionAvailable,
          urls: [],
        };
        // Intercept only the Electron adapter. Never change OS registrations or user browser profiles.
        shell.openExternal = async (url) => {
          process.__codeshellSystemBrowserFixture.urls.push(String(url));
        };
        // The temporary store exercises the shipped fallback without touching the user's keychain.
        safeStorage.isEncryptionAvailable = () => false;
      },
      {
        CODE_SHELL_REMOTE_LINK_ISSUER: issuer,
        CODE_SHELL_REMOTE_LINK_CLIENT_ID: client.id,
        CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN: callback.origin,
      },
    );
    const windowCount = () =>
      desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const originalWindows = await windowCount();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 660, height: 900 } });
    let githubNavigations = 0,
      linkLogins = 0;
    let accountCode = "fixture-alice",
      holdCallback = false,
      heldCallback;
    await context.route("**/*", async (route) => {
      try {
        const target = new URL(route.request().url());
        if (target.origin === callback.origin) return route.continue();
        if (target.origin !== issuer) return route.abort();
        if (target.pathname === "/login") linkLogins++;
        // Playwright routes only the first URL in a redirect chain. Replace the
        // provider redirect at the issuer, preserving the real service cookies.
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
        const location = response.headers().location;
        const next = location ? new URL(location, issuer) : undefined;
        if (next?.origin === "https://github.com") {
          assert.equal(next.pathname, "/login/oauth/authorize");
          githubNavigations++;
          const upstream = new URL("/oauth/upstream/github/callback", issuer);
          upstream.search = new URLSearchParams({
            code: accountCode,
            state: next.searchParams.get("state"),
          }).toString();
          return route.fulfill({
            response,
            headers: { ...response.headers(), location: upstream.href },
          });
        }
        if (
          holdCallback &&
          next?.origin === callback.origin &&
          next.pathname === callback.pathname
        ) {
          heldCallback = next.href;
          return route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "Callback held by isolated fixture",
          });
        }
        return route.fulfill({ response });
      } catch (error) {
        errors.push(safeError(error));
        return route.abort();
      }
    });
    await win.setViewportSize({ width: 1440, height: 1000 });
    const openLinks = async () => {
      await win.getByRole("button", { name: /^(凭证|Credentials)$/ }).click();
      await win.getByRole("tab", { name: /^Link(?:\s|$)/ }).click();
      await win.locator('[data-link-integration="github"][data-link-runtime="server"]').waitFor();
    };
    await openLinks();
    const section = win.locator('[data-link-integration="github"][data-link-runtime="server"]');
    const management = win.getByRole("dialog");
    const manage = async () => {
      await section.getByRole("button", { name: /^(管理|Manage)$/ }).click();
      await management.locator("[data-remote-link]").first().waitFor();
    };
    const snapshot = () => win.evaluate(() => window.codeshell.links.remoteSnapshot(""));
    const count = async () =>
      (await snapshot()).connections.filter((item) => item.authSource === "remote-link").length;
    assert.equal(await section.locator("input").count(), 0);
    assert.equal(await section.getByText(issuer, { exact: true }).count(), 0);
    assert.equal(
      await win.getByRole("heading", { name: "独立 Link 服务", exact: true }).count(),
      0,
    );
    await win.screenshot({ path: join(screenshots, "native-connect-1440.png"), fullPage: true });
    async function start(button, account = "alice") {
      accountCode = `fixture-${account}`;
      const previous = await desktop.evaluate(
        () => process.__codeshellSystemBrowserFixture.urls.length,
      );
      await button.click();
      await management.locator('[data-link-authorization-step="redirect"]').waitFor();
      const urls = await until(
        () => desktop.evaluate(() => process.__codeshellSystemBrowserFixture.urls),
        (values) => values.length > previous,
        "Desktop did not dispatch authorization to the system browser",
      );
      assert.equal(urls.length, previous + 1);
      const url = urls.at(-1);
      assert.ok(new URL(url).origin === issuer, "Unexpected authorization issuer");
      assert.equal(
        await windowCount(),
        originalWindows,
        "Authorization created an Electron BrowserWindow",
      );
      assert.equal(await listening(port), true, "Pending authorization has no loopback receiver");
      const auth = await context.newPage();
      auth.setDefaultTimeout(15000);
      auth.on("pageerror", onError);
      await auth.goto(url);
      await auth.getByRole("button", { name: "允许只读访问", exact: true }).waitFor();
      assert.ok(new URL(auth.url()).origin === issuer);
      assert.equal(await auth.evaluate(() => typeof window.codeshell), "undefined");
      return auth;
    }
    async function prepareConsent(auth, account = "alice") {
      await auth.getByRole("heading", { name: "连接 GitHub", exact: true }).waitFor();
      assert.equal(await auth.locator('input[name="password"]').count(), 0);
      assert.equal(await auth.locator('select[name="connectionId"]').count(), 0);
      assert.ok(!(await auth.locator("body").innerText()).includes("admin-"));
      if ((await auth.locator(".account-name").innerText()) !== account) {
        accountCode = `fixture-${account}`;
        await auth.getByRole("button", { name: "使用其他 GitHub 账号", exact: true }).click();
        await auth.locator(".account-name").filter({ hasText: account }).waitFor();
      }
      assert.equal(await auth.locator(".account-name").innerText(), account);
      await auth.locator('input[type="checkbox"][value="owner/repo"]').check();
      const bounds = await auth.getByRole("button", { name: "取消", exact: true }).boundingBox();
      assert.ok(
        bounds && bounds.y + bounds.height <= (await auth.evaluate(() => window.innerHeight)),
      );
    }
    async function consent(auth, deny = false, account = "alice") {
      await prepareConsent(auth, account);
      await auth.screenshot({
        path: join(screenshots, `native-consent-${account}.png`),
        fullPage: true,
        animations: "disabled",
      });
      await auth.getByRole("button", { name: deny ? "取消" : "允许只读访问", exact: true }).click();
      if (deny) {
        await auth.getByText("授权响应已处理", { exact: true }).waitFor();
        assert.equal(await auth.getByText("连接已完成", { exact: true }).count(), 0);
        await management
          .getByText(/授权已取消|授权未完成|Authorization cancelled|Authorization did not complete/)
          .first()
          .waitFor();
        await management.getByRole("button", { name: /^(取消|Cancel)$/ }).click();
      } else {
        await auth.getByText("连接已完成", { exact: true }).waitFor();
        await management
          .getByRole("heading", { name: /^(已连接 GitHub|Connected GitHub)$/ })
          .waitFor();
        await management.getByRole("button", { name: /^(完成|Done)$/ }).click();
      }
      await management.waitFor({ state: "hidden" });
      await until(
        () => listening(port),
        (value) => !value,
        "Terminal authorization retained its loopback receiver",
      );
      assert.equal(await windowCount(), originalWindows);
      await auth.close();
    }
    await consent(await start(section.getByRole("button", { name: /^(连接|Connect)$/ })));
    assert.ok(githubNavigations >= 1, "First authorization must pass through the upstream fixture");
    await manage();
    await consent(
      await start(management.getByRole("button", { name: "添加账号", exact: true }), "bob"),
      false,
      "bob",
    );
    assert.ok(githubNavigations >= 2, "Another account requires its own upstream proof");
    await manage();
    assert.equal(await management.locator("[data-remote-link]").count(), 2);
    const alice = management.locator("[data-remote-link]").filter({ hasText: "alice" });
    const id = await alice.getAttribute("data-remote-link");
    await alice.getByRole("button", { name: "改名", exact: true }).click();
    await alice.getByLabel("新的连接名称", { exact: true }).fill("Renamed native account");
    await alice.getByRole("button", { name: "保存名称", exact: true }).click();
    await alice.getByText("Renamed native account", { exact: true }).waitFor();
    const stateBefore = await readLinkState();
    await consent(await start(alice.getByRole("button", { name: "重新授权", exact: true })));
    const stateAfter = await readLinkState();
    assert.equal(stateAfter.grants.length, stateBefore.grants.length + 1);
    assert.ok(stateAfter.grants.some((grant) => grant.revoked));
    const savedGrantIds = stateAfter.grants.map((grant) => grant.id);
    const masked = await snapshot();
    const visible = JSON.stringify(masked);
    assert.deepEqual(
      masked.connections
        .filter((c) => c.authSource === "remote-link")
        .map((c) => c.account.label)
        .sort(),
      ["alice", "bob"],
    );
    assert.ok(!visible.includes("UPSTREAM-ONLY-IN-LINK"));
    assert.ok(
      !visible.includes("accessToken") &&
        !visible.includes("refreshToken") &&
        !visible.includes("verifier"),
    );
    // The generic credential and MCP routes cannot silently erase or reconfigure a Link grant.
    for (const action of ["remove", "save", "patch", "mcpRefresh", "mcpLogout", "mcpLogin"]) {
      const rejected = await win.evaluate(
        async ({ id, action }) => {
          try {
            if (action === "remove") await window.codeshell.credentials.remove("", "user", id);
            else if (action === "save")
              await window.codeshell.credentials.save("", "user", {
                id,
                type: "token",
                label: "overwrite",
                secret: "replacement",
              });
            else if (action === "mcpRefresh") await window.codeshell.mcpOAuth.refresh(id);
            else if (action === "mcpLogin")
              await window.codeshell.mcpOAuth.login({
                source: "catalog",
                profileId: "github",
                credentialId: id,
              });
            else if (action === "patch")
              await window.codeshell.credentials.patchMeta("", "user", id, { label: "bypass" });
            else await window.codeshell.mcpOAuth.logout(id);
            return false;
          } catch (error) {
            return error.message.includes("Link");
          }
        },
        { id, action },
      );
      assert.equal(rejected, true);
    }

    await manage();
    await win.screenshot({
      path: join(screenshots, "native-connections-1440.png"),
      fullPage: true,
      animations: "disabled",
    });
    await consent(
      await start(management.getByRole("button", { name: "添加账号", exact: true })),
      true,
    );
    assert.equal(await count(), 2);
    async function holdSuccessfulCallback() {
      await manage();
      const auth = await start(management.getByRole("button", { name: "添加账号", exact: true }));
      await prepareConsent(auth);
      heldCallback = undefined;
      holdCallback = true;
      await auth.getByRole("button", { name: "允许只读访问", exact: true }).click();
      const url = await until(
        () => Promise.resolve(heldCallback),
        Boolean,
        "Fixture did not capture the callback",
      );
      holdCallback = false;
      assert.equal(await listening(port), true);
      assert.equal(await count(), 2);
      return { auth, url };
    }
    async function rejectLateCallback(url, receiverActive = false) {
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      assert.ok(
        receiverActive ? response && response.status >= 400 : !response || response.status >= 400,
        "Late callback was accepted or did not reach the active receiver",
      );
      await response?.body?.cancel();
      assert.equal(await count(), 2, "Late callback saved a connection");
    }
    const cancelled = await holdSuccessfulCallback();
    await management.getByRole("button", { name: /^(取消|Cancel)$/ }).click();
    await management.waitFor({ state: "hidden" });
    await until(
      () => listening(port),
      (value) => !value,
      "Cancel retained the loopback receiver",
    );
    await rejectLateCallback(cancelled.url);
    await cancelled.auth.close();
    // Reject old state even when the fixed port belongs to a new authorization attempt.
    await manage();
    const replacement = await start(
      management.getByRole("button", { name: "添加账号", exact: true }),
    );
    await rejectLateCallback(cancelled.url, true);
    await management.locator('[data-link-authorization-step="redirect"]').waitFor();
    await management.getByRole("button", { name: /^(取消|Cancel)$/ }).click();
    await management.waitFor({ state: "hidden" });
    await replacement.close();
    await until(
      () => listening(port),
      (value) => !value,
      "Replacement cancel retained its receiver",
    );
    const orphan = await holdSuccessfulCallback();
    await win.reload();
    await until(
      () => listening(port),
      (value) => !value,
      "Owner refresh retained its receiver",
    );
    await rejectLateCallback(orphan.url);
    await orphan.auth.close();
    await openLinks();
    await manage();
    assert.equal(await management.locator("[data-remote-link]").count(), 2);
    for (const current of (await snapshot()).connections.filter(
      (c) => c.authSource === "remote-link",
    )) {
      const card = management.locator(`[data-remote-link="${current.id}"]`);
      await card.getByRole("button", { name: "断开", exact: true }).click();
      await card.getByRole("button", { name: "确认断开", exact: true }).click();
      await card.waitFor({ state: "detached" });
    }
    const finalState = await readLinkState();
    assert.ok(
      finalState.grants
        .filter((grant) => savedGrantIds.includes(grant.id))
        .every((grant) => grant.revoked),
    );
    assert.equal(await count(), 0);
    assert.equal(linkLogins, 0);
    assert.equal(await windowCount(), originalWindows);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        mode: "native",
        realDesktop: true,
        realStandaloneLink: true,
        systemBrowserAdapter: "isolated Chromium fixture",
        credentialCipher: "isolated temporary store using shipped plaintext fallback",
        noExtraElectronWindow: true,
        loopbackCallback: true,
        callbackPageWaitsForHostSave: true,
        denialNeverClaimsSaved: true,
        multipleAccounts: true,
        noLinkLogin: true,
        adminConnectionsHidden: true,
        rename: true,
        reauthorize: true,
        denial: true,
        cancel: true,
        lateCallbackRejected: true,
        ownerReload: true,
        genericMutationRejected: true,
        remoteDisconnect: true,
        screenshots,
      }),
    );
  } catch (error) {
    throw new Error(safeError(error), { cause: error });
  } finally {
    win.off("pageerror", onError);
    await browser?.close();
    await desktop
      .evaluate(({ shell, safeStorage }) => {
        if (process.__codeshellSystemBrowserFixture) {
          shell.openExternal = process.__codeshellSystemBrowserFixture.original;
          safeStorage.isEncryptionAvailable =
            process.__codeshellSystemBrowserFixture.encryptionAvailable;
          delete process.__codeshellSystemBrowserFixture;
        }
      })
      .catch(() => {});
  }
}
