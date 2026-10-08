/* Real production IPC and authoritative stores in an isolated Electron home.
 * No IPC replacement, provider credentials, model turns or automation run-now.
 * CODESHELL_TASK_INBOX_APP_DIR can select a separately built integration checkout.
 * CODESHELL_TASK_INBOX_SOURCES_SCREENSHOT_DIR preserves the real-data page view. */
/* global document, localStorage, window */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Transcript } from "@cjhyy/code-shell-core";
import { createPetLongTask, transitionPetLongTask } from "@cjhyy/code-shell-pet";
import {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";

const appDir = resolve(
  process.env.CODESHELL_TASK_INBOX_APP_DIR ?? dirname(fileURLToPath(import.meta.url)),
  process.env.CODESHELL_TASK_INBOX_APP_DIR ? "." : "..",
);
const isolated = await makeIsolatedElectronHome("codeshell-task-inbox-sources-");
isolated.home = await realpath(isolated.home);
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const project = join(isolated.home, "project");
const registryBootstrap = join(isolated.home, "task-inbox-registry-bootstrap.cjs");
const ids = {
  done: "task-inbox-native-done",
  orphan: "task-inbox-native-orphan",
  delegated: "task-inbox-mimi-session",
  interrupted: "task-inbox-mimi-interrupted",
  external: "task-inbox-external",
  shell: "task-inbox-shell-owner",
  run: "task-inbox-legacy-run",
  child: "task-inbox-persisted-child",
};
const titles = {
  done: "原生任务已完成",
  orphan: "重启后中断的任务",
  delegated: "Mimi 完成的任务",
  interrupted: "Mimi 等待核实的任务",
  external: "外部 Runtime 历史",
  shell: "后台进程所属对话",
  run: "历史 Run 只读记录",
  child: "持久化子 Agent 结果",
};
let app;
let win;
let processLog = "";
const rendererErrorLists = [];
const ownedProcessGroups = new Set();
const childResult = "子 Agent 持久化结果可以从真实任务中心重新打开。";
const shellCommand =
  process.platform === "win32"
    ? 'powershell -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"'
    : "while :; do sleep 1; done";

async function json(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}
async function seedAuthority() {
  await mkdir(project, { recursive: true });
  // Playwright's evaluate VM cannot dynamically import ESM. Load the exact
  // production module through a CJS test loader, without replacing any
  // handler or reader. The normal application entry stays unchanged and
  // app.evaluate exercises the real shared singleton.
  await writeFile(
    registryBootstrap,
    [
      'const {readFileSync,realpathSync}=require("node:fs");',
      'const {join,resolve}=require("node:path");',
      'const {pathToFileURL}=require("node:url");',
      `const coreDir=realpathSync(${JSON.stringify(join(appDir, "node_modules", "@cjhyy", "code-shell-core"))});`,
      'const entry=JSON.parse(readFileSync(join(coreDir,"package.json"),"utf8")).exports["./internal"].import;',
      "module.exports=import(pathToFileURL(resolve(coreDir,entry)).href).then(core=>({shells:core.backgroundShellManager}));",
    ].join("\n"),
    { mode: 0o600 },
  );
  const now = Date.now() - 5_000;
  for (const key of ["done", "orphan", "delegated", "interrupted", "external", "shell", "child"]) {
    const id = ids[key];
    const directory = join(isolated.codeShellHome, "sessions", id);
    await json(join(directory, "state.json"), {
      sessionId: id,
      parentSessionId: key === "child" ? ids.done : null,
      origin: key === "child" ? "subagent" : "desktop",
      cwd: project,
      title: titles[key],
      startedAt: now - 1000,
      status: ["orphan", "external", "interrupted"].includes(key) ? "active" : "completed",
      messages: [],
    });
    await writeFile(join(directory, "transcript.jsonl"), "");
    if (key === "child") {
      const transcript = new Transcript(join(directory, "transcript.jsonl"));
      transcript.appendMessage("user", "请给出已完成的子任务结果。");
      transcript.appendMessage("assistant", childResult);
    }
  }
  await json(join(isolated.codeShellHome, "sessions", ids.external, "external-runtime.json"), {
    version: 1,
    kind: "codex",
    cwd: project,
    runtimeSessionId: "fixture-provider-session",
    updatedAt: now,
  });
  let completed = createPetLongTask({
    id: "task-inbox-mimi-done",
    originClientMessageId: "fixture-completed-message",
    objective: titles.delegated,
    workspacePath: project,
    sessionId: ids.delegated,
    at: now,
  });
  completed = transitionPetLongTask(completed, { kind: "started", at: now + 1 });
  completed = transitionPetLongTask(completed, {
    kind: "completed",
    at: now + 2,
    summary: "已有明确完成结果",
  });
  completed = transitionPetLongTask(completed, { kind: "closure-recorded", at: now + 3 });
  completed = transitionPetLongTask(completed, { kind: "work-memory-recorded", at: now + 4 });
  const interrupted = transitionPetLongTask(
    createPetLongTask({
      id: "task-inbox-mimi-paused",
      originClientMessageId: "fixture-interrupted-message",
      objective: titles.interrupted,
      workspacePath: project,
      sessionId: ids.interrupted,
      at: now,
    }),
    { kind: "interrupted", at: now + 1, reason: "请核实持久化结果" },
  );
  await json(join(isolated.userDataDir, "pet", "long-tasks.json"), {
    version: 1,
    revision: 1,
    observedAt: now + 4,
    tasks: [completed, interrupted],
  });
  await json(join(isolated.codeShellHome, "runs", ids.run, "run.json"), {
    runId: ids.run,
    objective: titles.run,
    cwd: project,
    status: "completed",
    createdAt: now,
    updatedAt: now + 1,
    startedAt: now,
    finishedAt: now + 1,
    sessionId: null,
    summary: "历史结果",
    error: null,
  });
}
async function launch() {
  app = await launchCodeShellElectron({ appDir, ...isolated });
  app.process().stdout?.on("data", (chunk) => {
    processLog += chunk;
  });
  app.process().stderr?.on("data", (chunk) => {
    processLog += chunk;
  });
  win = await findCodeShellWindow(app);
  rendererErrorLists.push(captureRendererErrors(win));
  await win.waitForFunction(() => !!window.codeshell?.taskInbox);
  // Match the real-file activity history E2E: the preload API exists before
  // the renderer finishes startup, and its async workspace trust dialog can
  // otherwise hide a route immediately after the command palette selects it.
  const viewOnly = win.getByRole("button", { name: /仅查看|View only/i });
  const trustOpened = await viewOnly
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (trustOpened) {
    await viewOnly.click();
    await viewOnly.waitFor({ state: "hidden" });
  }
  await win.getByRole("button", { name: /^(任务中心|Task center)$/ }).waitFor();
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "zh");
    window.dispatchEvent(new window.Event("codeshell:language-changed"));
  });
}
async function list() {
  return win.evaluate(() => window.codeshell.taskInbox.list({ limit: 200 }));
}
async function until(read, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(message);
}
async function row(predicate) {
  return until(
    async () => (await list()).records.find(predicate),
    "Expected authoritative task did not appear",
  );
}
async function act(record, action, extra = {}) {
  return win.evaluate((input) => window.codeshell.taskInbox.act(input), {
    taskKey: record.taskKey,
    action,
    expectedRevision: record.sourceRevision,
    ...extra,
  });
}
async function coreRegistry(operation, input) {
  return app.evaluate(
    async (_electron, { operation, input, registryBootstrap }) => {
      const registryRequire = process
        .getBuiltinModule("node:module")
        .createRequire(registryBootstrap);
      const { shells } = await registryRequire(registryBootstrap);
      if (operation === "spawn") return shells.spawnBackground(input);
      if (operation === "get") {
        const shell = shells.get(input);
        if (!shell) return null;
        let alive = true;
        try {
          process.kill(shell.pgid, 0);
        } catch {
          alive = false;
        }
        return { status: shell.status, alive, pgid: shell.pgid };
      }
      if (operation === "kill-all") return shells.killAll();
      throw new Error("Unknown registry operation");
    },
    { operation, input, registryBootstrap },
  );
}
async function openTaskCenter() {
  await win.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  const palette = win.getByRole("dialog", { name: "命令面板", exact: true });
  await palette.waitFor({ state: "visible" });
  await palette.getByRole("combobox").fill("任务中心");
  await palette.getByRole("option", { name: "任务中心", exact: true }).click();
  await palette.waitFor({ state: "hidden" });
  await win.getByRole("heading", { name: "任务中心", level: 1 }).waitFor();
}
async function reopenChild() {
  await openTaskCenter();
  await win.getByRole("button", { name: `打开来源：${titles.child}`, exact: true }).click();
  await win.getByText(childResult, { exact: true }).waitFor();
  await win.getByRole("button", { name: "返回上级对话", exact: true }).click();
  await win.getByRole("heading", { name: "任务中心", level: 1 }).waitFor();
}
async function terminateOwnedProcessGroup(pgid) {
  assert.ok(ownedProcessGroups.has(pgid), "Only test-owned process groups may be terminated");
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill", ["/PID", String(pgid), "/T", "/F"]).catch(
      () => undefined,
    );
  } else {
    const alive = () => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    if (alive()) process.kill(-pgid, "SIGTERM");
    await until(() => !alive(), "Owned shell did not terminate", 3_000).catch(() => {
      if (alive()) process.kill(-pgid, "SIGKILL");
    });
  }
  ownedProcessGroups.delete(pgid);
}

