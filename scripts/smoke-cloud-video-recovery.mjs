/* Actual installed Video Studio in production Web and isolated Docker projects. */
/* global document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "playwright",
);
export async function verifyCloudVideoRecovery({
  serverUrl,
  password,
  projectA,
  projectB,
  scratch,
  evidenceDir,
  json,
  request,
  panelHarness,
}) {
  const seed = (id, name) => ({
    schemaVersion: 1,
    id,
    name,
    revision: 7,
    width: 640,
    height: 360,
    fps: 30,
    timelineMode: "free",
    script: "原始云端文稿🙂",
    assets: [],
    clips: [],
    captions: [],
  });
  const original = seed("cloud-video-original", "Cloud video original"),
    other = seed("cloud-video-other", "Other cloud video");
  for (const [project, value] of [
    [projectA, original],
    [projectB, other],
  ]) {
    const root = `/p/${project}/api/v1/panels`;
    const panel = (await json(root)).panels.find((p) => p.id === "video-studio");
    const grant = await json(root + "/runtime/prepare", {
      method: "POST",
      body: { appId: "video-studio", revision: panel.revision },
    });
    await panelHarness(project, grant).call("storage.set", {
      key: "video-studio-project-v1",
      value,
    });
  }
  const readFileText = async (project, path) => {
    const response = await request(
      `/p/${project}/api/v1/files/content?path=${encodeURIComponent(path)}`,
    );
    assert.equal(response.status, 200, `Missing actual video project file ${path}`);
    return response.text();
  };
  const readDocument = async (project, key = "video-studio-current") => {
    const index = JSON.parse(
      await readFileText(project, `video-studio-data/documents/indexes/${key}/index.json`),
    );
    const entry = index.entries[0];
    const parts = [];
    for (const hash of entry.parts) {
      const bytes = Buffer.from(
        await readFileText(project, `video-studio-data/documents/parts/${hash}.txt`),
        "base64",
      );
      assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    const packed = JSON.parse(bytes);
    assert.equal(
      createHash("sha256").update(JSON.stringify(packed.data)).digest("hex"),
      packed.sha256,
    );
    return { document: packed.data, storageRevision: entry.revision };
  };
  const until = async (check) => {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 350));
    }
    throw new Error("Video save did not complete");
  };
  await mkdir(evidenceDir, { recursive: true });
  async function browserRun(action) {
    const browser = await chromium.launch();
    const pages = [],
      errors = [];
    try {
      const open = async (project) => {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          acceptDownloads: true,
        });
        const page = await context.newPage();
        pages.push(page);
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${serverUrl}/?project=${project}`);
        await page.getByLabel("用户名", { exact: true }).fill("smoke-admin");
        await page.getByLabel("密码", { exact: true }).fill(password);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.getByRole("button", { name: "面板", exact: true }).click();
        await page
          .locator(".panels-card")
          .filter({ has: page.locator("small", { hasText: /^video-studio$/ }) })
          .getByRole("button", { name: "打开面板", exact: true })
          .click();
        const iframe = page.locator("iframe.panel-host-frame");
        await iframe.waitFor();
        const frame = await (await iframe.elementHandle()).contentFrame();
        await frame.waitForFunction(
          () => {
            const status = document.querySelector("#save-state")?.textContent;
            if (status === "恢复失败")
              throw new Error(document.querySelector("#toast")?.textContent || status);
            return !!document.querySelector("#editor-workspace");
          },
          null,
          { timeout: 150_000 },
        );
        return { page, frame };
      };
      await action(open);
      assert.deepEqual(errors, [], "Installed Video must not raise page errors");
    } catch (error) {
      for (const [index, page] of pages.entries()) {
        await page
          .screenshot({ path: join(scratch, `video-error-${index}.png`), fullPage: true })
          .catch(() => {});
        for (const [frameIndex, frame] of page.frames().entries())
          await writeFile(
            join(scratch, `video-error-${index}-${frameIndex}.txt`),
            await frame
              .locator("body")
              .innerText()
              .catch(() => "unavailable"),
          );
      }
      throw error;
    } finally {
      await browser.close();
    }
  }

  let finalDocument;
  const edit = async (frame, name) => {
    await frame.locator("#project-name").fill(name);
    await frame.locator("#project-name").press("Tab");
    await frame.locator("#save-state").filter({ hasText: "已保存" }).waitFor({ timeout: 150000 });
  };
  await browserRun(async (open) => {
    const a = await open(projectA),
      b = await open(projectB);
    assert.equal(await a.frame.locator("#project-name").inputValue(), original.name);
    assert.equal(await b.frame.locator("#project-name").inputValue(), other.name);
    const rectangle = a.frame.locator('#editor-workspace [data-ew-action="rectangle"]');
    if (!(await rectangle.isVisible()))
      await rectangle.locator("xpath=ancestor::details[1]").locator("summary").click();
    await rectangle.click();
    await a.frame
      .locator("[data-ew-save]")
      .filter({ hasText: "已保存" })
      .waitFor({ timeout: 150000 });
    const horizontal = a.frame.getByLabel("水平位置（%）", { exact: true });
    await horizontal.fill("37");
    await horizontal.press("Tab");
    await a.frame
      .locator("[data-ew-save]")
      .filter({ hasText: "已保存" })
      .waitFor({ timeout: 150000 });
    await edit(a.frame, "Cloud edited video");
    const changed = await until(async () => {
      const value = await readDocument(projectA);
      return value.document.name === "Cloud edited video" && value;
    });
    assert.equal(changed.document.schemaVersion, 2);
    const shape = changed.document.sequences
      .flatMap((s) => s.clips)
      .find((c) => c.kind === "shape");
    assert.equal(shape.transform.x, 0.37);
    assert.equal(changed.document.id, original.id);
    assert.equal(await b.frame.locator("#project-name").inputValue(), other.name);
    const reopened = await open(projectA);
    assert.equal(await reopened.frame.locator("#project-name").inputValue(), "Cloud edited video");
    await a.page.close();
    await reopened.frame.locator('[data-action="versions"]').first().click();
    const downloading = reopened.page.waitForEvent("download", { timeout: 150000 });
    await reopened.frame.getByRole("button", { name: "导出原格式", exact: true }).click();
    const download = await downloading;
    assert.deepEqual(JSON.parse(await readFile(await download.path(), "utf8")), original);
    assert.deepEqual((await readDocument(projectA)).document, changed.document);
    await reopened.frame.getByRole("button", { name: "恢复为当前工程", exact: true }).click();
    await reopened.frame
      .locator("#toast")
      .filter({ hasText: "已从升级前备份恢复工程" })
      .waitFor({ timeout: 150000 });
    const restored = await readDocument(projectA);
    assert.equal(restored.document.name, original.name);
    assert.equal(
      restored.document.sequences.flatMap((s) => s.clips).some((c) => c.kind === "shape"),
      false,
    );
    assert.ok(restored.storageRevision > changed.storageRevision);
    await edit(reopened.frame, "Cloud video after restore");
    finalDocument = (
      await until(async () => {
        const value = await readDocument(projectA);
        return value.document.name === "Cloud video after restore" && value;
      })
    ).document;
    await reopened.page.screenshot({
      path: join(evidenceDir, "cloud-video-recovery.png"),
      fullPage: true,
    });
    assert.equal(await b.frame.locator("#project-name").inputValue(), other.name);
    console.log(
      "PASS: actual installed Video Studio migrates old cloud project, saves and reopens across independent logins, exports exact upgrade backup, restores and edits without changing the other project",
    );
  });
  return async () =>
    browserRun(async (open) => {
      const a = await open(projectA),
        b = await open(projectB);
      assert.equal(
        await a.frame.locator("#project-name").inputValue(),
        "Cloud video after restore",
      );
      assert.equal(await b.frame.locator("#project-name").inputValue(), other.name);
      assert.deepEqual((await readDocument(projectA)).document, finalDocument);
      await a.frame.locator('[data-action="versions"]').first().click();
      const pending = a.page.waitForEvent("download", { timeout: 150000 });
      await a.frame.getByRole("button", { name: "导出原格式", exact: true }).click();
      assert.deepEqual(JSON.parse(await readFile(await (await pending).path(), "utf8")), original);
      console.log(
        "PASS: cloud Video Studio current document and original upgrade backup survive project restart and package source removal",
      );
    });
}
