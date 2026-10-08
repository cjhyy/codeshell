/* Real native credentials UI, independent Link, and isolated authorization windows. */
import assert from "node:assert/strict";
import { join } from "node:path";

export async function verifyNativeLinkUI({
  desktop,
  win,
  issuer,
  client,
  readLinkState,
  seedSecondAccount,
  screenshots,
}) {
  const errors = [];
  let loginCount = 0;
  win.on("pageerror", (error) => errors.push(error.message));
  win.setDefaultTimeout(15000);
  await desktop.evaluate((_electron, config) => Object.assign(process.env, config), {
    CODE_SHELL_REMOTE_LINK_ISSUER: issuer,
    CODE_SHELL_REMOTE_LINK_CLIENT_ID: client.id,
    CODE_SHELL_REMOTE_LINK_DESKTOP_ORIGIN: new URL(client.redirectUris[0]).origin,
  });
  await win.setViewportSize({ width: 1440, height: 1000 });
  const openLinks = async () => {
    await win.getByRole("button", { name: /^(凭证|Credentials)$/ }).click();
    await win.getByRole("tab", { name: /^Link(?:\s|$)/ }).click();
    await win.locator("[data-remote-links]").waitFor();
  };
  await openLinks();
  const section = win.locator("[data-remote-links]");
  const management = win.getByRole("dialog");
  await section.getByRole("button", { name: "连接", exact: true }).waitFor();
  assert.equal(await section.locator("input").count(), 0);
  assert.equal(await section.getByText(issuer, { exact: true }).count(), 0);
  assert.equal(await win.getByRole("heading", { name: "独立 Link 服务", exact: true }).count(), 0);
  assert.equal(
    await win
      .locator('[data-link-runtime-section="server"] [data-link-integration="github"]')
      .count(),
    1,
  );
  await win.screenshot({ path: join(screenshots, "native-connect-1440.png"), fullPage: true });
  async function start(button) {
    const opened = desktop.waitForEvent("window");
    await button.click();
    const auth = await opened;
    auth.setDefaultTimeout(15000);
    auth.on("pageerror", (error) => errors.push(error.message));
    await auth
      .locator('input[name="password"], button[name="decision"][value="allow"]')
      .first()
      .waitFor();
    assert.equal(new URL(auth.url()).origin, issuer);
    assert.equal(await auth.evaluate(() => typeof window.codeshell), "undefined");
    return auth;
  }
  async function consent(auth, deny = false, account = "alice") {
    if (await auth.locator('input[name="password"]').count()) {
      loginCount++;
      await auth.locator('input[name="password"]').fill("long-private-fixture-password");
      await auth.getByRole("button", { name: "登录并继续", exact: true }).click();
    }
    await auth.getByRole("heading", { name: "连接 GitHub", exact: true }).waitFor();
    if (await auth.getByRole("button", { name: "继续前往 GitHub", exact: true }).count()) {
      // The isolated Electron partition is outside Playwright's default context.
      // Mock the authorization Session before it can contact the real provider.
      await desktop.evaluate(({ BrowserWindow }, issuer) => {
        const window = BrowserWindow.getAllWindows().find((item) =>
          item.webContents.getURL().startsWith(issuer + "/"),
        );
        if (!window) throw new Error("Missing isolated authorization window");
        process.__codeshellFixtureGithubNavigations = 0;
        window.webContents.session.webRequest.onBeforeRequest(
          { urls: ["https://github.com/*"] },
          (details, done) => {
            const target = new URL(details.url);
            if (
              details.resourceType !== "mainFrame" ||
              target.pathname !== "/login/oauth/authorize"
            )
              return done({ cancel: true });
            process.__codeshellFixtureGithubNavigations++;
            const callback = new URL("/oauth/upstream/github/callback", issuer);
            callback.search = new URLSearchParams({
              code: "fixture",
              state: target.searchParams.get("state"),
            }).toString();
            done({ redirectURL: callback.href });
          },
        );
      }, issuer);
      await auth.getByRole("button", { name: "继续前往 GitHub", exact: true }).click();
      await auth
        .getByRole("button", { name: "允许只读访问", exact: true })
        .waitFor()
        .catch(async (error) => {
          await auth.screenshot({
            path: join(screenshots, "native-upstream-failure.png"),
            fullPage: true,
          });
          console.log(
            "Native upstream diagnostics",
            JSON.stringify({ page: new URL(auth.url()).pathname, screenshots }),
          );
          throw error;
        });
    }
    if (await auth.locator('select[name="connectionId"]').count()) {
      await auth.getByText("切换 GitHub 账号", { exact: true }).click();
      await auth.locator('select[name="connectionId"]').selectOption({ label: account });
      await auth.getByRole("button", { name: "切换", exact: true }).click();
    }
    await auth.locator('input[type="checkbox"][value="owner/repo"]').check();
    const cancelBox = await auth.getByRole("button", { name: "取消", exact: true }).boundingBox();
    const viewportHeight = await auth.evaluate(() => window.innerHeight);
    assert.ok(
      cancelBox && cancelBox.y + cancelBox.height <= viewportHeight,
      "normal consent actions should fit without scrolling",
    );
    await auth.screenshot({ path: join(screenshots, "native-consent.png"), fullPage: true });
    const closed = auth.waitForEvent("close");
    await auth.getByRole("button", { name: deny ? "取消" : "允许只读访问", exact: true }).click();
    await closed;
    await win
      .getByText(deny ? "授权已取消，没有新增连接。" : "连接已保存。", { exact: true })
      .waitFor();
  }
  await consent(await start(section.getByRole("button", { name: "连接", exact: true })));
  assert.equal(
    await desktop.evaluate(() => process.__codeshellFixtureGithubNavigations),
    1,
    "first connection should complete upstream GitHub authorization",
  );
  await seedSecondAccount();
  await section.getByRole("button", { name: "管理", exact: true }).click();
  const add = management.getByRole("button", { name: "添加账号", exact: true });
  await consent(await start(add), false, "bob");
  assert.equal(loginCount, 1, "the second connection should reuse this app's Link sign-in");
  assert.equal(await management.locator("[data-remote-link]").count(), 2);
  const first = management.locator("[data-remote-link]").filter({ hasText: "alice" });
  const id = await first.getAttribute("data-remote-link");
  const connection = management.locator(`[data-remote-link="${id}"]`);
  await connection.getByRole("button", { name: "改名", exact: true }).click();
  await connection.getByLabel("新的连接名称", { exact: true }).fill("Renamed native account");
  await connection.getByRole("button", { name: "保存名称", exact: true }).click();
  await connection.getByText("Renamed native account", { exact: true }).waitFor();
  const stateBefore = await readLinkState();
  await consent(await start(connection.getByRole("button", { name: "重新授权", exact: true })));
  assert.equal(await management.locator("[data-remote-link]").count(), 2);
  const stateAfter = await readLinkState();
  assert.equal(stateAfter.grants.length, stateBefore.grants.length + 1);
  assert.ok(stateAfter.grants.some((grant) => grant.revoked));
  const masked = await win.evaluate(() => window.codeshell.links.remoteSnapshot(""));
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
  await win.screenshot({ path: join(screenshots, "native-connections-1440.png"), fullPage: true });
  await consent(await start(add), true);
  const cancelled = await start(add);
  await cancelled.close();
  await management.getByText("授权已取消，没有新增连接。", { exact: true }).waitFor();
  assert.equal(await management.locator("[data-remote-link]").count(), 2);
  const orphan = await start(add);
  const orphanClosed = orphan.waitForEvent("close");
  await win.reload();
  await orphanClosed;
  await openLinks();
  await section.getByRole("button", { name: "管理", exact: true }).click();
  assert.equal(await management.locator("[data-remote-link]").count(), 2);
  // A new owner cannot inherit the old pending flow, but can manage existing connections.
  for (const current of (
    await win.evaluate(() => window.codeshell.links.remoteSnapshot(""))
  ).connections.filter((c) => c.authSource === "remote-link")) {
    const card = management.locator(`[data-remote-link="${current.id}"]`);
    await card.getByRole("button", { name: "断开", exact: true }).click();
    await card.getByRole("button", { name: "确认断开", exact: true }).click();
    await card.waitFor({ state: "detached" });
  }
  await management.getByText("连接已断开，远端授权已撤销。", { exact: true }).waitFor();
  assert.ok((await readLinkState()).grants.every((grant) => grant.revoked));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      mode: "native",
      realDesktop: true,
      realStandaloneLink: true,
      upstream: "controlled fixture",
      multipleAccounts: true,
      firstAccountAuthorization: true,
      sessionReuse: true,
      rename: true,
      reauthorize: true,
      denial: true,
      windowCancel: true,
      ownerReload: true,
      genericMutationRejected: true,
      remoteDisconnect: true,
      screenshots,
    }),
  );
}
