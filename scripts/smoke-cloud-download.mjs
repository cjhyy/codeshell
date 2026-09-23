/* Actual installed Download in a Docker project, through the production Web workbench. */
/* global window, document */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../packages/desktop/package.json", import.meta.url))(
  "playwright",
);

async function until(read, message, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(message);
}

export async function verifyCloudDownload({
  docker,
  json,
  request,
  serverUrl,
  projectId,
  otherProjectId,
  container,
  packagePath,
  scratch,
  password,
  evidenceDir,
}) {
  await mkdir(evidenceDir, { recursive: true });
  const files = [];
  async function collect(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await collect(join(directory, entry.name), relative + "/");
      else {
        assert.ok(entry.isFile(), "Fixture package must not contain symlinks");
        files.push([relative, await readFile(join(directory, entry.name), "base64")]);
      }
    }
  }
  await collect(resolve(packagePath));
  await docker(["exec", "-i", container, "node", "--input-type=module"], {
    input: `
    import { mkdirSync, writeFileSync, openSync } from "node:fs";
    import { spawn, execFileSync } from "node:child_process";
    import { previewLocalPanelApp, installReviewedLocalPanelApp } from "/opt/codeshell/packages/core/dist/index.js";
    const source = { kind: "dir", path: "/tmp/cloud-download-panel" };
    const { dirname, join } = await import("node:path");
    for (const [relative, bytes] of ${JSON.stringify(files)}) {
      const file = join(source.path, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(bytes, "base64"));
    }
    const review = await previewLocalPanelApp(source);
    await installReviewedLocalPanelApp(source, review.reviewToken, new Date().toISOString());
    mkdirSync("/workspace/fixture", { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=green:s=128x72:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "/workspace/fixture/source.mp4"]);
    const sourceCode = 'import {createServer} from "node:http"; import {readFileSync,writeFileSync} from "node:fs"; const bytes=readFileSync("/workspace/fixture/source.mp4"); createServer((req,res)=>{if(!["/first.mp4","/second.mp4"].includes(req.url)){res.writeHead(404).end();return;} res.writeHead(200,{"content-type":"video/mp4","content-length":bytes.length}); res.flushHeaders(); const timer=setTimeout(()=>res.end(bytes),5000); res.on("close",()=>clearTimeout(timer));}).listen(18792,"127.0.0.1",()=>writeFileSync("/workspace/fixture/ready","ready"));';
    writeFileSync("/workspace/fixture/server.mjs", sourceCode);
    const output = openSync("/workspace/fixture/server.log", "a");
    spawn(process.execPath, ["/workspace/fixture/server.mjs"], { detached: true, stdio: ["ignore", output, output] }).unref();
    console.log("installed");
  `,
  });
  await until(
    async () =>
      (await docker([
        "exec",
        container,
        "node",
        "-e",
        'process.stdout.write(String(require("node:fs").existsSync("/workspace/fixture/ready")))',
      ])) === "true",
    "Cloud media fixture did not start",
  );
  const panel = (await json(`/p/${projectId}/api/v1/panels`)).panels.find(
    (item) => item.id === "video-download",
  );
  assert.ok(panel);
  await json(`/p/${projectId}/api/v1/panels/video-download/binding`, {
    method: "PATCH",
    body: { bound: true, expectedRevision: panel.revision },
  });
  const original = Buffer.from(
    await (
      await request(`/p/${projectId}/api/v1/files/content?path=fixture/source.mp4`)
    ).arrayBuffer(),
  );
  assert.ok(original.length > 500);

  async function browserRun(action) {
    const browser = await chromium.launch();
    const contexts = [];
    const pages = [];
    const errors = [];
    let approving = false;
    const timer = setInterval(() => {
      if (approving) return;
      approving = true;
      void (async () => {
        for (const page of pages) {
          if (page.isClosed()) continue;
          const confirm = page
            .locator(".panel-host-confirm")
            .getByRole("button", { name: "确认执行", exact: true });
          if ((await confirm.isVisible()) && (await confirm.isEnabled()))
            await confirm.click({ timeout: 2000 });
        }
      })()
        .catch(() => {})
        .finally(() => {
          approving = false;
        });
    }, 200);
    async function open(width) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        hasTouch: width < 600,
      });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${serverUrl}/?project=${projectId}`);
      await page.getByLabel("用户名", { exact: true }).fill("smoke-admin");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      const expand = page.getByRole("button", { name: "展开侧栏", exact: true });
      await until(
        async () =>
          (await expand.isVisible()) ||
          (await page.getByRole("button", { name: "面板", exact: true }).isVisible()),
        "Cloud workbench did not open",
      );
      if (await expand.isVisible()) await expand.click();
      await page.getByRole("button", { name: "面板", exact: true }).click();
      await page
        .locator(".panels-card")
        .filter({ has: page.locator("small", { hasText: /^video-download$/ }) })
        .getByRole("button", { name: "打开面板", exact: true })
        .click();
      await page.locator("iframe.panel-host-frame").waitFor();
      const handle = await page.locator("iframe.panel-host-frame").elementHandle();
      const frame = await handle.contentFrame();
      await until(
        async () => /20\d{2}/.test(await frame.locator("#installed-ytdlp-version").textContent()),
        "Container yt-dlp was not detected",
      );
      const call = (method, params = {}) =>
        frame.evaluate(({ method, params }) => window.codeshellPanel.call(method, params), {
          method,
          params,
        });
      return { page, context, frame, call };
    }
    try {
      const result = await action(open);
      assert.deepEqual(errors, [], "Cloud workbench must not raise page errors");
      return result;
    } catch (error) {
      for (const [index, page] of pages.entries())
        if (!page.isClosed()) {
          await page
            .screenshot({
              path: join(scratch, `cloud-download-error-${index}.png`),
              fullPage: true,
            })
            .catch(() => {});
          for (const [frameIndex, frame] of page.frames().entries()) {
            const content = await frame
              .locator("body")
              .innerText()
              .catch(() => "unavailable");
            await writeFile(
              join(scratch, `cloud-download-error-${index}-${frameIndex}.txt`),
              content,
            );
            console.error(`Cloud Download frame ${index}/${frameIndex}:`, content.slice(-4500));
          }
        }
      throw error;
    } finally {
      clearInterval(timer);
      await browser.close();
    }
  }
  const completed = await browserRun(async (open) => {
    const desktop = await open(1440);
    const mobile = await open(390);
    const capabilities = await desktop.frame.evaluate(() => window.codeshellPanel.getContext());
    assert.equal(capabilities.capabilities.tasks.ownership, "project");
    assert.equal(capabilities.capabilities.tasks.continuesAfterLogout, true);
    await desktop.frame.locator("#url-input").fill("http://127.0.0.1:18792/first.mp4");
    await desktop.frame.locator("#download-button").click();
    const started = await until(async () => {
      const jobs = await desktop.call("tasks.list");
      const job = jobs.find((item) => item.entry.name === "download-runtime");
      if (job?.status === "failed") throw new Error(JSON.stringify(job.error));
      return job?.status === "running" ? job : false;
    }, "Cloud browser did not start a real download");
    const logout = await desktop.context.request.post(`${serverUrl}/api/v1/auth/logout`, {
      headers: { Origin: serverUrl },
      data: {},
    });
    assert.equal(logout.status(), 200);
    await desktop.page.close();
    const job = await until(async () => {
      const current = await mobile.call("tasks.get", { id: started.id });
      if (["failed", "cancelled", "interrupted"].includes(current.status))
        throw new Error(JSON.stringify(current));
      return current.status === "succeeded" ? current : false;
    }, "Cloud task failed to survive the initiating device's logout");
    await mobile.frame.waitForFunction(
      () => document.querySelectorAll('.queue-item[data-state="completed"]').length === 1,
    );
    assert.equal(job.result.artifacts.length, 1);
    const artifact = job.result.artifacts[0];
    const path = artifact.published.path;
    const file = await request(
      `/p/${projectId}/api/v1/files/content?path=${encodeURIComponent(path)}`,
    );
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), original);
    assert.equal(
      (await request(`/p/${otherProjectId}/api/v1/files/content?path=${encodeURIComponent(path)}`))
        .status,
      404,
    );
    await mobile.frame.locator('[data-tab="history"]').click();
    await mobile.frame.locator('[data-history-shortcut="play"]').first().click();
    const preview = mobile.page.getByRole("region", { name: "文件预览", exact: true });
    await preview.waitFor();
    await until(
      () =>
        preview.locator("video").evaluate((video) => video.readyState >= 1 && video.videoWidth > 0),
      "Cloud preview could not decode video",
    );
    const previewUrl = await preview.locator("video").getAttribute("src");
    assert.ok(previewUrl.startsWith(`/p/${projectId}/api/v1/panels/runtime/`));
    const savedPromise = mobile.page.waitForEvent("download");
    await preview.getByRole("link", { name: "保存到此设备", exact: true }).click();
    assert.deepEqual(await readFile(await (await savedPromise).path()), original);
    await mobile.page.screenshot({
      path: join(evidenceDir, "cloud-download-preview-390.png"),
      fullPage: true,
    });
    assert.equal(
      await mobile.page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      ),
      false,
    );
    console.log(
      "PASS: real Docker Download, separate 1440/390px logins, initiating logout, shared task completion, project isolation, H264 browser preview and exact downloaded bytes",
    );
    return { id: job.id, path, assetId: artifact.assetId };
  });
  return async () =>
    browserRun(async (open) => {
      const mobile = await open(390);
      const restored = await mobile.call("tasks.get", { id: completed.id });
      assert.equal(restored.status, "succeeded");
      assert.equal(restored.result.artifacts[0].assetId, completed.assetId);
      const list = await mobile.call("tasks.list");
      assert.equal(list.filter((job) => job.entry.name === "download-runtime").length, 1);
      assert.deepEqual(
        Buffer.from(
          await (
            await request(
              `/p/${projectId}/api/v1/files/content?path=${encodeURIComponent(completed.path)}`,
            )
          ).arrayBuffer(),
        ),
        original,
      );
      await mobile.frame.locator('[data-tab="history"]').click();
      await mobile.frame.locator('[data-history-shortcut="play"]').first().click();
      const preview = mobile.page.getByRole("region", { name: "文件预览", exact: true });
      await preview.waitFor();
      await until(
        () => preview.locator("video").evaluate((video) => video.videoWidth > 0),
        "Restored cloud resource did not play",
      );
      console.log(
        "PASS: Docker project restart retains the exact Download task, file and playable resource without resubmission",
      );
    });
}
