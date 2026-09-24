/** Render the production Web version-management UI at desktop and phone widths.
 * HTTP replies are controlled fixtures; actual package/Host execution is covered by
 * project-packages.test.ts and e2e-shared-panel-tasks.mjs --project-pins.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/desktop/package.json"));
const { chromium } = require("playwright");
const { build } = require("esbuild");
const scratch = await mkdtemp(join(tmpdir(), "codeshell-package-history-ui-"));
let browser, server;
try {
  await build({
    stdin: {
      contents:
        'import React from "react"; import {createRoot} from "react-dom/client"; import {HubPanels} from "./app/HubPanels.tsx"; import "./app/app.css"; createRoot(document.getElementById("root")).render(<HubPanels onAuthLost={()=>{throw new Error("Unexpected auth loss")}} onOpen={()=>{}}/>);',
      resolveDir: join(root, "packages/web"),
      loader: "tsx",
    },
    bundle: true,
    format: "esm",
    outfile: join(scratch, "ui.js"),
    define: { "process.env.NODE_ENV": '"production"' },
  });
  server = createServer(async (req, res) => {
    const name = req.url === "/ui.js" ? "ui.js" : req.url === "/ui.css" ? "ui.css" : null;
    if (name) {
      res.setHeader("content-type", name.endsWith("css") ? "text/css" : "text/javascript");
      res.end(await readFile(join(scratch, name)));
    } else {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><style>body{margin:0;font:14px system-ui;color:#222;background:#fafafa}button,input{font:inherit}#root{max-width:1000px;margin:auto;padding:16px;box-sizing:border-box}</style><div id="root"></div><script type="module" src="/ui.js"></script></html>',
      );
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const [width, unavailable] of [
    [390, false],
    [1440, false],
    [390, true],
    [1440, true],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    const versions = [
      {
        version: "1.0.0",
        packageDigest: "a".repeat(64),
        permissions: ["storage", "workspace.write"],
        compatibility: { supported: true, reasons: [] },
      },
      {
        version: "2.0.0",
        packageDigest: "b".repeat(64),
        permissions: ["storage"],
        compatibility: { supported: true, reasons: [] },
      },
    ];
    let selected = versions[1];
    let mutations = 0;
    await page.route("**/api/v1/panels**", async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      const panel = {
        ...selected,
        id: "fixture",
        title: { default: "示例面板" },
        entry: "app/index.html",
        singleton: true,
        revision: "project-revision",
        bound: true,
        enabled: true,
        globalDisabled: false,
        updatable: false,
        source: { kind: "local", label: "已审阅安装包" },
      };
      let json;
      if (path === "/api/v1/panels")
        json = {
          panels: unavailable && !mutations ? [] : [panel],
          issues:
            unavailable && !mutations
              ? [
                  {
                    id: panel.id,
                    version: panel.version,
                    revision: panel.revision,
                    code: "package_unavailable",
                    bound: true,
                    globalDisabled: false,
                  },
                ]
              : [],
          workspace: "/project",
          hasProject: true,
          canRestorePackages: true,
        };
      else if (path.endsWith("/versions"))
        json = {
          appId: panel.id,
          title: panel.title,
          expectedRevision: panel.revision,
          current: { ...selected, unavailable },
          versions: unavailable ? [versions[0]] : versions,
          unavailablePackages: 1,
        };
      else if (path.endsWith("/restore-preview"))
        json = {
          ...versions[0],
          appId: panel.id,
          title: panel.title,
          current: { ...selected, unavailable },
          expectedRevision: panel.revision,
          addedPermissions: unavailable ? versions[0].permissions : ["workspace.write"],
          reviewToken: "reviewed-restore",
          expiresAt: Date.now() + 60000,
        };
      else if (path.endsWith("/restore")) {
        assert.deepEqual(request.postDataJSON(), { reviewToken: "reviewed-restore" });
        selected = versions[0];
        mutations++;
        json = { id: panel.id, packageDigest: selected.packageDigest };
      } else throw new Error(`Unexpected request: ${path}`);
      await route.fulfill({ json });
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: unavailable ? "检查可用版本" : "项目版本", exact: true })
      .click();
    await page.getByRole("button", { name: "审阅 v1.0.0", exact: true }).click();
    await page
      .getByText(unavailable ? "需重新确认" : "新增权限", { exact: true })
      .first()
      .waitFor();
    assert.equal(mutations, 0);
    await page.screenshot({
      path: join(scratch, `${unavailable ? "repair" : "restore"}-${width}.png`),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.getByRole("button", { name: "确认权限并恢复项目版本", exact: true }).click();
    await page.getByText("示例面板 的项目版本已恢复为 v1.0.0。", { exact: true }).waitFor();
    assert.equal(mutations, 1);
    assert.deepEqual(failures, []);
    await page.close();
  }
  console.log(
    JSON.stringify({ webVersionRestore: true, widths: [390, 1440], screenshots: scratch }),
  );
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  // Keep screenshots as visual evidence, discard generated application bundles.
  await Promise.all(["ui.js", "ui.css"].map((file) => rm(join(scratch, file), { force: true })));
}
