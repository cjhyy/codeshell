/* Native composer events through the production ChatView, preload and Main.
 * Agent run/control RPCs are captured and answered at Main before the
 * production listener can enter the Worker/Engine; catalog:list returns an
 * owned synthetic model catalog. File search, authorization,
 * attachment staging and session persistence retain their production handlers.
 * Clipboard writes contain only owned fixture bytes/text; no existing clipboard
 * content is read. No React internals, synthetic DOM events or model are used. */
/* global document, window */
import assert from "node:assert/strict";
import children, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import {
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedSessionCatalog,
} from "./electron-harness.mjs";

assert.ok(process.env.CODE_SHELL_TEST_HOME, "Use run-isolated-node-smoke.mjs");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--evidence-dir" && args[1]),
  "Expected no arguments or --evidence-dir <new-owned-directory>",
);
const evidence = args.length
  ? join(await realpath(dirname(resolve(args[1]))), basename(resolve(args[1])))
  : await mkdtemp(join(tmpdir(), "codeshell-composer-reference-evidence-"));
const evidenceRelative = relative(appDir, evidence);
assert.ok(
  evidenceRelative === ".." ||
    evidenceRelative.startsWith(`..${sep}`) ||
    isAbsolute(evidenceRelative),
  "Evidence must remain outside Desktop",
);
if (args.length) await mkdir(evidence, { mode: 0o700 });
const isolated = await makeIsolatedElectronHome("codeshell-composer-reference-");
const projectPath = join(isolated.home, "owned-project");
const filename = "owned-报告 with spaces.md";
const filepath = join(projectPath, filename);
const explicitPath = join(projectPath, "explicit-附件.txt");
const sessionId = "composer-reference-native-session";
const title = "Owned composer reference operations";
const origin = "http://127.0.0.1:9";
const modifier = process.platform === "darwin" ? "Meta" : "Control";
const report = {
  result: "pending",
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim(),
  boundary: {
    production:
      "compiled ChatView/App → real preload → native Main IPC; file search/root authorization, attachment staging and session catalog are production",
    controlled:
      "Main captures agent/run, agent/configure, agent/steer, agent/unsteer and agent/cancel before invoking the production agent listener; run results are synthetic and may be held pending. catalog:list returns an owned synthetic UI model catalog; browser file chooser selection is controlled with an owned path.",
    excluded:
      "No Worker, Engine, provider, external network, real credentials or original clipboard reads. This does not prove model execution or attachment consumption by Engine.",
  },
  cases: [],
  errors: [],
  evidence,
};
let electron,
  win,
  monitor,
  captured,
  processClosed,
  failure,
  stage = "setup";
let confined;

