// Real cloud workbench and proxy: retained package selection must be reviewable
// without changing the project until the owner explicitly confirms.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const { chromium } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "playwright",
);

export async function selectCloudPanelVersion({
  serverUrl,
  password,
  project,
  id,
  digest,
  json,
  evidenceDir,
}) {
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chromium", chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const snapshot = () => json(`/p/${project}/api/v1/panels`);
  try {
    const before = await snapshot();
    const beforePanel = before.panels.find((item) => item.id === id);
    assert.ok(beforePanel?.bound);
    assert.notEqual(beforePanel.packageDigest, digest);
    await page.goto(`${serverUrl}/?project=${project}`);
    await page.getByLabel("用户名", { exact: true }).fill("smoke-admin");
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "面板", exact: true }).click();
    const card = page
      .locator('section[aria-labelledby="installed-panels-heading"] .panels-card')
      .filter({ has: page.locator("small", { hasText: new RegExp(`^${id}$`) }) });
    async function review() {
      await card.getByRole("button", { name: "项目版本", exact: true }).click();
      const history = page.getByRole("region", { name: "项目保留版本", exact: true });
      const version = history.locator("article").filter({
        has: page.getByText(`内容编号 ${digest.slice(0, 12)}`, { exact: true }),
      });
      await version.getByRole("button", { name: /^审阅 v/ }).click();
      const confirmation = page.getByRole("region", { name: "确认恢复项目版本", exact: true });
      await confirmation
        .getByRole("button", { name: "确认权限并恢复项目版本", exact: true })
        .waitFor();
      assert.equal(
        await confirmation.locator(".panels-permission").count(),
        beforePanel.permissions.length,
      );
      assert.deepEqual(await snapshot(), before, "Opening a version review changed the project");
      return confirmation;
    }
    await review();
    await page.getByRole("button", { name: "关闭版本记录", exact: true }).click();
    assert.deepEqual(await snapshot(), before, "Canceling a version review changed the project");
    const confirmation = await review();
    await page.screenshot({
      path: join(evidenceDir, `cloud-panel-version-${id}-${digest.slice(0, 12)}.png`),
      fullPage: true,
    });
    await confirmation.getByRole("button", { name: "确认权限并恢复项目版本", exact: true }).click();
    await page.locator(".panels-notice").filter({ hasText: "的项目版本已恢复为" }).waitFor();
    const after = await snapshot();
    assert.equal(after.panels.find((item) => item.id === id)?.packageDigest, digest);
    assert.deepEqual(errors, [], "Cloud package management raised browser errors");
  } catch (error) {
    await page
      .screenshot({
        path: join(evidenceDir, `cloud-panel-version-error-${id}.png`),
        fullPage: true,
      })
      .catch(() => {});
    await writeFile(
      join(evidenceDir, `cloud-panel-version-error-${id}.txt`),
      await page
        .locator("body")
        .innerText()
        .catch(() => "Page unavailable"),
    ).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
