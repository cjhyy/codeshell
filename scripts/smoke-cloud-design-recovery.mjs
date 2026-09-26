/* Production Design UI against two installed candidate packages and real Docker volumes. */
/* global document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "playwright",
);
const SOURCE = "designs/design.codesign.json";
const COPY = "designs/recovered.codesign.json";
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const hash = async (value) => createHash("sha256").update(value).digest("hex");

export async function verifyCloudDesignRecovery({
  docker,
  request,
  serverUrl,
  password,
  containerA,
  containerB,
  projectA,
  projectB,
  candidatePanels,
  scratch,
  evidenceDir,
}) {
  // Fixture encoding uses the exact installed Panel's public document modules.
  const module = (name) =>
    import(pathToFileURL(join(candidatePanels, "design-studio/app", name)).href);
  const { normalizeDesignDocument, serializeDesignDocument } = await module("document.mjs");
  const { createDesignIndexPersistencePlan } = await module("document-index.mjs");
  const { createDesignResourcePersistencePlan } = await module("resource-store.mjs");
  const image = await createDesignResourcePersistencePlan({
    id: "cloud-pixel",
    kind: "image",
    mime: "image/png",
    base64: PIXEL,
    sha256Bytes: hash,
  });
  const original = normalizeDesignDocument({
    format: "codeshell.design",
    version: 3,
    name: "Cloud design source",
    canvas: { width: 800, height: 600, background: "#ffffff" },
    tokens: { colors: [] },
    resources: [image.descriptor],
    activePageId: "page-1",
    pages: [
      { id: "page-1", name: "First source page", children: [] },
      { id: "page-2", name: "Unopened source page", children: [] },
    ],
  });
  const indexed = await createDesignIndexPersistencePlan({ document: original, sha256: hash });
  const other = serializeDesignDocument(
    normalizeDesignDocument({
      ...JSON.parse(serializeDesignDocument(original)),
      name: "Other cloud project",
      resources: [],
      pages: [{ id: "page-other", name: "Other project page", children: [] }],
      activePageId: "page-other",
    }),
  );
  for (const [container, parts] of [
    [
      containerA,
      [...indexed.parts, ...image.parts, { path: SOURCE, content: indexed.primarySource }],
    ],
    [containerB, [{ path: SOURCE, content: other }]],
  ]) {
    await docker(["exec", "-i", container, "node", "--input-type=module"], {
      input: `import {mkdirSync,writeFileSync} from 'node:fs'; import {dirname,join} from 'node:path'; for(const part of ${JSON.stringify(parts)}) {const path=join('/workspace',part.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,part.content,{flag:'wx'});}`,
    });
  }
  const read = async (project, path) => {
    const response = await request(
      `/p/${project}/api/v1/files/content?path=${encodeURIComponent(path)}`,
    );
    assert.equal(response.status, 200);
    return response.text();
  };
  const absent = async (project, path) =>
    assert.equal(
      (await request(`/p/${project}/api/v1/files/content?path=${encodeURIComponent(path)}`)).status,
      404,
    );
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
          .filter({ has: page.locator("small", { hasText: /^design-studio$/ }) })
          .getByRole("button", { name: "打开面板", exact: true })
          .click();
        const iframe = page.locator("iframe.panel-host-frame");
        await iframe.waitFor();
        const frame = await (await iframe.elementHandle()).contentFrame();
        await frame.waitForFunction(
          () =>
            !document.querySelector(".topbar")?.inert &&
            document.querySelector("#repo-link-state")?.dataset.kind === "linked",
          null,
          { timeout: 150_000 },
        );
        return { page, frame };
      };
      await action(open);
      assert.deepEqual(errors, [], "Installed Design must not raise page errors");
    } catch (error) {
      for (const [index, page] of pages.entries()) {
        await page
          .screenshot({ path: join(scratch, `design-error-${index}.png`), fullPage: true })
          .catch(() => {});
        for (const [frameIndex, frame] of page.frames().entries())
          await writeFile(
            join(scratch, `design-error-${index}-${frameIndex}.txt`),
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
  const waitStatus = (frame, text) =>
    frame
      .locator("#portable-backup-status")
      .filter({ hasText: text })
      .waitFor({ timeout: 150_000 });
  const download = async ({ page, frame }) => {
    await frame.locator("#portable-backup-open").click();
    const pending = page.waitForEvent("download", { timeout: 150_000 });
    await frame.locator("#portable-backup-export").click();
    const data = await readFile(await (await pending).path());
    await waitStatus(frame, "完整备份已生成");
    await frame.locator("#portable-backup-close").click();
    return data;
  };
  const choose = async (frame, buffer) => {
    await frame.locator("#portable-backup-open").click();
    await frame
      .locator("#portable-backup-file")
      .setInputFiles({ name: "design-complete-backup.json", mimeType: "application/json", buffer });
    await waitStatus(frame, "校验通过");
    assert.equal(await frame.locator("#portable-backup-restore").isEnabled(), true);
  };
  const openCopy = async (frame) => {
    await frame.locator("#open-files").click();
    await frame.locator("#files-dialog .file-row").filter({ hasText: COPY }).click();
    await frame.waitForFunction(
      (path) => document.querySelector("#document-path").value === path,
      COPY,
      { timeout: 150_000 },
    );
    await frame.waitForFunction(
      () => document.querySelectorAll("#active-page option").length === 3,
      null,
      { timeout: 150_000 },
    );
  };
  let sourceAfterSave, restoredBytes;
  await browserRun(async (open) => {
    const a = await open(projectA),
      b = await open(projectB);
    assert.equal(await a.frame.locator("#active-page option").count(), 2);
    assert.equal(await b.frame.locator("#active-page option").count(), 1);
    const initial = JSON.parse(await download(a));
    assert.deepEqual(
      initial.document.pages.map((page) => page.name),
      ["First source page", "Unopened source page"],
    );
    assert.equal(initial.resources[0].base64, PIXEL);
    assert.equal(
      await read(projectA, SOURCE),
      indexed.primarySource,
      "Export does not rewrite the indexed source",
    );
    await a.frame.locator("#add-page").click();
    await a.frame.locator("#save").click();
    await a.frame
      .locator("#save-state")
      .filter({ hasText: "已保存" })
      .waitFor({ timeout: 150_000 });
    sourceAfterSave = await read(projectA, SOURCE);
    assert.equal(JSON.parse(sourceAfterSave).pages.length, 3);
    const buffer = await download(a),
      archive = JSON.parse(buffer);
    assert.equal(archive.document.pages.length, 3);
    assert.equal(archive.resources.length, 1);
    assert.equal(
      await hash(Buffer.from(archive.resources[0].base64, "base64")),
      image.descriptor.sha256,
    );
    await choose(b.frame, buffer);
    await absent(projectB, COPY);
    await b.frame.locator("#portable-backup-path").fill(SOURCE);
    await b.frame.locator("#portable-backup-restore").click();
    await waitStatus(b.frame, "冲突");
    assert.equal(
      await read(projectB, SOURCE),
      other,
      "Restore must preserve an existing target document",
    );
    await b.frame.locator("#portable-backup-path").fill(COPY);
    await b.frame.locator("#portable-backup-restore").click();
    await waitStatus(b.frame, "已恢复到");
    assert.equal(
      await b.frame.locator("#active-page option").count(),
      1,
      "Restore leaves the current canvas untouched",
    );
    restoredBytes = await read(projectB, COPY);
    assert.equal(JSON.parse(restoredBytes).pages.length, 3);
    for (const part of image.parts) assert.equal(await read(projectB, part.path), part.content);
    await b.page.screenshot({
      path: join(evidenceDir, "cloud-design-restore.png"),
      fullPage: true,
    });
    await b.frame.locator("#portable-backup-close").click();
    await openCopy(b.frame);
    const exported = JSON.parse(await download(b));
    assert.deepEqual(exported.document, archive.document);
    assert.deepEqual(exported.resources, archive.resources);
    assert.equal(await read(projectA, SOURCE), sourceAfterSave);
    console.log(
      "PASS: real cloud Design exports unopened indexed pages and exact image bytes, saves an edit, imports into the other project, preserves an occupied destination and its current canvas, then opens and re-exports the independent restored file",
    );
  });
  return async () =>
    browserRun(async (open) => {
      const a = await open(projectA),
        b = await open(projectB);
      assert.equal(await a.frame.locator("#active-page option").count(), 3);
      assert.equal(await read(projectA, SOURCE), sourceAfterSave);
      assert.equal(await read(projectB, SOURCE), other);
      assert.equal(await read(projectB, COPY), restoredBytes);
      assert.equal(await b.frame.locator("#document-path").inputValue(), COPY);
      const exported = JSON.parse(await download(b));
      assert.equal(exported.document.pages.length, 3);
      assert.equal(exported.resources[0].base64, PIXEL);
      console.log(
        "PASS: installed Design reopens after project stop/start and package source removal with saved pages, restored copy and independent image data intact",
      );
    });
}
