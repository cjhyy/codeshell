/* Real MemorySection → Main review/commit → disk/prompt consumer. No Engine/model request. */
/* global localStorage, window */
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assert,
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
} from "./electron-harness.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";

assert(
  process.env.NODE_ENV === "test" &&
    process.env.CODE_SHELL_TEST_HOME === join(process.env.HOME, ".code-shell"),
  "Run through run-isolated-node-smoke.mjs",
);
const flag = process.argv.indexOf("--evidence-dir");
assert(flag < 0 || process.argv[flag + 1], "--evidence-dir requires a path");
const evidence =
  flag >= 0
    ? resolve(process.argv[flag + 1])
    : await mkdtemp(join(tmpdir(), "codeshell-profile-memory-electron-"));
assert(
  !evidence.startsWith(resolve(process.env.HOME) + sep),
  "Evidence must survive private HOME cleanup",
);
await mkdir(evidence, { recursive: true, mode: 0o700 });
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = pathToFileURL(resolve(appDir, "../core/dist") + sep).href;
const isolated = await makeIsolatedElectronHome("codeshell-profile-memory-e2e-");
isolated.home = await realpath(isolated.home);
isolated.codeShellHome = join(isolated.home, ".code-shell");
isolated.userDataDir = join(isolated.home, "electron-user-data");
const project = join(isolated.home, "source-project"),
  otherProject = join(isolated.home, "other-project");
const profiles = [
  { name: "enabled", label: "Portable enabled", portableMemory: true },
  { name: "disabled", label: "Portable disabled", portableMemory: false },
];
const failures = [],
  logs = { stdout: "", stderr: "" },
  receipt = { fixture: "profile-memory-promotion-electron", valid: false };
let app,
  win,
  stage = "seed",
  processClosed;
