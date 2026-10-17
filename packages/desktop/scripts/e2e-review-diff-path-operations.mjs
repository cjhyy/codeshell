/* Actual production Main/Review service/preload/renderer against owned Git.
 * Only catalog:list is seeded. Never replaces the Review handler or parser.
 * Run with run-isolated-node-smoke.mjs --evidence-dir <new outside directory>. */
/* global window */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertSourceElectronTransportSettled,
  captureRendererErrors,
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedSessionCatalog,
} from "./electron-harness.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
assert.equal(process.argv.length, 4);
assert.equal(process.argv[2], "--evidence-dir");
const requestedEvidence = resolve(process.argv[3]);
const evidence = join(await realpath(dirname(requestedEvidence)), basename(requestedEvidence));
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = await realpath(resolve(appDir, "../.."));
const outside = relative(repo, evidence);
assert.ok(
  outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside),
  "Evidence must be outside the checkout",
);
const outerHome = await realpath(process.env.HOME);
const outsideHome = relative(outerHome, evidence);
assert.ok(
  outsideHome === ".." || outsideHome.startsWith(`..${sep}`) || isAbsolute(outsideHome),
  "Evidence must be outside the outer HOME",
);
await mkdir(evidence, { mode: 0o700 });
const isolated = await makeIsolatedElectronHome("codeshell-review-diff-native-");
const privateRelative = relative(outerHome, isolated.home);
assert.ok(
  privateRelative === ".." || privateRelative.startsWith(`..${sep}`) || isAbsolute(privateRelative),
  "Private native HOME must survive the outer runner on failure",
);
const projectPath = join(isolated.home, "owned-review-repo");
const sessionId = "owned-review-session",
  title = "Owned Review conversation";
const put = async (file, data) => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, typeof data === "string" ? data : JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failures = [],
  operations = [],
  observerFailures = [],
  rendererErrors = [];
const report = {
  fixture: "real-review-diff-paths",
  status: "failed",
  evidence,
  privateHome: isolated.home,
  privateHomeRemoved: false,
  operations,
  failures,
  boundary:
    "Actual compiled Main, session-authorized Review service, preload, diff parser and file panel; catalog:list seeded only. Owned Git/files only; no model, worker, native crypto, OS open or account use. Not an OS socket sandbox.",
};
let app, win, monitor, captured, processClosed, fixture;
const logs = { stdout: "", stderr: "" };
const git = (...args) =>
  children.execFileSync(
    "git",
    [
      "-c",
      `core.hooksPath=${join(projectPath, "absent-hooks")}`,
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: projectPath, encoding: "utf8", timeout: 5000 },
  );
