/** Real Node + browser navigation test. No providers, workers or user credentials are used.
 * Prerequisite: bun run build:server; Desktop dev dependencies with Playwright Chromium.
 * Proves environment navigation/auth isolation and small-screen layout, not Panel parity.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startProjectControlServer } from "../packages/server/dist/project-runtime/control-server.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { chromium } = createRequire(join(root, "packages/desktop/package.json"))("playwright");
const scratch = await mkdtemp(join(tmpdir(), "cs-environment-ui-"));
const evidence = process.env.CODESHELL_ENVIRONMENT_EVIDENCE;
const servers = [];
let browser;
try {
  for (const host of ["127.0.0.1", "localhost"]) {
    const provider = {
      availability: async () => ({ available: true }),
      ensure: async () => {
        throw new Error("This navigation test must not start tasks");
      },
      stop: async () => {},
      status: async () => ({ state: "missing" }),
      close: async () => {},
    };
    servers.push(
      await startProjectControlServer({
        host,
        port: 0,
        dataDir: join(scratch, host),
        staticRootDir: join(root, "packages/web/dist-app"),
        provider,
      }),
    );
  }
  browser = await chromium.launch({ headless: true });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const first = servers[0],
      second = servers[1];
    const login = async (server) => {
      const status = await context.request.get(server.url + "/api/v1/auth/status");
      const { initialized } = await status.json();
      const result = await context.request.post(
        server.url + `/api/v1/auth/${initialized ? "login" : "setup"}`,
        {
          headers: { Origin: server.url },
          data: {
            username: "tester",
            password: "synthetic-environment-password-23891",
            ...(initialized ? {} : { token: server.bootstrapToken }),
          },
        },
      );
      assert.equal(result.status(), 200);
    };
    await login(first);
    await page.goto(first.url);
    await page.getByRole("heading", { name: "你的项目" }).waitFor();
    await page.getByRole("button", { name: /云端项目/ }).click();
    await page.getByRole("heading", { name: "电脑与云端" }).waitFor();
    await page.getByRole("button", { name: "保存当前环境" }).click();
    await page.getByLabel("连接名称").fill("另一个云端");
    await page.getByLabel("工作台地址").fill(second.url + "/?pairing=never-store-this");
    await page.getByRole("button", { name: "添加连接" }).click();
    await page.getByRole("alert").filter({ hasText: "配对令牌" }).waitFor();
    assert.equal(
      await page.evaluate(() => JSON.stringify(localStorage).includes("never-store-this")),
      false,
    );
    await page.getByLabel("工作台地址").fill(second.url + "/");
    await page.getByRole("button", { name: "添加连接" }).click();
    const row = page.getByRole("listitem").filter({ hasText: "另一个云端" });
    await row.waitFor();
    assert.equal(
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog");
        return (
          dialog.scrollWidth <= dialog.clientWidth + 1 &&
          document.documentElement.scrollWidth <= innerWidth
        );
      }),
      true,
      "connection dialog must fit the viewport",
    );
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `environments-${viewport.width}.png`) });
    }
    await row.getByRole("button", { name: "打开", exact: true }).click();
    await page.waitForURL(second.url + "/");
    const targetStatus = await context.request.get(second.url + "/api/v1/auth/status");
    assert.equal(
      (await targetStatus.json()).authenticated,
      false,
      "source login must not authenticate another host",
    );
    await login(second);
    await page.reload();
    await page.getByRole("heading", { name: "你的项目" }).waitFor();
    const source = await context.request.get(first.url + "/api/v1/environment");
    const target = await context.request.get(second.url + "/api/v1/environment");
    assert.notEqual((await source.json()).id, (await target.json()).id);
    await page.goto(first.url);
    await page.getByRole("button", { name: /云端项目/ }).click();
    await page.getByRole("listitem").filter({ hasText: "另一个云端" }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS native Node environment navigation, auth isolation, saved connections, ${viewport.width}px`,
    );
  }
} finally {
  await browser?.close();
  await Promise.all(servers.map((server) => server.close()));
  await rm(scratch, { recursive: true, force: true });
}
