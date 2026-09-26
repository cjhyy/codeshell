/** Real Node Hub + production Web UI + Core installer. Only GitHub's upstream
 * commit/archive replies are controlled, using a temporary Git repository.
 * No browser API routes, package grants, authentication or storage are mocked.
 * Requires `bun run build` and Playwright Chromium from Desktop dependencies.
 */
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(import.meta.url);
const root = resolve(dirname(file), "..");
const id = "web-recovery-panel";
const title = "Web Recovery Panel";
const sourceUrl = "https://github.com/codeshell-tests/web-recovery";
function git(repo, ...args) {
  const result = spawnSync("git", args, { cwd: repo, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

if (process.argv[2] === "--host") {
  const scratch = process.argv[3];
  const repo = join(scratch, "source");
  const { startHeadlessServer, resolveWorkerEntry } =
    await import("../packages/server/dist/index.serve.js");
  const originalFetch = globalThis.fetch;
  let brokenArchive = false;
  const downloads = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.github.com") {
      assert.equal(url.pathname, "/repos/codeshell-tests/web-recovery/commits/main");
      return Response.json({ sha: String(git(repo, "rev-parse", "HEAD")).trim() });
    }
    if (url.origin === "https://codeload.github.com") {
      assert.ok(url.pathname.startsWith("/codeshell-tests/web-recovery/zip/"));
      const ref = decodeURIComponent(url.pathname.split("/zip/")[1]);
      assert.match(ref, /^[a-f0-9]{40}$/);
      downloads.push(ref);
      if (brokenArchive) return new Response("source unavailable", { status: 503 });
      const bytes = git(repo, "archive", "--format=zip", "--prefix=source/", ref);
      return new Response(bytes, {
        headers: { "content-type": "application/zip", "content-length": String(bytes.length) },
      });
    }
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname),
      `Unexpected network: ${url.origin}`,
    );
    return originalFetch(input, init);
  };
  const servers = [];
  async function start(index, port = 0) {
    servers[index] = await startHeadlessServer({
      cwd: join(scratch, `project-${index}`),
      dataDir: join(scratch, `data-${index}`),
      workerEntryPath: resolveWorkerEntry(),
      execPath: process.execPath,
      staticRootDir: join(root, "packages/web/dist-app"),
      authMode: "hub",
      host: "127.0.0.1",
      port,
    });
    return { url: servers[index].url, token: servers[index].bootstrapToken };
  }
  const ports = JSON.parse(process.argv[4] ?? "[0,0]");
  const endpoints = [await start(0, ports[0]), await start(1, ports[1])];
  process.on("message", async (message) => {
    try {
      let result;
      if (message.kind === "sourceFailure") {
        brokenArchive = message.enabled;
      } else if (message.kind === "downloads") result = downloads;
      else if (message.kind === "stop") {
        await Promise.all(servers.map((server) => server.close()));
        process.send({ request: message.request });
        process.disconnect();
        return;
      } else throw new Error("Unknown fixture command");
      process.send({ request: message.request, result });
    } catch (error) {
      process.send({ request: message.request, error: String(error) });
    }
  });
  process.send({ ready: endpoints });
} else {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "cs-web-recovery-")));
  const repo = join(scratch, "source");
  const evidence = await mkdtemp(join(tmpdir(), "cs-web-recovery-evidence-"));
  const { chromium } = createRequire(join(root, "packages/desktop/package.json"))("playwright");
  let browser, child;
  let logs = "";
  const errors = [];
  let sequence = 0;
  function command(kind, values = {}) {
    const request = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Fixture command timed out: ${kind}`)),
        30_000,
      );
      const onMessage = (reply) => {
        if (reply.request === request)
          finish(reply.error ? new Error(reply.error) : null, reply.result);
      };
      const onExit = () => finish(new Error("Host exited before fixture command completed"));
      function finish(error, value) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve(value);
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send({ kind, request, ...values });
    });
  }
  async function launchHost(ports = [0, 0]) {
    // Isolate only the child runtime. The parent and user's running app retain
    // their environment; no test package is installed in the user's catalog.
    child = fork(file, ["--host", scratch, JSON.stringify(ports)], {
      execArgv: [],
      silent: true,
      env: {
        ...process.env,
        HOME: join(scratch, "home"),
        CODE_SHELL_HOME: join(scratch, "home/.code-shell"),
      },
    });
    child.stdout.on("data", (data) => {
      logs = (logs + data).slice(-40_000);
    });
    child.stderr.on("data", (data) => {
      logs = (logs + data).slice(-40_000);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Host startup timed out")), 30_000);
      const onMessage = (message) => {
        if (message.ready) finish(null, message.ready);
      };
      const onExit = () => finish(new Error(`Host startup failed: ${logs}`));
      function finish(error, endpoints) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", finish);
        if (error) reject(error);
        else resolve(endpoints);
      }
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", finish);
    });
  }
  async function stopHost() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      process.exitCode = 1;
    }, 10_000);
    try {
      await command("stop");
      const [code, signal] = await exited;
      assert.equal(code, 0, `Host did not stop cleanly: ${signal}`);
    } finally {
      clearTimeout(timer);
    }
  }
  async function writePackage(version) {
    await mkdir(join(repo, ".codeshell-panel"), { recursive: true });
    await mkdir(join(repo, "app"), { recursive: true });
    await writeFile(
      join(repo, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        version,
        title: { default: title },
        entry: "app/index.html",
        placement: "right-dock",
        icon: "panel",
        singleton: true,
        permissions: [
          "context.workspace",
          "storage",
          ...(version === "1.0.0" ? [] : ["workspace.write"]),
        ],
      }),
    );
    await writeFile(
      join(repo, "app/index.html"),
      `<!doctype html><html><body>
      <h1>Package ${version}</h1><label>Document<input id="doc" aria-label="Document"></label>
      <button id="save" disabled>Save</button><output id="state">Loading</output>
      <script src="app.js"></script></body></html>`,
    );
    await writeFile(
      join(repo, "app/app.js"),
      `
      let snapshot;
      window.codeshellPanel.call('storage.getSnapshot', {key:'document'}).then(value => {
        snapshot = value; document.getElementById('doc').value = value.value || '';
        document.getElementById('save').disabled = false; document.getElementById('state').textContent = 'Ready';
      });
      document.getElementById('save').onclick = async () => {
        const result = await window.codeshellPanel.call('storage.compareAndSet', {
          key:'document', expectedRevision:snapshot.revision, value:document.getElementById('doc').value
        });
        if (!result.updated) throw new Error('Document conflict');
        snapshot = result.snapshot; document.getElementById('state').textContent = 'Saved';
      };
      `,
    );
    git(repo, "add", ".");
    git(repo, "commit", "-m", `fixture ${version}`);
    return String(git(repo, "rev-parse", "HEAD")).trim();
  }
  try {
    await mkdir(repo);
    for (const index of [0, 1]) await mkdir(join(scratch, `project-${index}`));
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Recovery fixture");
    git(repo, "config", "user.email", "recovery@codeshell.test");
    const originalCommit = await writePackage("1.0.0");
    let endpoints = await launchHost();
    browser = await chromium.launch({ headless: true });
    const contexts = await Promise.all(
      endpoints.map(() => browser.newContext({ viewport: { width: 1440, height: 1000 } })),
    );
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    for (const page of pages) {
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error("Page error:", error.message);
      });
      page.on("dialog", (dialog) => {
        errors.push(`Unexpected dialog: ${dialog.message()}`);
        void dialog.dismiss();
      });
    }
    async function login(index, setup = false) {
      const { url, token } = endpoints[index];
      const response = await contexts[index].request.post(
        `${url}/api/v1/auth/${setup ? "setup" : "login"}`,
        {
          headers: { origin: url },
          data: {
            username: "tester",
            password: "synthetic-recovery-password-39102",
            ...(setup ? { token } : {}),
          },
        },
      );
      assert.equal(response.status(), 200, await response.text());
    }
    async function snapshot(index) {
      const response = await contexts[index].request.get(`${endpoints[index].url}/api/v1/panels`);
      assert.equal(response.status(), 200);
      return response.json();
    }
    const panel = async (index) => (await snapshot(index)).panels.find((item) => item.id === id);
    const card = (index) =>
      pages[index]
        .locator('section[aria-labelledby="installed-panels-heading"] .panels-card')
        .filter({ has: pages[index].getByRole("heading", { name: title, exact: true }) });
    async function management(index) {
      await pages[index].getByRole("button", { name: "面板", exact: true }).click();
      await pages[index].getByRole("heading", { name: "面板", exact: true }).waitFor();
    }
    async function version(index, expected) {
      await card(index).getByText(`v${expected}`, { exact: true }).waitFor();
      assert.equal((await panel(index)).version, expected);
    }
    async function document(index, expectedVersion, value, save = false) {
      await card(index).getByRole("button", { name: "打开面板", exact: true }).click();
      const frame = pages[index].frameLocator(`iframe[title="${title}面板"]`);
      await frame
        .getByRole("heading", { name: `Package ${expectedVersion}`, exact: true })
        .waitFor();
      await frame.getByText("Ready", { exact: true }).waitFor();
      if (save) {
        await frame.getByLabel("Document").fill(value);
        await frame.getByRole("button", { name: "Save", exact: true }).click();
        await frame.getByText("Saved", { exact: true }).waitFor();
      } else assert.equal(await frame.getByLabel("Document").inputValue(), value);
      await management(index);
    }
    async function restore(index, target, repair = false) {
      const page = pages[index];
      const beforeReview = await snapshot(index);
      await page
        .getByRole("button", { name: repair ? "检查可用版本" : "项目版本", exact: true })
        .click();
      await page.getByRole("button", { name: `审阅 v${target}`, exact: true }).click();
      await page.getByRole("button", { name: "确认权限并恢复项目版本", exact: true }).waitFor();
      assert.deepEqual(
        await snapshot(index),
        beforeReview,
        "Review must not change project bindings",
      );
      if (repair) assert.equal(await page.getByText("需重新确认", { exact: true }).count(), 3);
      await page.screenshot({
        path: join(evidence, `${repair ? "repair" : "restore"}-${index}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "确认权限并恢复项目版本", exact: true }).click();
      await page.getByText(`${title} 的项目版本已恢复为 v${target}。`, { exact: true }).waitFor();
      await version(index, target);
    }
    for (const index of [0, 1]) {
      assert.equal(
        (await contexts[index].request.get(`${endpoints[index].url}/api/v1/panels`)).status(),
        401,
      );
      await login(index, true);
      await pages[index].goto(endpoints[index].url);
      await management(index);
    }
    const first = pages[0];
    await first.getByLabel("GitHub 仓库地址").fill(sourceUrl);
    await first.getByText("指定分支或子目录", { exact: true }).click();
    await first.getByLabel("分支 / 标签（可选）").fill("main");
    await first.getByRole("button", { name: "读取仓库", exact: true }).click();
    await first.getByRole("button", { name: "审阅安装", exact: true }).click();
    await first.getByRole("heading", { name: "审阅面板安装" }).waitFor();
    assert.equal(await panel(0), undefined);
    // Moving upstream HEAD after review must still install the reviewed bytes.
    const updatedCommit = await writePackage("2.0.0");
    await first.getByRole("button", { name: "确认安装", exact: true }).click();
    await version(0, "1.0.0");
    const original = await panel(0);
    assert.equal(original.source.commit, originalCommit);
    await pages[1].getByRole("button", { name: "刷新", exact: true }).click();
    await card(1).getByRole("button", { name: "绑定工作区", exact: true }).click();
    await version(1, "1.0.0");
    for (const index of [0, 1]) await document(index, "1.0.0", `Project ${index} edits`, true);
    await card(0).getByRole("button", { name: "检查更新", exact: true }).click();
    await first.getByRole("heading", { name: "审阅面板更新" }).waitFor();
    await first.getByText("workspace.write", { exact: true }).waitFor();
    assert.equal((await panel(0)).version, "1.0.0");
    await first.getByRole("button", { name: "确认更新", exact: true }).click();
    await version(0, "2.0.0");
    assert.equal((await panel(0)).source.commit, updatedCommit);
    await version(1, "1.0.0");
    await document(0, "2.0.0", "Project 0 edits");
    await document(1, "1.0.0", "Project 1 edits");
    await restore(0, "1.0.0");
    await document(0, "1.0.0", "Project 0 edits");
    await writeFile(
      join(
        scratch,
        "home/.code-shell/panel-apps/.versions",
        id,
        original.packageDigest,
        "app/index.html",
      ),
      "corrupt retained bytes",
    );
    for (const index of [0, 1])
      await pages[index].getByRole("button", { name: "刷新", exact: true }).click();
    await restore(0, "2.0.0", true);
    assert.equal((await snapshot(1)).issues[0].id, id);
    await restore(1, "2.0.0", true);
    // Failed source access must leave selected packages and data usable.
    const beforeFailure = await panel(0);
    await command("sourceFailure", { enabled: true });
    await card(0).getByRole("button", { name: "检查更新", exact: true }).click();
    await first.getByRole("alert").waitFor();
    assert.equal((await panel(0)).packageDigest, beforeFailure.packageDigest);
    await command("sourceFailure", { enabled: false });
    assert.ok((await command("downloads")).includes(originalCommit));
    assert.ok((await command("downloads")).includes(updatedCommit));
    await rm(repo, { recursive: true });
    const previousPid = child.pid;
    await stopHost();
    endpoints = await launchHost(endpoints.map(({ url }) => Number(new URL(url).port)));
    assert.notEqual(child.pid, previousPid);
    for (const index of [0, 1]) {
      await login(index);
      await pages[index].reload();
      await management(index);
      await version(index, "2.0.0");
      await document(index, "2.0.0", `Project ${index} edits`);
    }
    assert.deepEqual(await command("downloads"), [], "Restart must not need the deleted source");
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        realNodeHub: true,
        realBrowserUi: true,
        controlledGitHubSource: true,
        reviewedInstallAndUpdate: true,
        reviewedCommitSurvivesUpstreamChange: true,
        fullHostProcessRestart: true,
        twoProjectIsolation: true,
        versionRollback: true,
        corruptedPackageRepair: true,
        sourceFailurePreservesPackage: true,
        restartWithoutSourcePreservesDocuments: true,
        evidence,
      }),
    );
  } catch (error) {
    console.error(error, logs, errors);
    for (const [index, page] of (
      browser?.contexts().flatMap((context) => context.pages()) ?? []
    ).entries()) {
      console.error(
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable"),
      );
      await page
        .screenshot({ path: join(evidence, `failure-${index}.png`), fullPage: true })
        .catch(() => {});
    }
    console.error("Evidence:", evidence);
    throw error;
  } finally {
    await browser?.close();
    await stopHost();
    await rm(scratch, { recursive: true, force: true });
  }
}