const files = {
  "sample.txt": "++ after\ncontext\n",
  "normal.txt": "new-normal\n",
  "中文.txt": "new-Chinese-owned\n",
  "new.txt": "owned rename body\n",
};
async function dismissTrust() {
  const view = win.getByRole("button", { name: /^(仅查看|View only)/ });
  if (
    await view.waitFor({ state: "visible", timeout: 1500 }).then(
      () => true,
      () => false,
    )
  )
    await view.click();
}
async function openPanel(kind) {
  const toggle = win.locator('[data-panel-action="toggle"]');
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const slot = win.locator(`[data-panel-id="${kind}"]`);
  if (await slot.count())
    await win.locator(`[id="${await slot.getAttribute("aria-labelledby")}"]`).click();
  else {
    await win.locator('[data-panel-action="new-tab"]').click();
    await win.locator(`[data-panel-menu-kind="${kind}"]`).click();
  }
  const panel = win.locator(`[data-panel-id="${kind}"][data-panel-active="true"]`);
  await panel.waitFor();
  return panel;
}
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  await mkdir(projectPath, { mode: 0o700 });
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Owned Review fixture");
  git("config", "user.email", "review@example.invalid");
  git("config", "core.quotePath", "true");
  for (const [name, content] of Object.entries({
    "sample.txt": "-- before\ncontext\n",
    "normal.txt": "old-normal\n",
    "中文.txt": "old-Chinese-owned\n",
    "old.txt": "owned rename body\n",
  }))
    await put(join(projectPath, name), content);
  git("add", ".");
  git("commit", "--quiet", "-m", "Owned Review baseline");
  await rename(join(projectPath, "old.txt"), join(projectPath, "new.txt"));
  for (const [name, content] of Object.entries(files)) await put(join(projectPath, name), content);
  git("add", "--all");
  await put(
    join(evidence, "owned-git.diff"),
    git("diff", "--cached", "--no-ext-diff", "--find-renames"),
  );
  await put(join(isolated.codeShellHome, "settings.json"), { autoUpdates: false });
  await put(join(isolated.codeShellHome, "desktop/recents.json"), [
    { path: projectPath, name: "Owned Review repository", lastOpenedAt: Date.now() },
  ]);
  const guard = join(isolated.home, "review-guard.mjs");
  await put(
    guard,
    `
import children from "node:child_process";
import http from "node:http"; import https from "node:https";
import {appendFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
await import(${JSON.stringify(new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href)});
const attempts = ${JSON.stringify(join(isolated.home, "denied-attempts.jsonl"))};
const deny = kind => { appendFileSync(attempts, JSON.stringify({pid:process.pid,kind}) + "\\n", {mode:0o600}); throw Error("Owned Review fixture denied " + kind); };
globalThis.fetch = () => deny("network");
for(const transport of [http,https]) for(const name of ["get","request"]) transport[name] = () => deny("network");
const spawn = children.spawn;
children.spawn = function(command,args,options) { if(args?.some(arg=>String(arg).includes("agent-server-stdio"))) return deny("worker"); return spawn.call(this,command,args,options); };
syncBuiltinESMExports();
const {app,ipcMain,net,safeStorage,shell} = await import("electron");
net.request = net.fetch = () => deny("network");
for(const name of ["isEncryptionAvailable","getSelectedStorageBackend","encryptString","decryptString"]) if(typeof safeStorage[name]==="function") safeStorage[name] = () => deny("crypto");
for(const name of ["openPath","openExternal","showItemInFolder"]) shell[name] = () => deny("OS-open");
app.on("web-contents-created",(_event,contents)=>contents.session.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]},()=>deny("network")));
globalThis.__ownedReviewCalls = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel,listener) => handle(channel,channel!=="review:diff" ? listener : async (...args) => { const result=await listener(...args); globalThis.__ownedReviewCalls.push({sessionId:args[1],request:args[2],result}); return result; });
const on=ipcMain.on.bind(ipcMain);
ipcMain.on=(channel,listener)=>on(channel,channel!=="agent:msg"?listener:(event,line)=>{let request;try{request=JSON.parse(line);}catch{return listener(event,line);}if(request?.method==="agent/run")return deny("core-turn");return listener(event,line);});
`,
  );
  fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin: "http://127.0.0.1:9",
    guardModule: pathToFileURL(guard).href,
  });
  fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
  report.build = {
    sourceHead: children
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" })
      .trim(),
    sourceDirty:
      children
        .execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
          cwd: repo,
          encoding: "utf8",
        })
        .trim() !== "",
    fixtureSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
    parserSHA256: hash(await readFile(join(appDir, "src/renderer/diff/parseUnifiedDiff.ts"))),
    mainSHA256: hash(await readFile(join(appDir, "out/main/index.mjs"))),
    preloadSHA256: hash(await readFile(join(appDir, "out/preload/index.cjs"))),
    rendererHTMLSHA256: hash(await readFile(join(appDir, "out/renderer/index.html"))),
  };
  const executable = await realpath(createRequire(import.meta.url)("electron"));
  const originalSpawn = children.spawn;
  children.spawn = function (command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    if (command === executable && options?.env?.HOME === isolated.home) {
      assert.equal(captured, undefined);
      captured = child;
      processClosed = new Promise((done) =>
        child.once("close", (code, signal) => done({ code, signal })),
      );
      child.once("error", () => observerFailures.push("Owned Electron spawn error"));
      for (const stream of ["stdout", "stderr"])
        child[stream]?.on(
          "data",
          (chunk) => (logs[stream] = (logs[stream] + chunk).slice(-1024 * 1024)),
        );
      monitor = watchElectronTestProcess(child, {
        timeoutMs: 120000,
        reportFailure: (message) => observerFailures.push(message),
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    app = await launchCodeShellElectron(
      { appDir, ...isolated, mainEntry: fixture.mainEntry, env: fixture.env },
      {
        reportFailure: (message) => observerFailures.push(message),
        watch: (child) => {
          assert.equal(child, captured, "Harness must reuse this exact early Main custody");
          return monitor;
        },
      },
    );
  } finally {
    children.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  assert.equal(captured, app.process());
  win = await findCodeShellWindow(app);
  win.setDefaultTimeout(10000);
  rendererErrors.push(captureRendererErrors(win));
  await win.setViewportSize({ width: 1440, height: 960 });
  await dismissTrust();
  await win.getByText("Owned Review repository", { exact: true }).first().click();
  await dismissTrust();
  const project = await win.evaluate(
    async (path) =>
      (await window.codeshell.projectRegistry.list()).find((project) =>
        project.roots.some((root) => root.path === path),
      ),
    projectPath,
  );
  assert.ok(project?.id);
  await put(join(isolated.codeShellHome, "sessions", sessionId, "state.json"), {
    sessionId,
    title,
    cwd: projectPath,
    project: { projectId: project.id, mainRootId: project.primaryRootId },
    origin: "desktop",
    kind: "work",
    parentSessionId: null,
    status: "completed",
    startedAt: Date.now(),
  });
  await put(
    join(isolated.codeShellHome, "sessions", sessionId, "transcript.jsonl"),
    JSON.stringify({
      id: "owned-message",
      timestamp: Date.now(),
      turnNumber: 1,
      type: "message",
      data: { role: "user", content: title },
    }) + "\n",
  );
  await seedSessionCatalog(win, {
    [project.id]: {
      sessions: [
        {
          id: sessionId,
          engineSessionId: sessionId,
          title,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      activeSessionId: null,
    },
  });
  await win.reload();
  await dismissTrust();
  await expandSidebar(win);
  await win.getByRole("button", { name: title, exact: true }).click();
  await dismissTrust();
  report.confinement = await fixture.assertWorker(app, { requireWorker: false });
  assert.equal(report.confinement.workerCreated, false);
  let review = await openPanel("review");
  await review.getByRole("button", { name: /^(选择审查范围|Choose review scope)$/ }).click();
  await win.getByRole("menuitem", { name: /^(已暂存|Staged)$/ }).click();
  await review.getByText("new-normal", { exact: true }).waitFor();
  report.cards = await review.locator("button[aria-expanded]").evaluateAll((buttons) =>
    buttons.map((button) => ({
      title: button.querySelector("span.truncate[title]")?.getAttribute("title"),
      header: button.innerText,
      rows: [...button.parentElement.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      ),
    })),
  );
  for (const [name, expected] of Object.entries(files)) {
    const card = report.cards.find((card) => card.title === name);
    const correct =
      !!card &&
      (name === "new.txt"
        ? /重命名|Renamed/.test(
            await review.locator('span[title="new.txt"]').locator("..").locator("..").innerHTML(),
          )
        : card.header.includes("+1 -1") &&
          card.rows.some(
            (cells) => cells[3] === expected.trimEnd().split("\n")[0] && cells[2] === "+",
          ));
    operations.push({
      action: `Review staged ${name} preserves path and actual Git changes`,
      correct,
      card: card ?? null,
    });
    if (!correct) failures.push({ message: `Review did not preserve ${name}` });
  }
  const sample = report.cards.find((card) => card.title === "sample.txt");
  if (
    sample &&
    !sample.rows.some(
      (row) => row[0] === "1" && row[1] === "" && row[2] === "-" && row[3] === "-- before",
    )
  )
    failures.push({ message: "Header-like deleted content disappeared from Review" });
  if (
    sample &&
    !sample.rows.some((row) => row[0] === "2" && row[1] === "2" && row[3] === "context")
  )
    failures.push({ message: "Header-like content shifted context line numbers" });
  await win.screenshot({ path: join(evidence, "review-staged.png") });
  await win.evaluate(() => {
    window.__ownedReviewOpen = [];
    window.addEventListener("codeshell:open-file", (event) =>
      window.__ownedReviewOpen.push(event.detail),
    );
  });
  for (const name of ["normal.txt", "sample.txt", "中文.txt", "new.txt"]) {
    if (!report.cards.some((card) => card.title === name)) continue;
    review = await openPanel("review");
    const header = review
      .locator("span.truncate[title]")
      .filter({ hasText: name })
      .locator("..")
      .locator("..");
    await header.getByRole("button", { name: /^(打开文件|Open file)$/ }).click();
    const panel = win.locator('[data-panel-id="files"][data-panel-active="true"]');
    await panel.waitFor();
    const previewLines = [];
    for (const line of files[name].trimEnd().split("\n")) {
      // The production text preview renders each line as a separate row.
      const renderedLine = panel.getByText(line, { exact: true });
      await renderedLine.waitFor();
      previewLines.push(await renderedLine.textContent());
    }
    assert.deepEqual(previewLines, files[name].trimEnd().split("\n"));
    const opened = await win.evaluate(() => window.__ownedReviewOpen.at(-1));
    assert.equal(opened.path, join(projectPath, name));
    assert.equal(await readFile(join(projectPath, name), "utf8"), files[name]);
    operations.push({
      action: `Review open ${name} reaches actual file preview`,
      opened,
      previewLines,
      actualBytesSHA256: hash(await readFile(join(projectPath, name))),
    });
  }
  report.reviewCalls = await app.evaluate(() => globalThis.__ownedReviewCalls);
  assert.ok(
    report.reviewCalls.some(
      (call) =>
        call.sessionId === sessionId &&
        call.request.kind === "working" &&
        call.request.mode === "staged" &&
        call.result.errors.length === 0 &&
        call.result.repositories.some(
          (repository) =>
            repository.repoRoot === projectPath && repository.diff.includes("rename from old.txt"),
        ),
    ),
  );
} catch (error) {
  failures.push({ message: error.message, stack: error.stack });
  await win?.screenshot({ path: join(evidence, "failure.png"), timeout: 2000 }).catch(() => {});
} finally {
  try {
    if (app && monitor) await bounded(app.close(), 8000, "Owned Review close timed out");
  } catch (error) {
    failures.push({ stage: "close", message: error.message });
  }
  try {
    assert.ok(monitor, "Owned Main custody missing");
    report.settlement = await monitor.terminate();
    assert.equal(report.settlement.status, "cleaned");
    report.mainExit = await bounded(processClosed, 3000, "Owned Main exit unavailable");
    assert.deepEqual(report.mainExit, { code: 0, signal: null });
    report.windowsTransport = assertSourceElectronTransportSettled(captured);
  } catch (error) {
    failures.push({ stage: "custody", message: error.message });
    captured?.unref();
    captured?.stdout?.unref?.();
    captured?.stderr?.unref?.();
  }
  report.rendererErrors = rendererErrors.flat().map((error) => error.message);
  if (report.rendererErrors.length) failures.push({ message: "Renderer errors observed" });
  if (observerFailures.length)
    failures.push({ message: "Custody observer errors", observerFailures });
  for (const name of [
    "denied-attempts.jsonl",
    "spawned-workers.jsonl",
    "cost-gui-guard.jsonl",
    "network-guard.jsonl",
  ]) {
    const content = await readFile(join(isolated.home, name), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await put(join(evidence, name), content);
    if (["denied-attempts.jsonl", "spawned-workers.jsonl"].includes(name) && content.trim())
      failures.push({ message: `Forbidden runtime side effect: ${name}` });
  }
  for (const stream of ["stdout", "stderr"])
    await put(join(evidence, `main.${stream}.log`), logs[stream]);
  if (!failures.length && report.settlement?.status === "cleaned" && report.mainExit?.code === 0) {
    await isolated.cleanup();
    report.privateHomeRemoved = true;
    report.status = "passed";
  }
  await put(join(evidence, "receipt.json"), report);
}
console.log(
  JSON.stringify({ status: report.status, evidence, operations: operations.length, failures }),
);
assert.equal(
  report.status,
  "passed",
  "Review diff regression failed; evidence and private HOME retained",
);
