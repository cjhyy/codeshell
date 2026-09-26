/* Actual candidate Job Hunt UI, authenticated Cloud proxy and Docker project volumes. */
/* global window, document */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "playwright",
);
const ROOT = "job-hunt-panel.json";
const originalResume = "# Cloud recovery original\n\nPreserved career evidence.";
const editedResume = "# Cloud recovery edited\n\nNewer work before restore.";
const freshResume = "# Cloud recovery after restore\n\nNew work survives restart.";

async function until(read, description, timeout = 150_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`Timed out: ${description}`);
}

export async function verifyCloudJobHuntRecovery({
  docker,
  request,
  serverUrl,
  password,
  containerA,
  containerB,
  projectA,
  projectB,
  scratch,
  evidenceDir,
}) {
  await mkdir(evidenceDir, { recursive: true });
  const source = (schemaVersion, markdown) => ({
    schemaVersion,
    updatedAt: "2026-01-01T00:00:00Z",
    profile: { name: "Recovery fixture" },
    jobs: [],
    versions: [],
    resume: {
      versionId: "cloud-base",
      kind: "base",
      title: "Cloud base",
      markdown,
      updatedAt: "2026-01-01T00:00:00Z",
    },
    questionBank: Array.from({ length: 150 }, (_, i) => ({
      id: `q-${i}`,
      question: `Recovery question ${i}`,
      notes: "x".repeat(3000),
      status: "inbox",
      origin: "manual",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    })),
    unknownLegacy: "Original Unicode 中🙂 and unknown fields must remain in the backup",
  });
  const original = JSON.stringify(source(1, originalResume), null, 2) + "\n\n";
  const other = JSON.stringify(
    { ...source(2, "# Other cloud project"), questionBank: [] },
    null,
    2,
  );
  for (const [container, content] of [
    [containerA, original],
    [containerB, other],
  ]) {
    await docker(["exec", "-i", container, "node", "--input-type=module"], {
      input: `import {writeFileSync} from 'node:fs'; writeFileSync('/workspace/${ROOT}', ${JSON.stringify(content)}, {flag:'wx'});`,
    });
  }
  const readRoot = async (project) => {
    const response = await request(`/p/${project}/api/v1/files/content?path=${ROOT}`);
    assert.equal(response.status, 200);
    return response.text();
  };
  const backupPaths = async (container) =>
    JSON.parse(
      await docker([
        "exec",
        container,
        "node",
        "-e",
        `const fs=require('node:fs'); const p='/workspace/career-data/panel-backups'; console.log(JSON.stringify(fs.readdirSync(p).filter(n=>fs.existsSync(p+'/'+n+'/manifest.json')).map(n=>'career-data/panel-backups/'+n+'/manifest.json')));`,
      ]),
    );
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
          .filter({ has: page.locator("small", { hasText: /^job-hunt-hq$/ }) })
          .getByRole("button", { name: "打开面板", exact: true })
          .click();
        const iframe = page.locator("iframe.panel-host-frame");
        await iframe.waitFor();
        const frame = await (await iframe.elementHandle()).contentFrame();
        await frame.waitForFunction(
          () => {
            const status = document.querySelector("#draft-storage-status")?.textContent || "";
            if (status.startsWith("读取失败")) throw new Error(status);
            return (
              !document.querySelector(".app-shell")?.inert &&
              /草稿按项目保存|草稿已保存到项目|项目已恢复/.test(status)
            );
          },
          null,
          { timeout: 150_000 },
        );
        const call = (method, params) =>
          frame.evaluate(({ method, params }) => window.codeshellPanel.call(method, params), {
            method,
            params,
          });
        return { page, frame, call };
      };
      await action(open);
      assert.deepEqual(errors, [], "Installed Job Hunt must not raise page errors");
    } catch (error) {
      for (const [index, page] of pages.entries()) {
        await page
          .screenshot({ path: join(scratch, `job-hunt-error-${index}.png`), fullPage: true })
          .catch(() => {});
        for (const [frameIndex, frame] of page.frames().entries()) {
          const text = await frame
            .locator("body")
            .innerText()
            .catch(() => "unavailable");
          await writeFile(join(scratch, `job-hunt-error-${index}-${frameIndex}.txt`), text);
        }
      }
      throw error;
    } finally {
      await browser.close();
    }
  }
  const edit = async (frame, markdown) => {
    await frame.locator('.side-nav [data-view-target="resumes"]').click();
    await frame.locator('[data-resume-mode="edit"]').click();
    await frame.locator("#resume-editor").fill(markdown);
  };
  let restoredMarker, backupPath;
  await browserRun(async (open) => {
    const a = await open(projectA),
      b = await open(projectB);
    assert.deepEqual(
      await a.frame.evaluate(async () => {
        const blocked = (read) => {
          try {
            read();
            return false;
          } catch (error) {
            return error.name === "SecurityError";
          }
        };
        return {
          parent: blocked(() => window.parent.document),
          storage: blocked(() => window.localStorage),
          network: await fetch("/health").then(
            () => false,
            () => true,
          ),
        };
      }),
      { parent: true, storage: true, network: true },
      "File exports must retain opaque-origin and network isolation",
    );
    const migrated = JSON.parse(await readRoot(projectA));
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.artifactStorage.schemaVersion, 2);
    assert.equal(await readRoot(projectB), other, "Opening the other project must not rewrite it");
    [backupPath] = await backupPaths(containerA);
    assert.ok(backupPath);
    console.log(
      "PASS: production Job Hunt opens in its opaque-origin frame and migrates a large v1 root to immutable shards while project B stays unchanged",
    );
    await edit(a.frame, editedResume);
    await until(
      async () => JSON.parse(await readRoot(projectA)).resume.markdown === editedResume,
      "cloud editor persists content",
    );
    await a.frame.locator("#snapshot-recovery-open").click();
    await a.frame.waitForFunction(
      () => !document.querySelector("#snapshot-recovery-source").disabled,
      null,
      { timeout: 150_000 },
    );
    await a.frame.locator("#snapshot-recovery-source").selectOption(backupPath);
    await a.frame.waitForFunction(
      () => !document.querySelector("#snapshot-recovery-apply").disabled,
      null,
      { timeout: 150_000 },
    );
    // A second authorized client leaves a future-dated old-epoch Host draft.
    const cached = await a.call("storage.getSnapshot", { key: "job-hunt-state-v1" });
    const saved = await a.call("storage.compareAndSet", {
      key: "job-hunt-state-v1",
      expectedRevision: cached.revision,
      value: {
        ...cached.value,
        resumeDraft: { markdown: "# Stale future client", updatedAt: "2099-01-01T00:00:00Z" },
      },
    });
    assert.equal(saved.updated, true);
    console.log(
      "PASS: cloud Job Hunt saves an edit, verifies the old backup in its real recovery dialog and accepts the independent client's conditional draft update",
    );
    const download = a.page.waitForEvent("download");
    await a.frame.locator("#snapshot-recovery-download").click();
    const archive = JSON.parse(await readFile(await (await download).path(), "utf8"));
    assert.equal(
      archive.bundle.root,
      original,
      "Archive preserves the original large root byte-for-byte",
    );
    assert.equal(
      createHash("sha256").update(JSON.stringify(archive.bundle)).digest("hex"),
      archive.manifest.sha256,
    );
    assert.equal(
      JSON.parse(await readRoot(projectA)).resume.markdown,
      editedResume,
      "Preview does not overwrite current content",
    );
    await a.page.screenshot({
      path: join(evidenceDir, "cloud-job-hunt-restore.png"),
      fullPage: true,
    });
    await a.frame.locator("#snapshot-recovery-apply").click();
    await a.frame.waitForFunction(
      () =>
        document
          .querySelector("#snapshot-recovery-status")
          .textContent.startsWith("项目快照已恢复。") &&
        !document.querySelector("#snapshot-recovery-close").disabled,
      null,
      { timeout: 150_000 },
    );
    const restored = JSON.parse(await readRoot(projectA));
    assert.equal(restored.resume.markdown, originalResume);
    restoredMarker = restored.snapshotRestoreId;
    assert.match(restoredMarker, /^g-[a-f0-9]{32}$/);
    assert.notEqual(restored.artifactStorage.generation, migrated.artifactStorage.generation);
    assert.equal(await readRoot(projectB), other, "Restore must not touch the other cloud project");
    await a.frame.locator("#snapshot-recovery-close").click();
    await edit(a.frame, freshResume);
    await until(
      async () => JSON.parse(await readRoot(projectA)).resume.markdown === freshResume,
      "new draft after restore persists",
    );
    await until(
      async () =>
        (await a.call("storage.getSnapshot", { key: "job-hunt-state-v1" })).value
          .snapshotRestoreId === restoredMarker,
      "new epoch replaces archived Host cache",
    );
    assert.equal(await b.frame.locator("#resume-editor").inputValue(), "# Other cloud project");
    console.log(
      "PASS: actual installed Job Hunt in two Docker projects migrates a large v1 root, exports exact old bytes, restores through the production UI, rejects a stale future draft and saves fresh work without changing the other project",
    );
  });
  return async () =>
    browserRun(async (open) => {
      const a = await open(projectA);
      const current = JSON.parse(await readRoot(projectA));
      assert.equal(current.resume.markdown, freshResume);
      assert.equal(current.snapshotRestoreId, restoredMarker);
      assert.equal(await a.frame.locator("#resume-editor").inputValue(), freshResume);
      assert.equal(await readRoot(projectB), other);
      await a.frame.locator("#snapshot-recovery-open").click();
      await a.frame.waitForFunction(
        () => !document.querySelector("#snapshot-recovery-source").disabled,
        null,
        { timeout: 150_000 },
      );
      assert.ok(
        await a.frame.locator(`#snapshot-recovery-source option[value="${backupPath}"]`).count(),
      );
      console.log(
        "PASS: after project stop/start and original package source removal, real Job Hunt reopens the restored generation with later edits and its backup catalog intact",
      );
    });
}