async function put(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { mode: 0o600 });
}
async function dismissTrust() {
  const button = win.getByRole("button", { name: /仅查看|View only/i });
  if (
    await button.waitFor({ state: "visible", timeout: 5000 }).then(
      () => true,
      () => false,
    )
  )
    await button.click();
}
async function snapshot(name) {
  await win.screenshot({
    path: join(evidence, `${name}.png`),
    animations: "disabled",
    scale: "css",
  });
}
try {
  await mkdir(project, { recursive: true });
  await mkdir(otherProject, { recursive: true });
  await put(join(isolated.codeShellHome, "settings.json"), '{"autoUpdates":false}\n');
  await put(
    join(isolated.codeShellHome, "desktop/recents.json"),
    JSON.stringify([{ path: project, name: "Memory source project", lastOpenedAt: Date.now() }]),
  );
  for (const profile of profiles)
    await put(
      join(isolated.codeShellHome, "profiles", profile.name, "profile.json"),
      JSON.stringify({
        ...profile,
        basePreset: "general",
        skills: [],
        agents: [],
        mcp: [],
        plugins: [],
        sourceAccess: [],
      }),
    );
  const profileBytes = await Promise.all(
    profiles.map((p) => readFile(join(isolated.codeShellHome, "profiles", p.name, "profile.json"))),
  );
  const guard = join(isolated.home, "promotion-guard.mjs");
  await put(
    guard,
    `
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
await import(${JSON.stringify(new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href)});
const state = globalThis.__profilePromotion = {pid:process.pid, networkAttempts:0, calls:[]};
const deny = () => { state.networkAttempts++; throw new Error("Memory promotion fixture denies HTTP"); };
globalThis.fetch = deny;
for (const transport of [http, https]) { transport.request = deny; transport.get = deny; }
syncBuiltinESMExports();
if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  globalThis.__promotionImport = (url) => import(url);
  const { app, ipcMain, net } = await import("electron");
  net.request = deny; net.fetch = deny;
  app.on("web-contents-created", (_event, contents) => contents.session.webRequest.onBeforeRequest({urls:["http://*/*", "https://*/*"]}, (_details, done) => { state.networkAttempts++; done({cancel:true}); }));
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => handle(channel, !["memory:previewProfilePromotion", "memory:commitProfilePromotion"].includes(channel) ? handler : async (...args) => {
    const call = {channel, input:structuredClone(args[1]), sender:args[0].sender.id}; state.calls.push(call);
    try { call.result = await handler(...args); return call.result; }
    catch (error) { call.error = String(error); throw error; }
  });
}
process.once("exit", () => appendFileSync(${JSON.stringify(join(isolated.home, "promotion-guard-final.jsonl"))}, JSON.stringify(state) + "\\n", {mode:0o600}));
`,
  );
  const fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin: "http://127.0.0.1:9",
    guardModule: pathToFileURL(guard).href,
  });
  fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
  stage = "launch";
  app = await launchCodeShellElectron({
    appDir,
    home: isolated.home,
    userDataDir: isolated.userDataDir,
    mainEntry: fixture.mainEntry,
    env: fixture.env,
  });
  const child = app.process();
  receipt.mainPid = child.pid;
  processClosed = new Promise((done) =>
    child.once("close", (code, signal) => done({ code, signal })),
  );
  for (const stream of ["stdout", "stderr"])
    child[stream]?.on("data", (chunk) => {
      logs[stream] = (logs[stream] + chunk).slice(-1024 * 1024);
    });
  win = await findCodeShellWindow(app);
  const rendererErrors = captureRendererErrors(win);
  await fixture.assertWorker(app, { requireWorker: false });
  const sources = await app.evaluate(
    async (_electron, { core, project }) => {
      const { MemoryManager } = await globalThis.__promotionImport(core + "session/memory.js");
      return ["user", "dream"].map((scope) => {
        const manager = new MemoryManager({ projectDir: project, scope });
        manager.save({
          name: `${scope}-source`,
          description: `PROJECT_ONLY_${scope}`,
          type: "project",
          content: `SOURCE_BODY_${scope}`,
          origin: scope === "dream" ? "dream" : "auto",
          useCount: 19,
          updateCount: 4,
          lastUsedAt: "2020-01-01T00:00:00.000Z",
        });
        const entry = manager.loadAll()[0];
        return {
          ...entry,
          paths: [
            joinPath(manager.getMemoryDir(), entry.fileName),
            joinPath(manager.getMemoryDir(), "MEMORY.md"),
          ],
        };
      });
      function joinPath(a, b) {
        return a + "/" + b;
      }
    },
    { core, project },
  );
  const sourceFiles = sources.flatMap((s) => s.paths),
    sourceBytes = await Promise.all(sourceFiles.map((path) => readFile(path)));
  stage = "open real MemorySection";
  await win.setViewportSize({ width: 1440, height: 960 });
  await dismissTrust();
  await win
    .locator("aside")
    .getByRole("button", { name: "Memory source project", exact: true })
    .click();
  await dismissTrust();
  await win.evaluate(() => {
    localStorage.setItem("codeshell.uiLanguage", "en");
    window.dispatchEvent(new window.Event("codeshell:language-changed"));
  });
  await navigateSettingsMenu(win, /Open settings/i);
  await win
    .getByRole("navigation", { name: "Settings navigation" })
    .getByRole("button", { name: "Memory", exact: true })
    .click();
  await win
    .locator("main")
    .getByRole("button", { name: /Memory source project/ })
    .click();
  async function draft(scope, profile, name) {
    await win
      .getByRole("button", { name: scope === "user" ? "Long-term" : "Auto-organized", exact: true })
      .click();
    await win.getByRole("button", { name: new RegExp(`${scope}-source`) }).click();
    await win.getByRole("button", { name: "Copy to digital human", exact: true }).click();
    const dialog = win.getByRole("dialog", { name: "Copy to digital human", exact: true });
    await dialog.getByRole("combobox", { name: "Target digital human" }).click();
    await win
      .getByRole("option", { name: `${profile.label} (${profile.name})`, exact: true })
      .click();
    await dialog.getByLabel("Memory name", { exact: true }).fill(name);
    await dialog.getByLabel("One-line summary", { exact: true }).fill(`PORTABLE_${scope}_SUMMARY`);
    await dialog.getByRole("combobox", { name: "Memory type" }).click();
    await win.getByRole("option", { name: "Reference", exact: true }).click();
    await dialog.locator("textarea").fill(`EDITED_${scope}_BODY\nFull reviewed content.`);
    await dialog.getByRole("checkbox", { name: "Pin", exact: true }).setChecked(scope === "user");
    if (!profile.portableMemory) await dialog.getByText(/Portable memory is disabled/).waitFor();
    return dialog;
  }
  async function review(dialog, scope) {
    await dialog.getByRole("button", { name: "Review copy", exact: true }).click();
    const confirm = win.getByRole("dialog", { name: "Copy this memory?", exact: true });
    await confirm.waitFor();
    const text = await confirm.innerText();
    for (const expected of [
      `SOURCE_BODY_${scope}`,
      `EDITED_${scope}_BODY`,
      `PORTABLE_${scope}_SUMMARY`,
    ])
      assert(text.includes(expected), `Full review omitted ${expected}`);
    return confirm;
  }
  stage = "cancel reviewed copy";
  let dialog = await draft("user", profiles[0], "Reviewed user lesson");
  let confirm = await review(dialog, "user");
  await snapshot("review-cancel");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await confirm.waitFor({ state: "hidden" });
  assert(
    !(await stat(join(isolated.codeShellHome, "profiles/enabled/memory")).catch(() => null)),
    "Cancel wrote target memory",
  );
  assert(
    (await app.evaluate(
      () =>
        globalThis.__profilePromotion.calls.filter(
          (c) => c.channel === "memory:commitProfilePromotion",
        ).length,
    )) === 0,
    "Cancel called commit",
  );
  stage = "commit user copy";
  confirm = await review(dialog, "user");
  await confirm.getByRole("button", { name: "Confirm copy", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  stage = "same-name conflict";
  dialog = await draft("user", profiles[0], "Reviewed user lesson");
  await dialog.getByRole("button", { name: "Review copy", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: /target memory name already exists/ })
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  stage = "commit dream copy to disabled profile";
  dialog = await draft("dream", profiles[1], "Reviewed dream lesson");
  confirm = await review(dialog, "dream");
  assert(
    (await confirm.innerText()).includes("Portable memory is disabled"),
    "Disabled review omitted warning",
  );
  await snapshot("disabled-profile-review");
  await confirm.getByRole("button", { name: "Confirm copy", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  stage = "disk and cross-project injection";
  const verified = await app.evaluate(
    async (_electron, { core, profiles, sources, otherProject }) => {
      const { MemoryManager } = await globalThis.__promotionImport(core + "session/memory.js");
      const { resolveRunProfileState } = await globalThis.__promotionImport(
        core + "engine/run-setup.js",
      );
      const { SettingsManager } = await globalThis.__promotionImport(core + "settings/manager.js");
      const { PromptComposer } = await globalThis.__promotionImport(core + "prompt/composer.js");
      const { join } = await globalThis.__promotionImport("node:path");
      const entries = [],
        injected = [];
      for (const [i, profile] of profiles.entries()) {
        const dir = join(process.env.CODE_SHELL_HOME, "profiles", profile.name);
        const manager = new MemoryManager({ baseDir: dir, scope: "user" });
        const list = manager.loadAll();
        if (list.length !== 1) throw new Error("Expected exactly one copied memory per Profile");
        const entry = list[0],
          scope = sources[i].scope;
        if (
          !/^[a-f0-9-]{36}$/.test(entry.id) ||
          sources.some((s) => s.id === entry.id) ||
          entry.origin !== "manual" ||
          entry.scope !== "user" ||
          entry.type !== "reference" ||
          !!entry.pinned !== (scope === "user") ||
          entry.content !== `EDITED_${scope}_BODY\nFull reviewed content.` ||
          entry.description !== `PORTABLE_${scope}_SUMMARY` ||
          entry.useCount ||
          entry.updateCount ||
          entry.lastUsedAt !== entry.createdAt ||
          entry.lastUsedAt === sources[i].lastUsedAt ||
          entry.originProjects?.length ||
          entry.promotionStatus
        )
          throw new Error("Copied disk identity/content/lifecycle mismatch");
        const settings = new SettingsManager(otherProject, "isolated");
        const run = resolveRunProfileState({
          sessionWorkspaceProfile: profile.name,
          cwd: otherProject,
          settings,
        });
        const composer = new PromptComposer({
          cwd: otherProject,
          model: "synthetic",
          profileMemoryDir: run.profileMemoryDir,
          disableInstructions: true,
          disableCapabilityContext: true,
          disableSourcesContext: true,
        });
        const message = await composer.buildDynamicContextMessage();
        const text = typeof message?.content === "string" ? message.content : "";
        if (
          text.includes(`PORTABLE_${scope}_SUMMARY`) !== profile.portableMemory ||
          /PROJECT_ONLY_|user-source|dream-source/.test(text)
        )
          throw new Error("Cross-project portable memory injection mismatch");
        entries.push(entry);
        injected.push({
          profile: profile.name,
          portableMemory: !!run.profileMemoryDir,
          matched: text.includes(`PORTABLE_${scope}_SUMMARY`),
        });
      }
      return { entries, injected, main: globalThis.__profilePromotion };
    },
    { core, profiles, sources, otherProject },
  );
  for (const [i, path] of sourceFiles.entries())
    assert((await readFile(path)).equals(sourceBytes[i]), "Source bytes changed");
  for (const [i, profile] of profiles.entries())
    assert(
      (
        await readFile(join(isolated.codeShellHome, "profiles", profile.name, "profile.json"))
      ).equals(profileBytes[i]),
      "Profile settings changed",
    );
  const calls = verified.main.calls;
  assert(
    calls.filter((c) => c.channel === "memory:previewProfilePromotion").length === 4 &&
      calls.filter((c) => c.channel === "memory:commitProfilePromotion").length === 2 &&
      calls.filter((c) => c.error).length === 1,
    "Unexpected real IPC calls",
  );
  assert(
    verified.main.networkAttempts === 0 && rendererErrors.length === 0,
    "Unexpected HTTP/renderer errors",
  );
  receipt.confinement = await fixture.assertWorker(app, { requireWorker: false });
  Object.assign(receipt, verified, {
    canceledReadOnly: true,
    sameNameConflict: true,
    sourceUnchanged: true,
    profileSettingsUnchanged: true,
    rendererErrors: [],
  });
} catch (error) {
  failures.push(error);
  if (win) {
    await snapshot("failure").catch((e) => failures.push(e));
    await put(join(evidence, "failure.html"), await win.content()).catch((e) => failures.push(e));
  }
} finally {
  if (app) {
    try {
      await app.close();
      receipt.mainClose = await processClosed;
    } catch (error) {
      failures.push(error);
    }
  }
  for (const name of [
    "cost-gui-guard.jsonl",
    "promotion-guard-final.jsonl",
    "real-keyring-bootstrap.jsonl",
  ]) {
    try {
      await put(join(evidence, name), await readFile(join(isolated.home, name)));
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    const finals = (await readFile(join(evidence, "promotion-guard-final.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert(
      finals.some((s) => s.pid === receipt.mainPid) && finals.every((s) => s.networkAttempts === 0),
      "Missing final guard or unexpected blocked HTTP",
    );
    assert(
      receipt.mainClose?.code === 0 && !receipt.mainClose.signal,
      "Electron did not close cleanly",
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await isolated.cleanup();
    receipt.homeCleaned = true;
  } catch (error) {
    failures.push(error);
  }
  receipt.valid = failures.length === 0;
  Object.assign(receipt, {
    stage,
    errors: failures.map((e) => ({ message: String(e), stack: e?.stack })),
  });
  await Promise.all([
    put(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"),
    ...Object.entries(logs).map(([name, text]) => put(join(evidence, `${name}.log`), text)),
  ]);
}
console.log(JSON.stringify({ evidence, ...receipt }));
if (failures.length)
  throw new AggregateError(failures, `Profile memory Electron fixture failed at ${stage}`);