try {
  await seedAuthority();
  await launch();
  const initial = await until(async () => {
    const value = await list();
    return value.records.some((record) => record.sourceId === "task-inbox-mimi-done") &&
      value.records.some((record) => record.sourceId === ids.run)
      ? value
      : undefined;
  }, "Durable task sources were not reconciled");
  assert.deepEqual(initial.errors, [], "Every authoritative source reconciles successfully");
  assert.equal(
    initial.records.find((record) => record.source === "session" && record.sourceId === ids.done)
      ?.status,
    "done",
  );
  assert.equal(
    initial.records.find((record) => record.source === "session" && record.sourceId === ids.orphan)
      ?.status,
    "interrupted",
  );
  assert.equal(
    initial.records.find(
      (record) => record.source === "external-runtime" && record.sourceId === ids.external,
    )?.status,
    "interrupted",
  );
  assert.equal(
    initial.records.find((record) => record.source === "subagent" && record.sessionId === ids.child)
      ?.status,
    "done",
  );
  assert.equal(
    initial.records.filter((record) => record.sessionId === ids.delegated).length,
    1,
    "Mimi and its linked Session have one primary card",
  );
  const legacy = initial.records.find(
    (record) => record.source === "legacy-run" && record.sourceId === ids.run,
  );
  assert.deepEqual(legacy.capabilities, ["open"]);
  assert.equal((await act(legacy, "cancel")).status, "unavailable");
  const originalRun = await readFile(
    join(isolated.codeShellHome, "runs", ids.run, "run.json"),
    "utf8",
  );
  console.log(
    "PASS: production IPC reconciles native, Mimi, external and legacy persisted authority",
  );
  await reopenChild();
  console.log("PASS: durable child card opens its actual read-only transcript");

  const mimi = await row((record) => record.sourceId === "task-inbox-mimi-paused");
  const pausedMimi = await act(mimi, "pause");
  assert.equal(pausedMimi.status, "ok");
  assert.equal(pausedMimi.record.status, "paused");
  const ledger = JSON.parse(
    await readFile(join(isolated.userDataDir, "pet", "long-tasks.json"), "utf8"),
  );
  assert.equal(ledger.tasks.find((task) => task.id === mimi.sourceId)?.status, "paused");

  const job = await win.evaluate(() =>
    window.codeshell.createAutomation({
      name: "任务中心生产接口验收",
      schedule: "0 0 1 1 *",
      prompt: "This annual fixture must never run during the test.",
      projectId: null,
      permissionLevel: "read-only",
    }),
  );
  const schedule = await row(
    (record) => record.source === "automation" && record.sourceId === job.id,
  );
  assert.equal(schedule.status, "queued");
  assert.equal(schedule.sessionId, undefined);
  await win.evaluate((id) => window.codeshell.pauseAutomation(id), job.id);
  assert.equal(
    (await act(schedule, "pause")).status,
    "stale",
    "Old revision cannot dispatch a schedule mutation",
  );
  const pausedSchedule = await row(
    (record) => record.sourceId === job.id && record.status === "paused",
  );
  assert.equal((await act(pausedSchedule, "resume")).status, "ok");
  const cron = JSON.parse(await readFile(join(isolated.codeShellHome, "cron.json"), "utf8"));
  assert.equal(cron.jobs.find((entry) => entry.id === job.id)?.enabled, true);
  assert.equal(cron.jobs.find((entry) => entry.id === job.id)?.runCount, 0);
  let invalidRejected = false;
  try {
    await act(schedule, "pause", { sessionId: ids.done });
  } catch {
    invalidRejected = true;
  }
  assert.equal(invalidRejected, true, "Renderer cannot supply a replacement authority target");
  console.log(
    "PASS: production Mimi and Cron controls persist authority; stale and extra-field commands are rejected",
  );

  const spawned = await coreRegistry("spawn", {
    sessionId: ids.shell,
    cwd: project,
    command: shellCommand,
  });
  assert.equal(spawned.ok, true, spawned.error);
  const cancelledPgid = (await coreRegistry("get", spawned.shellId)).pgid;
  ownedProcessGroups.add(cancelledPgid);
  const shell = await row(
    (record) =>
      record.source === "background-shell" &&
      record.sourceId.startsWith(`${spawned.shellId}:`) &&
      record.status === "running",
  );
  assert.ok(shell.capabilities.includes("cancel"));
  assert.equal((await act(shell, "cancel", { expectedRevision: "old-revision" })).status, "stale");
  assert.ok(["starting", "running"].includes((await coreRegistry("get", spawned.shellId)).status));
  assert.equal((await act(shell, "cancel")).status, "ok");
  await until(async () => {
    const state = await coreRegistry("get", spawned.shellId);
    return state?.status === "killed" && !state.alive;
  }, "Task inbox cancel did not terminate the real background shell");
  await terminateOwnedProcessGroup(cancelledPgid);
  const cancelledShell = await row(
    (record) => record.taskKey === shell.taskKey && record.status === "cancelled",
  );
  assert.deepEqual(cancelledShell.capabilities, ["open"]);
  assert.equal(
    await readFile(join(isolated.codeShellHome, "runs", ids.run, "run.json"), "utf8"),
    originalRun,
    "Legacy authority is unchanged by unavailable commands",
  );
  console.log(
    "PASS: production taskInbox cancellation terminates a real main-process background shell",
  );

  const projectionPath = join(isolated.userDataDir, "task-inbox", "v1.json");
  const stored = JSON.parse(await readFile(projectionPath, "utf8"));
  assert.equal(stored.schemaVersion, 1);
  assert.ok(
    stored.records.some(
      (record) => record.taskKey === shell.taskKey && record.status === "cancelled",
    ),
  );
  if (process.platform !== "win32") assert.equal((await stat(projectionPath)).mode & 0o777, 0o600);
  const screenshotDir = process.env.CODESHELL_TASK_INBOX_SOURCES_SCREENSHOT_DIR;
  if (screenshotDir) {
    await mkdir(screenshotDir, { recursive: true });
    await win.screenshot({
      path: join(screenshotDir, "task-inbox-real-sources.png"),
      animations: "disabled",
      scale: "css",
    });
  }
  await app.close();
  app = undefined;
  await launch();
  const restored = await list();
  assert.equal(
    restored.records.find((record) => record.taskKey === shell.taskKey)?.status,
    "cancelled",
  );
  assert.equal(
    restored.records.find((record) => record.sourceId === "task-inbox-mimi-done")?.status,
    "done",
  );
  assert.equal(
    restored.records.find((record) => record.sourceId === mimi.sourceId)?.status,
    "paused",
  );
  assert.equal(
    restored.records.find((record) => record.source === "session" && record.sourceId === ids.done)
      ?.status,
    "done",
  );
  assert.equal(restored.records.find((record) => record.sourceId === job.id)?.status, "queued");
  console.log(
    "PASS: owner-only projection persists with 0600 and restart never regresses terminal tasks",
  );
  await reopenChild();

  const abandoned = await coreRegistry("spawn", {
    sessionId: ids.shell,
    cwd: project,
    command: shellCommand,
  });
  assert.equal(abandoned.ok, true, abandoned.error);
  const abandonedPgid = (await coreRegistry("get", abandoned.shellId)).pgid;
  ownedProcessGroups.add(abandonedPgid);
  const abandonedRow = await row(
    (record) =>
      record.source === "background-shell" &&
      record.sourceId.startsWith(`${abandoned.shellId}:`) &&
      record.status === "running",
  );
  assert.ok(
    JSON.parse(await readFile(projectionPath, "utf8")).records.some(
      (record) => record.taskKey === abandonedRow.taskKey && record.status === "running",
    ),
    "Running source state must be durable before the crash",
  );
  const ownedElectron = app.process();
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned Electron did not exit")), 10_000);
    ownedElectron.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    if (!ownedElectron.kill("SIGKILL")) {
      clearTimeout(timer);
      reject(new Error("Could not crash the owned Electron process"));
    }
  });
  app = undefined;
  // The detached shell can outlive Electron. Clean only the group obtained
  // from our own actual registry entry, even if the recovery assertion fails.
  await terminateOwnedProcessGroup(abandonedPgid);
  await launch();
  const recovered = await row((record) => record.taskKey === abandonedRow.taskKey);
  assert.equal(recovered.status, "interrupted");
  assert.deepEqual(recovered.capabilities, ["open"]);
  const afterCrash = await list();
  assert.equal(
    afterCrash.records.find((record) => record.taskKey === shell.taskKey)?.status,
    "cancelled",
  );
  assert.equal(
    afterCrash.records.find((record) => record.sourceId === "task-inbox-mimi-done")?.status,
    "done",
  );
  console.log("PASS: SIGKILL recovery interrupts absent executors and preserves terminal results");
  const rendererErrors = rendererErrorLists.flat();
  assert.equal(rendererErrors.length, 0, rendererErrors.map((error) => error.message).join("\n"));
} catch (error) {
  if (win && !win.isClosed()) {
    const rendererState = await win
      .evaluate(() => ({
        readyState: document.readyState,
        view: localStorage.getItem("codeshell.view"),
        focused: document.activeElement?.outerHTML.slice(0, 1_000),
        surfaces: Array.from(document.querySelectorAll('h1,h2,[role="dialog"],[role="alert"]')).map(
          (element) => ({
            tag: element.tagName,
            role: element.getAttribute("role"),
            hiddenByModal: !!element.closest('[aria-hidden="true"]'),
            text: element.textContent?.slice(0, 3_000),
          }),
        ),
        body: document.body.innerText.slice(0, 10_000),
      }))
      .catch((cause) => ({ diagnosticError: String(cause) }));
    console.error("Task inbox renderer state:", JSON.stringify(rendererState, null, 2));
  }
  console.error(processLog.slice(-16000));
  console.error("Task inbox source E2E home:", isolated.home);
  throw error;
} finally {
  if (app) {
    await coreRegistry("kill-all").catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  for (const pgid of ownedProcessGroups) await terminateOwnedProcessGroup(pgid);
  await isolated.cleanup();
}