async function prepare() {
  await mkdir(projectPath, { mode: 0o700 });
  await writeFile(filepath, "Owned Unicode and whitespace file reference\n", { mode: 0o600 });
  await writeFile(explicitPath, "Owned explicit picker attachment\n", { mode: 0o600 });
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(isolated.codeShellHome, "desktop", "recents.json"),
    JSON.stringify([{ path: projectPath, name: "owned-project", lastOpenedAt: Date.now() }]),
    { mode: 0o600 },
  );
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({
      autoUpdates: false,
      modelConnections: [
        { id: "owned-ui-model", catalogId: "owned-ui", tag: "text", model: "owned-ui" },
      ],
      defaults: { text: "owned-ui-model" },
      credentials: [],
    }),
    { mode: 0o600 },
  );
  const guard = join(isolated.home, "composer-deny-network.mjs");
  await writeFile(
    guard,
    `
await import(${JSON.stringify(new URL("../../../scripts/runtime-cost-smoke-isolation.mjs", import.meta.url).href)});
const { app, net } = await import("electron");
const { syncBuiltinESMExports } = await import("node:module");
const guard = globalThis.__composerGuard = { unexpected: [], probes: [], probing: false };
const deny = (transport) => { if (!guard.probing) guard.unexpected.push(transport); throw new Error("Owned composer fixture denies network: " + transport); };
globalThis.fetch = async () => deny("fetch");
for (const name of ["node:http", "node:https"]) {
  const transport = (await import(name)).default;
  transport.request = () => deny(name); transport.get = () => deny(name);
}
for (const [name, methods] of [["node:net", ["connect", "createConnection"]], ["node:tls", ["connect"]]]) {
  const transport = (await import(name)).default;
  for (const method of methods) transport[method] = () => deny(name + "." + method);
}
net.fetch = async () => deny("electron.net.fetch");
net.request = () => deny("electron.net.request");
syncBuiltinESMExports();
app.on("web-contents-created", (_event, contents) => contents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, done) => {
  guard.unexpected.push("chromium"); done({ cancel: true });
}));
guard.probing = true;
for (const [name, probe] of [
  ["fetch external", () => fetch("https://example.invalid/blocked")],
  ["HTTP external", async () => (await import("node:http")).request("http://example.invalid/blocked")],
  ["HTTP other loopback", async () => (await import("node:http")).request("http://127.0.0.1:10/blocked")],
  ["HTTPS external", async () => (await import("node:https")).get("https://example.invalid/blocked")],
  ["raw socket", async () => (await import("node:net")).connect(443, "example.invalid")],
  ["TLS socket", async () => (await import("node:tls")).connect(443, "example.invalid")],
  ["Electron net", () => net.request("https://example.invalid/blocked")],
]) {
  let blocked = false;
  try { await probe(); } catch (error) { blocked = error.message.startsWith("Owned composer fixture denies network:"); }
  guard.probes.push({ name, blocked });
  if (!blocked) throw new Error("Network negative probe escaped: " + name);
}
guard.probing = false;
`,
    { mode: 0o600 },
  );
  confined = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin,
    guardModule: pathToFileURL(guard).href,
  });
  const productionImport = `await import(${JSON.stringify(pathToFileURL(join(appDir, "out/main/index.mjs")).href)});`;
  const bootstrap = await readFile(confined.mainEntry, "utf8");
  assert.equal(bootstrap.split(productionImport).length, 2, "Exact production Main import seam");
  await writeFile(
    confined.mainEntry,
    bootstrap.replace(
      productionImport,
      `
const { ipcMain } = await import("electron");
const fixture = globalThis.__composerReference = { calls: [], stages: [], hold: false, pending: [], workerAttempts: 0, handlerRegistered: false };
const guardedSpawn = children.spawn;
children.spawn = function (command, args, options) {
  if (args?.some(value => String(value).includes("agent-server-stdio"))) {
    fixture.workerAttempts++;
    throw new Error("Owned composer fixture forbids Worker/Engine startup");
  }
  return guardedSpawn.call(this, command, args, options);
};
syncBuiltinESMExports();
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, channel === "catalog:list" ? () => [{
  id: "owned-ui", tag: "text", adapterKind: "openai", displayName: "Owned UI model", description: "No provider exists",
  defaultBaseUrl: ${JSON.stringify(origin)}, modelPresets: [{ value: "owned-ui", label: "Owned UI model", maxContextTokens: 4096, supportsVision: true }],
}] : channel === "attachments:stageImageDataUrl" ? async (...args) => {
  const result = await listener(...args); fixture.stages.push(result); return result;
} : listener);
const on = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => {
  if (channel !== "agent:msg") return on(channel, listener);
  fixture.handlerRegistered = true;
  return on(channel, (event, line) => {
    const message = JSON.parse(line);
    if (!["agent/run", "agent/configure", "agent/steer", "agent/unsteer", "agent/cancel"].includes(message.method)) return listener(event, line);
    const params = message.params ?? {};
    if (params.sessionId !== ${JSON.stringify(sessionId)}) throw new Error("Unexpected owned session");
    if (message.method === "agent/run" && (params.cwd !== ${JSON.stringify(projectPath)} || !params.task.includes("[OWNED_"))) throw new Error("Unexpected owned run");
    fixture.calls.push(message);
    const reply = (result) => event.sender.send("agent:msg", JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "agent/run" && fixture.hold) fixture.pending.push(() => reply({ reason: "complete", text: "Owned controlled completion" }));
    else if (message.method === "agent/cancel") {
      for (const settle of fixture.pending.splice(0)) settle();
      reply({ cancelled: true });
    } else reply(message.method === "agent/steer" ? { accepted: true } : message.method === "agent/unsteer" ? { removed: true } : { reason: "complete", text: "Owned controlled completion" });
  });
};
${productionImport}
`,
    ),
    { mode: 0o600 },
  );
}

