/* global window, document */
/** Owned browser verification for Desktop's selected-computer web entry.
 * Account, Passkey and relay replies are fixtures; no real credentials or hosts are used. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, path.join(process.env.HOME, ".code-shell"));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(path.join(repo, "packages/desktop/package.json"));
const { build } = require("esbuild");
const { chromium } = require("playwright");
const output = await mkdtemp(path.join(tmpdir(), "codeshell-selected-computer-"));
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WebsiteEntry} from './WebsiteShell.js';
      window.fixturePasskeys=0;
      Object.defineProperty(navigator,'credentials',{value:{get:async()=>{window.fixturePasskeys++;if(window.fixtureCancel)throw new DOMException('Fixture cancellation','NotAllowedError');const bytes=new Uint8Array([1,2,3]).buffer;return{id:'AQID',rawId:bytes,type:'public-key',response:{authenticatorData:bytes,clientDataJSON:bytes,signature:bytes},getClientExtensionResults:()=>({})}}}});
      createRoot(document.getElementById('root')).render(<WebsiteEntry setupToken=""/>);`,
    resolveDir: path.join(repo, "packages/web/app"),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  outdir: output,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});
const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text || "";
const origin = "https://codeshell.site";
const hostId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const publicOrigin = `https://${hostId}.devices.codeshell.site`;
const account = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  username: "fixture-user",
  displayName: "测试账号",
  role: "member",
};
const features = {
  "cloud.projects": { version: 1, enabled: true, params: { cloudOrigin: origin } },
  "devices.directory": { version: 1, enabled: true },
  "relay.phone": { version: 1, enabled: true },
};
const errors = [],
  blocked = [],
  checks = [],
  screenshots = [];
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CODESHELL_TEST_CHROMIUM ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
let context;
try {
  for (const width of [320, 390, 1280]) {
    context = await browser.newContext({
      viewport: { width, height: 900 },
      serviceWorkers: "block",
    });
    const calls = [];
    const state = { online: true, missing: false };
    await context.routeWebSocket("**/*", (socket) => {
      blocked.push(socket.url());
      socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.origin === publicOrigin && url.pathname === "/__relay/claim") {
        assert.equal(request.method(), "GET");
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><h1>Owned full computer workbench</h1>",
        });
      }
      if (url.origin !== origin) {
        blocked.push(url.href);
        return route.abort();
      }
      calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
      if (url.pathname === "/fixture.js")
        return route.fulfill({ contentType: "text/javascript", body: js });
      if (url.pathname === "/fixture.css")
        return route.fulfill({ contentType: "text/css", body: css });
      if (url.pathname === "/app")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script></html>',
        });
      assert.equal(request.headers().authorization, undefined);
      if (url.pathname === "/api/v1/cloud-browser/capabilities")
        return json({
          version: 1,
          mode: "cloud-browser",
          cloudOrigin: origin,
          accountOrigin: origin,
          installationId: environmentId,
        });
      if (url.pathname === "/api/v1/account/status")
        return json({ registrationAllowed: true, githubEnabled: false, features });
      if (url.pathname === "/api/v1/account/web/session")
        return json({
          authenticated: true,
          csrfToken: "C".repeat(43),
          account,
          session: { id: account.id, expiresAt: Date.now() + 900000 },
          cloudTarget: null,
          overview: {
            account,
            security: { hasPassword: true, githubLinked: false },
            capabilities: { sessions: true, passwordChange: true, admin: false, links: false },
            stats: { activeSessions: 1, loginMethods: 1 },
            features,
          },
        });
      if (url.pathname === "/api/v1/account/web/remote-hosts")
        return json({
          hosts: state.missing
            ? []
            : [
                {
                  hostId,
                  environmentId,
                  publicOrigin,
                  name: "已有聊天的电脑 · 远程工作台",
                  online: state.online,
                  revoked: false,
                },
              ],
        });
      if (url.pathname === "/api/v1/account/web/passkeys/authentication/options") {
        assert.deepEqual(request.postDataJSON(), { purpose: "remote-access", target: hostId });
        return json({
          ceremonyId: "K".repeat(43),
          optionsJSON: {
            rpId: "codeshell.site",
            challenge: "Q".repeat(43),
            userVerification: "required",
          },
        });
      }
      if (url.pathname === "/api/v1/account/web/passkeys/authentication/verify")
        return json({ stepUpToken: "S".repeat(43), expiresAt: Date.now() + 60000 });
      if (url.pathname === `/api/v1/account/web/remote-hosts/${hostId}/client-access`) {
        assert.deepEqual(request.postDataJSON(), {
          client: "browser",
          stepUpToken: "S".repeat(43),
        });
        assert.equal(request.headers()["x-codeshell-csrf"], "C".repeat(43));
        return json({
          hostId,
          publicOrigin,
          claimUrl: `${publicOrigin}/__relay/claim#${"T".repeat(43)}`,
          expiresAt: Date.now() + 60000,
        });
      }
      blocked.push(url.href);
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const entry = `${origin}/app?target=choose&computer=${hostId}`;
    await page.goto(entry);
    const connect = page.getByRole("button", { name: "使用指纹连接", exact: true });
    await connect.waitFor();
    assert.equal(await connect.isEnabled(), true);
    assert.equal(await page.locator("select,textarea").count(), 0);
    assert.equal(await page.getByRole("button", { name: "进入云端" }).count(), 0);
    assert.equal(await page.evaluate(() => window.fixturePasskeys), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await connect.focus();
    assert.equal(await connect.evaluate((node) => node === document.activeElement), true);
    const screenshot = path.join(output, `selected-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    screenshots.push(screenshot);
    checks.push(`selected-host-layout-${width}`);
    await page.evaluate(() => {
      window.fixtureCancel = true;
    });
    await connect.click();
    await page.getByRole("alert").filter({ hasText: "已取消或超时" }).waitFor();
    assert.equal(
      calls.some((call) => call.path.endsWith("/client-access")),
      false,
    );
    await page.evaluate(() => {
      window.fixtureCancel = false;
    });
    await connect.click();
    await page.getByRole("heading", { name: "Owned full computer workbench" }).waitFor();
    assert.equal(page.url(), `${publicOrigin}/__relay/claim#${"T".repeat(43)}`);
    assert.equal(
      calls.some((call) => /projects|chat|sessions/.test(call.path)),
      false,
    );
    checks.push(`passkey-retry-to-full-workbench-${width}`);
    state.online = false;
    await page.goto(entry);
    await page.getByRole("alert").filter({ hasText: "暂时无法连接" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "使用指纹连接" }).isDisabled(), true);
    checks.push(`offline-no-fallback-${width}`);
    state.missing = true;
    await page.goto(entry);
    await page.getByRole("alert").filter({ hasText: "找不到这台电脑" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "使用指纹连接" }).count(), 0);
    checks.push(`missing-no-fallback-${width}`);
    await context.close();
    context = undefined;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  const result = { ok: true, checks, screenshots, blocked, errors, output };
  await writeFile(path.join(output, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await context?.close();
  await browser.close();
}
