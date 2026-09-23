/* Real native credentials UI, independent Link, and isolated authorization windows. */
import assert from "node:assert/strict";
import { join } from "node:path";

export async function verifyNativeLinkUI({
  desktop,
  win,
  issuer,
  client,
  readLinkState,
  screenshots,
}) {
  const errors = [];
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
    await win
      .locator("[data-remote-links]")
      .getByRole("button", { name: "通过 Link 添加账号", exact: true })
      .waitFor();
  };
  await openLinks();
  const section = win.locator("[data-remote-links]");
  async function start(button) {
    const opened = desktop.waitForEvent("window");
    await button.click();
    const auth = await opened;
    auth.setDefaultTimeout(15000);
    auth.on("pageerror", (error) => errors.push(error.message));
    await auth.locator('input[name="password"]').waitFor();
    assert.equal(new URL(auth.url()).origin, issuer);
    assert.equal(await auth.evaluate(() => typeof window.codeshell), "undefined");
    return auth;
  }
  async function consent(auth, deny = false, account = "alice") {
    await auth.locator('input[name="password"]').fill("long-private-fixture-password");
    await auth.getByRole("button", { name: "登录", exact: true }).click();
    await auth.locator('select[name="connectionId"]').selectOption({ label: account });
    await auth.locator('textarea[name="repositories"]').fill("owner/repo");
    const closed = auth.waitForEvent("close");
    await auth.getByRole("button", { name: deny ? "拒绝" : "允许只读访问", exact: true }).click();
    await closed;
    await section
      .getByText(deny ? "授权已取消，没有新增连接。" : "连接已保存。", { exact: true })
      .waitFor();
  }
  const add = section.getByRole("button", { name: "通过 Link 添加账号", exact: true });
  for (const [label, account] of [
    ["Desktop account A", "alice"],
    ["Desktop account B", "bob"],
  ]) {
    await section.getByLabel("远程连接名称", { exact: true }).fill(label);
    await consent(await start(add), false, account);
    await section.locator("[data-remote-link]").filter({ hasText: label }).waitFor();
  }
  assert.equal(await section.locator("[data-remote-link]").count(), 2);
  const first = section.locator("[data-remote-link]").filter({ hasText: "Desktop account A" });
  const id = await first.getAttribute("data-remote-link");
  const connection = section.locator(`[data-remote-link="${id}"]`);
  await connection.getByRole("button", { name: "改名", exact: true }).click();
  await connection.getByLabel("新的连接名称", { exact: true }).fill("Renamed native account");
  await connection.getByRole("button", { name: "保存名称", exact: true }).click();
  await connection.getByText("Renamed native account", { exact: true }).waitFor();
  const stateBefore = await readLinkState();
  await consent(await start(connection.getByRole("button", { name: "重新授权", exact: true })));
  assert.equal(await section.locator("[data-remote-link]").count(), 2);
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
  await section.getByText("授权已取消，没有新增连接。", { exact: true }).waitFor();
  assert.equal(await section.locator("[data-remote-link]").count(), 2);
  const orphan = await start(add);
  const orphanClosed = orphan.waitForEvent("close");
  await win.reload();
  await orphanClosed;
  await openLinks();
  assert.equal(await section.locator("[data-remote-link]").count(), 2);
  // A new owner cannot inherit the old pending flow, but can manage existing connections.
  for (const current of (
    await win.evaluate(() => window.codeshell.links.remoteSnapshot(""))
  ).connections.filter((c) => c.authSource === "remote-link")) {
    const card = section.locator(`[data-remote-link="${current.id}"]`);
    await card.getByRole("button", { name: "断开", exact: true }).click();
    await card.getByRole("button", { name: "确认断开", exact: true }).click();
    await card.waitFor({ state: "detached" });
  }
  await section.getByText("连接已断开，远端授权已撤销。", { exact: true }).waitFor();
  assert.ok((await readLinkState()).grants.every((grant) => grant.revoked));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      mode: "native",
      realDesktop: true,
      realStandaloneLink: true,
      upstream: "controlled fixture",
      multipleAccounts: true,
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