const composer = () => win.locator('textarea[aria-autocomplete="list"]:visible');
async function dismissTrust() {
  const view = win.getByRole("button", { name: /^(仅查看|View only)/ });
  if (
    await view.waitFor({ timeout: 2_000 }).then(
      () => true,
      () => false,
    )
  )
    await view.click();
}
async function mainState() {
  return electron.evaluate(() => ({
    calls: globalThis.__composerReference.calls,
    stages: globalThis.__composerReference.stages,
    pending: globalThis.__composerReference.pending.length,
    workerAttempts: globalThis.__composerReference.workerAttempts,
    handlerRegistered: globalThis.__composerReference.handlerRegistered,
    guard: globalThis.__composerGuard,
  }));
}
async function waitCall(method, previous) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    let timer;
    let state;
    try {
      state = await Promise.race([
        mainState(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`IPC wait timed out: ${method}`)),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const calls = state.calls.filter((call) => call.method === method);
    if (calls.length > previous) {
      assert.equal(calls.length, previous + 1, `Exactly one ${method} submission`);
      return calls.at(-1);
    }
    if (Date.now() >= deadline) throw new Error(`IPC not reached: ${method}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function count(method) {
  return (await mainState()).calls.filter((call) => call.method === method).length;
}
async function clearDraft() {
  await composer().focus();
  await composer().press(`${modifier}+a`);
  await composer().press("Backspace");
  await composer().press("Escape");
  assert.equal(await composer().inputValue(), "");
}
async function pickFile() {
  assert.equal(await composer().inputValue(), "");
  await composer().focus();
  await win.keyboard.type("@owned-");
  await win.getByRole("option").filter({ hasText: filename }).click();
  await win.waitForFunction((path) => {
    const input = document.querySelector('textarea[aria-autocomplete="list"]');
    const expected = `@${path} `;
    return (
      input?.value === expected &&
      document.activeElement === input &&
      input.selectionStart === expected.length &&
      input.selectionEnd === expected.length
    );
  }, filepath);
  return await composer().inputValue();
}
async function editMention(kind, marker) {
  const before = await pickFile();
  if (kind === "delete") {
    await clearDraft();
  } else {
    // The insertion lies inside the picked range, before its separator. A
    // clipboard suffix containing a space must not match the old path prefix.
    await composer().press("ArrowLeft");
    if (kind === "paste-suffix") {
      await electron.evaluate(({ clipboard }) => clipboard.writeText(" copy"));
      await composer().press(`${modifier}+v`);
    } else await win.keyboard.type(".bak");
    await composer().press("Escape");
    await composer().press(`${modifier}+End`);
  }
  await win.keyboard.type(` [OWNED_${marker}]`);
  const after = await composer().inputValue();
  assert.ok(
    kind === "delete"
      ? !after.includes(filepath)
      : after.includes(`${filepath}${kind === "paste-suffix" ? " copy" : ".bak"}`),
  );
  return { before, after };
}
async function submit(marker, expectRefs = []) {
  const previous = await count("agent/run");
  const text = await composer().inputValue();
  assert.ok(text.includes(`[OWNED_${marker}]`));
  await composer().press("Enter");
  const call = await waitCall("agent/run", previous);
  assert.deepEqual(
    (call.params.attachments ?? []).map((ref) => ({
      kind: ref.kind,
      path: ref.path,
      origin: ref.origin,
    })),
    expectRefs,
  );
  await win.waitForFunction(
    () => document.querySelector('textarea[aria-autocomplete="list"]')?.value === "",
  );
  await win.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "hidden" });
  return { text, payload: call };
}
async function startHeld(marker) {
  await electron.evaluate(() => {
    globalThis.__composerReference.hold = true;
  });
  const previous = await count("agent/run");
  await composer().focus();
  await win.keyboard.type(`[OWNED_${marker}]`);
  await composer().press("Enter");
  await waitCall("agent/run", previous);
  await win.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor();
}
async function stopHeld() {
  await electron.evaluate(() => {
    globalThis.__composerReference.hold = false;
  });
  await win.getByRole("button", { name: /^(停止|Stop)$/ }).click();
  await win.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "hidden" });
}

try {
  await prepare();
  stage = "launch";
  const executable = await realpath(createRequire(import.meta.url)("electron"));
  const originalSpawn = children.spawn;
  children.spawn = function (command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    if (command === executable && options?.env?.HOME === isolated.home) {
      assert.equal(captured, undefined, "Exactly one owned Electron Main may be launched");
      captured = child;
      processClosed = new Promise((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
      );
      report.processCapture = { pid: child.pid, homeMatched: true, beforeHandshake: true };
      child.once("error", () => report.errors.push("Owned Electron spawn error"));
      // Establish PID + parent + birth custody before Playwright can await its
      // native handshake. A failed identity query confers no signaling right.
      monitor = watchElectronTestProcess(child, {
        timeoutMs: 180_000,
        reportFailure: (message) => {
          report.errors.push(message);
        },
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    electron = await launchCodeShellElectron(
      { appDir, ...isolated, env: confined.env, mainEntry: confined.mainEntry },
      { watch: () => {} },
    );
  } finally {
    children.spawn = originalSpawn;
    syncBuiltinESMExports();
    report.spawnRestored = children.spawn === originalSpawn;
  }
  assert.equal(captured, electron.process(), "Early watcher must bind the launched Main");
  report.processCapture.handshakeCompleted = true;
  win = await findCodeShellWindow(electron);
  win.setDefaultTimeout(10_000);
  win.on("pageerror", (error) => report.errors.push(error.message));
  await win.setViewportSize({ width: 1280, height: 850 });
  await dismissTrust();
  await win.evaluate((cwd) => window.codeshell.setTrust(cwd, "trusted"), projectPath);
  await win.getByText("owned-project", { exact: true }).first().click();
  await dismissTrust();
  const project = await win.evaluate(
    async (cwd) =>
      (await window.codeshell.projectRegistry.list()).find((item) =>
        item.roots.some((root) => root.path === cwd),
      ),
    projectPath,
  );
  assert.ok(project?.id);
  const folder = join(isolated.codeShellHome, "sessions", sessionId);
  await mkdir(folder, { mode: 0o700, recursive: true });
  await writeFile(
    join(folder, "state.json"),
    JSON.stringify({
      sessionId,
      title,
      cwd: projectPath,
      project: { projectId: project.id, mainRootId: project.primaryRootId },
      origin: "desktop",
      kind: "work",
      parentSessionId: null,
      status: "completed",
      startedAt: Date.now(),
    }),
    { mode: 0o600 },
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
  await expandSidebar(win);
  await win.getByRole("button", { name: title, exact: true }).click();
  await dismissTrust();
  report.confinement = await confined.assertWorker(electron, { requireWorker: false });
  assert.equal(report.confinement.workerCreated, false);
  await composer().waitFor();
  await win.evaluate(() => {
    window.__composerEvents = [];
    const input = document.querySelector('textarea[aria-autocomplete="list"]');
    for (const type of ["beforeinput", "input", "keydown", "paste", "cut"])
      input.addEventListener(type, (event) =>
        window.__composerEvents.push({
          type,
          trusted: event.isTrusted,
          inputType: event.inputType ?? null,
          key: event.key ?? null,
          value: input.value,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
        }),
      );
    document.addEventListener("mousedown", (event) => {
      const option = event.target.closest('[role="option"]');
      if (option)
        window.__composerEvents.push({
          type: "mention-pick",
          trusted: event.isTrusted,
          text: option.textContent,
        });
    });
  });
  stage = "visible Unicode whitespace reference";
  const visible = await pickFile();
  await win.keyboard.type("[OWNED_VISIBLE]");
  report.cases.push({
    operation: stage,
    before: visible,
    ...(await submit("VISIBLE", [{ kind: "file", path: filepath, origin: "mention" }])),
  });

  for (const kind of ["delete", "suffix", "paste-suffix"]) {
    stage = `${kind} ordinary send`;
    const edit = await editMention(kind, `SEND_${kind}`);
    report.cases.push({ operation: stage, ...edit, ...(await submit(`SEND_${kind}`)) });
  }

  for (const kind of ["delete", "paste-suffix"]) {
    stage = `${kind} queued send`;
    await startHeld(`QUEUE_HOLD_${kind}`);
    const edit = await editMention(kind, `QUEUE_${kind}`);
    const previous = await count("agent/steer");
    await composer().press("Enter");
    const payload = await waitCall("agent/steer", previous);
    assert.deepEqual(payload.params.attachments ?? [], []);
    assert.equal(payload.params.text, edit.after.trim());
    await win.getByRole("button", { name: /^(清除后续变更|Clear follow-up changes)$/ }).click();
    await stopHeld();
    report.cases.push({ operation: stage, ...edit, payload });
  }

  for (const kind of ["delete", "suffix"]) {
    stage = `${kind} force send`;
    await startHeld(`FORCE_HOLD_${kind}`);
    const edit = await editMention(kind, `FORCE_${kind}`);
    const previous = await count("agent/run");
    await electron.evaluate(() => {
      globalThis.__composerReference.hold = false;
    });
    await win.getByRole("button", { name: /^(引导|Guide)$/ }).click();
    const payload = await waitCall("agent/run", previous);
    assert.deepEqual(payload.params.attachments ?? [], []);
    assert.equal(payload.params.task, edit.after.trim());
    await win.getByRole("button", { name: /^(停止|Stop)$/ }).waitFor({ state: "hidden" });
    report.cases.push({ operation: stage, ...edit, payload });
  }

  stage = "explicit picker file and real pasted image survive deleted mention";
  await editMention("delete", "EXPLICIT");
  // Playwright's native file chooser sets the browser File; getPathForFile and
  // production file attachment handling remain real. It does not inject state.
  const choose = win.waitForEvent("filechooser");
  await win.getByRole("button", { name: /^(添加本地文件|Add local file)$/ }).click();
  await (await choose).setFiles(explicitPath);
  const png = (await readFile(join(appDir, "build", "icon.png"))).toString("base64");
  await electron.evaluate(({ clipboard, nativeImage }, base64) => {
    const image = nativeImage
      .createFromBuffer(Buffer.from(base64, "base64"))
      .resize({ width: 8, height: 8 });
    if (image.isEmpty()) throw new Error("Owned image fixture is empty");
    clipboard.writeImage(image);
  }, png);
  await composer().focus();
  await composer().press(`${modifier}+v`);
  await win.getByRole("img", { name: "image.png", exact: true }).waitFor();
  const staged = (await mainState()).stages.at(-1);
  assert.equal(staged.origin, "paste");
  const previous = await count("agent/run");
  const explicitText = await composer().inputValue();
  await win.screenshot({
    path: join(evidence, "explicit-attachments.png"),
    animations: "disabled",
  });
  await composer().press("Enter");
  const explicitPayload = await waitCall("agent/run", previous);
  assert.deepEqual(
    explicitPayload.params.attachments.map((ref) => ({
      kind: ref.kind,
      path: ref.path,
      origin: ref.origin,
    })),
    [
      { kind: "image", path: staged.path, origin: "paste" },
      { kind: "file", path: basename(explicitPath), origin: "picker" },
    ],
  );
  assert.equal(explicitPayload.params.attachments[1].absPath, explicitPath);
  const stagedBytes = await readFile(staged.absPath);
  const fileSHA256 = createHash("sha256").update(stagedBytes).digest("hex");
  assert.equal(stagedBytes.length, staged.size);
  assert.equal(fileSHA256, staged.sha256);
  assert.equal(fileSHA256, explicitPayload.params.attachments[0].sha256);
  const decoded = await electron.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
    return { empty: image.isEmpty(), size: image.getSize() };
  }, stagedBytes.toString("base64"));
  assert.deepEqual(decoded, { empty: false, size: { width: 8, height: 8 } });
  report.cases.push({
    operation: stage,
    text: explicitText,
    staged,
    fileSHA256,
    decoded,
    payload: explicitPayload,
  });
  await win.screenshot({ path: join(evidence, "composer-reference.png"), animations: "disabled" });
  report.events = await win.evaluate(() => window.__composerEvents);
  assert.ok(report.events.some((event) => event.type === "paste" && event.trusted));
  assert.equal(
    report.events.filter(
      (event) => event.type === "mention-pick" && event.trusted && event.text.includes(filename),
    ).length,
    9,
  );
  assert.ok(
    report.events.some(
      (event) =>
        event.type === "beforeinput" && event.trusted && event.inputType === "insertFromPaste",
    ),
  );
  assert.ok(
    report.events.some(
      (event) => event.type === "keydown" && event.key === "Backspace" && event.trusted,
    ),
  );
  assert.ok(
    report.events.every((event) => event.trusted),
    "All observed composer input events must be native trusted events",
  );
  report.main = await mainState();
  assert.equal(report.main.handlerRegistered, true);
  assert.equal(report.main.workerAttempts, 0);
  assert.deepEqual(report.main.guard.unexpected, []);
  assert.equal(report.main.guard.probes.length, 7);
  assert.ok(report.main.guard.probes.every((probe) => probe.blocked));
  assert.equal(report.main.pending, 0);
  assert.deepEqual(
    Object.fromEntries(
      ["agent/run", "agent/steer", "agent/unsteer", "agent/cancel"].map((method) => [
        method,
        report.main.calls.filter((call) => call.method === method).length,
      ]),
    ),
    { "agent/run": 11, "agent/steer": 2, "agent/unsteer": 2, "agent/cancel": 4 },
  );
  assert.deepEqual(report.errors, []);
  report.result = "pass";
} catch (error) {
  failure = error;
  report.failure = error.stack;
  report.stage = stage;
  await win?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  report.body = await win
    ?.locator("body")
    .innerText()
    .catch(() => "unavailable");
  report.main = await mainState().catch(() => null);
  report.events = await win?.evaluate(() => window.__composerEvents ?? []).catch(() => []);
} finally {
  try {
    if (electron && monitor) {
      let timer;
      try {
        await Promise.race([
          electron.close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Owned Electron close timed out")), 8_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    report.errors.push(error.message);
    failure ??= error;
  }
  if (!monitor && captured) {
    // Never substitute an ordinary app.close or a raw PID signal for custody.
    captured.unref();
    captured.stdout?.unref?.();
    captured.stderr?.unref?.();
  }
  try {
    report.processSettlement = (await monitor?.terminate()) ?? null;
    assert.equal(
      report.processSettlement?.status,
      "cleaned",
      "Owned process birth settlement must prove cleanup",
    );
    let timer;
    try {
      report.mainExit = await Promise.race([
        processClosed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owned Main close event missing")), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.deepEqual(report.mainExit, { code: 0, signal: null }, "Main must exit normally");
    await isolated.cleanup();
    report.privateHomeRemoved = true;
  } catch (error) {
    report.errors.push(error.message);
    report.retainedHome = isolated.home;
    failure ??= error;
  }
  if (failure || report.errors.length) {
    report.result = "fail";
    report.failure ??= failure?.stack;
  }
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(
  JSON.stringify({
    result: report.result,
    cases: report.cases.length,
    stage,
    evidence,
    processSettlement: report.processSettlement?.status,
  }),
);
if (failure) throw failure;
assert.equal(report.result, "pass");
