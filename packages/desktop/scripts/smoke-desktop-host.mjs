import { withdrawPendingRootMigration, verifyRootMigrations } from "./__fixtures__/project-root-migration.mjs";
import { gitRepositoryId } from "@cjhyy/code-shell-capability-coding/git";
import { execFileSync } from "node:child_process";
/* global window, performance */
import { verifyPairedHostTerminal } from "./paired-host-terminal.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockProviderServer } from "./mock-provider-server.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  assertOfflinePluginBootstrapHeld,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const isolated = await makeIsolatedElectronHome("codeshell-desktop-host-");
let application;
let provider;

async function observeHost(page) {
  await page.waitForFunction(() => typeof window.codeshell?.onDesktopHostStatus === "function");
  await page.evaluate(() => {
    window.hostSmokeStates = [];
    window.codeshell.onDesktopHostStatus((state) => window.hostSmokeStates.push(state));
  });
  await page.waitForFunction(() => window.hostSmokeStates.at(-1) === "ready");
}

const readCatalog = (page) =>
  page.evaluate(async () =>
    (await window.codeshell.links.listLocalProviders()).map(({ id }) => id),
  );

try {
  provider = await startMockProviderServer();
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  const projectRoot = join(isolated.home, "host-smoke-project");
  await mkdir(projectRoot, { recursive: true });
  const unregistered = join(isolated.home,"unregistered-project");
  await mkdir(unregistered);
  const mount = await realpath(projectRoot);
  const secondRoot = join(dirname(mount), "host-smoke-secondary");
  await mkdir(secondRoot);
  const cliProject = join(isolated.home,".claude","projects",mount.replace(/[^A-Za-z0-9]/g,"-"));
  await mkdir(cliProject,{recursive:true});
  await writeFile(join(cliProject,"host-cli-fixture.jsonl"),JSON.stringify({type:"user",cwd:mount,sessionId:"host-cli-fixture",message:{role:"user",content:"Host CLI transcript"}})+"\n");
  const git = (...args) => execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", ...args], {
    cwd: mount, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(isolated.home, "gitconfig") },
  }).trim();
  git("init", "--initial-branch=main", "--template=");
  await writeFile(join(mount, "host-file.txt"), "from-workspace");
  git("add", "host-file.txt");
  git("commit", "-m", "fixture");
  git("branch", "review-fixture");
  await mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "desktop", "projects.json"),
    JSON.stringify({
      version: 2,
      projects: [
        {
          id: "host-smoke-project",
          name: "Host smoke",
          primaryRootId: "root",
          roots: [
            { id: "root", name: "root", path: mount, canonicalIdentity: mount, addedAt: 1 },
            { id: "secondary", name: "secondary", path: secondRoot, canonicalIdentity: secondRoot, addedAt: 1 },
          ],
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1,
          revision: 1,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const directory = join(isolated.codeShellHome, "sessions", "index-visible");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      sessionId: "index-visible",
      origin: "desktop",
      parentSessionId: null,
      title: "Host indexed row",
      cwd: mount,
      project: { projectId: "host-smoke-project", mainRootId: "root" },
    }),
  );
  await writeFile(join(directory, "transcript.jsonl"), JSON.stringify({
    type: "message", turnNumber: 4, data: { role: "user", content: "Workbench transcript search receipt" },
  }) + "\n", { mode: 0o600 });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({
      credentials: [
        {
          id: "fixture-key",
          catalogId: "deepseek",
          apiKey: "synthetic",
          baseUrl: provider.baseUrl,
        },
      ],
      modelConnections: [
        {
          id: "fixture",
          catalogId: "deepseek",
          tag: "text",
          model: "deepseek-v4-flash",
          credentialId: "fixture-key",
        },
      ],
      defaults: { text: "fixture" },
    }),
    { mode: 0o600 },
  );
  const staleQuickChat = "qchat-startup-smoke";
  const staleDirectory = join(isolated.codeShellHome, "sessions", staleQuickChat);
  await mkdir(staleDirectory, { recursive: true });
  await writeFile(join(staleDirectory, "transcript.jsonl"), "previous process");
  const fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin: provider.origin,
  });
  const loginShell = join(isolated.home, "fixture-login-shell");
  if (process.platform !== "win32") {
    // A GUI-only CLI is absent at fork. The interactive PTY delegates to the system shell.
    const cliBin = join(isolated.home, "login-bin");
    await mkdir(cliBin);
    await writeFile(join(cliBin, "codeshell-path-probe"), "#!/bin/sh\necho GUI_PATH_RECEIVED\n", {
      mode: 0o700,
    });
    const script = [
      "#!/bin/sh",
      'if [ "$1" = "-lic" ] && [ "$2" = "env" ]; then',
      '  touch "$HOME/path-probe-start"',
      "  sleep 1",
      '  touch "$HOME/path-probe-done"',
      '  printf "PATH=%s:%s\\n" "$HOME/login-bin" "$PATH"',
      "  exit 0",
      "fi",
      "exec /bin/sh -i",
      "",
    ].join("\n");
    await writeFile(loginShell, script, { mode: 0o700 });
  }
  // The exact child handle restricts fault injection to this fixture's own Host.
  const bootstrap = join(isolated.home, "observe-host.cjs");
  await writeFile(
    bootstrap,
    `const { utilityProcess, ipcMain } = require("electron");
// Exercise the registered compatibility handlers with this fixture's real frames.
const register = ipcMain.handle;
const terminals = new Map();
ipcMain.handle = function (name, handler) {
  if (["pty:start", "pty:write", "pty:resize", "pty:kill"].includes(name)) terminals.set(name, handler);
  return register.call(this, name, handler);
};
globalThis.smokeTerminalFallback = (win, method, args) =>
  terminals.get(method)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args);

// Advertise only loopback to this isolated Desktop's real LAN gateway.
require("node:os").networkInterfaces = () => ({});
require("node:module").syncBuiltinESMExports();
const fork = utilityProcess.fork;
utilityProcess.fork = function (...args) {
  const child = fork.apply(this, args);
  if (args[2]?.serviceName === "CodeShell Desktop Host") {
    // Hold the first Host handshake until its real workbench paints and asks for a Quick Chat.
    if (!globalThis.smokeHostChild) {
      const emit = child.emit;
      let ready;
      child.emit = function (event, ...args) {
        if (event !== "message" || args[0]?.type !== "ready") return emit.call(this, event, ...args);
        ready = args;
        return true;
      };
      globalThis.releaseStartupHost = () => {
        child.emit = emit;
        if (ready) emit.call(child, "message", ...ready);
      };
    }
    globalThis.smokeHostChild = child;
  }
  return child;
};
`,
    { mode: 0o600 },
  );
  application = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: { ...fixture.env, ...(process.platform !== "win32" && { SHELL: loginShell }), CODESHELL_E2E_MOCK_KEYCHAIN: "1" },
    mainEntry: fixture.mainEntry,
    mainBootstrap: bootstrap,
    runtimeTimeoutMs: 90_000,
  });
  const first = await findCodeShellWindow(application);
  await first.waitForFunction(() => performance.getEntriesByName("first-contentful-paint", "paint").length > 0);
  const claimId = "new-workbench";
  assert.equal(await first.evaluate(async ([id, claim]) => {
    window.startupQuickChatClaim = window.codeshell.claimQuickChatSession(id, claim);
    return window.codeshell.isQuickChatClaimActive(id, claim);
  }, [staleQuickChat, claimId]), false, "A new claim must wait for startup cleanup");
  assert.equal(await readFile(join(staleDirectory, "transcript.jsonl"), "utf8"), "previous process");
  await application.evaluate(() => globalThis.releaseStartupHost());
  await first.evaluate(() => window.startupQuickChatClaim);
  assert.equal(await first.evaluate(([id, claim]) => window.codeshell.isQuickChatClaimActive(id, claim),
    [staleQuickChat, claimId]), true);
  await assert.rejects(stat(staleDirectory), { code: "ENOENT" });
  await fixture.assertWorker(application, { requireWorker: false });
  await observeHost(first);
  const catalog = await readCatalog(first);
  assert.ok(catalog.includes("github"), "Built-in Link provider missing");
  const secondOpened = application.waitForEvent("window", { timeout: 15_000 });
  await first.evaluate(() => window.codeshell.newWindow());
  const second = await secondOpened;
  await observeHost(second);
  const projectId = "host-smoke-project";
  await first.evaluate((id) => window.codeshell.switchProjectGitBranch(id, "review-fixture"), projectId);
  assert.equal(git("branch", "--show-current"), "review-fixture");
  await writeFile(join(mount, "stash-fixture.txt"), "synthetic pending change");
  await second.evaluate((id) => window.codeshell.stashAndSwitchProjectGitBranch(id, "main"), projectId);
  assert.equal(git("branch", "--show-current"), "main");
  assert.match(git("stash", "list"), /auto-stash before switching to main/);

  const undoPath = join(mount, "host-file.txt");
  const committed = await readFile(undoPath, "utf8");
  await writeFile(undoPath, "owned edit to revert");
  const undoResult = await second.evaluate((cwd) => window.codeshell.undoFiles(cwd, ["host-file.txt"]), mount);
  assert.deepEqual(undoResult, [{ path: "host-file.txt", ok: true, action: "restore" }]);
  assert.equal(await readFile(undoPath, "utf8"), committed);

  // A status poll must not refresh the index when the tracked file has a
  // new timestamp but identical contents. Another window can be mid-stash.
  await utimes(join(mount, "host-file.txt"), 1_000_000, 1_000_000);
  const indexBeforeRead = await readFile(join(mount, ".git", "index"));
  const sessionWorkspace = await second.evaluate(async (unrelated) => {
    const id = "index-visible";
    const [status, branches, profiles, worktrees] = await Promise.all([
      window.codeshell.getSessionGitStatus(id),
      window.codeshell.getSessionGitBranches(id),
      window.codeshell.listSessionProfiles(id),
      window.codeshell.listSessionWorktrees(id, unrelated),
    ]);
    return { status, branches, profiles, mainRoot: worktrees.mainRoot };
  }, unregistered);
  assert.deepEqual(await readFile(join(mount, ".git", "index")), indexBeforeRead);
  assert.equal(sessionWorkspace.mainRoot, mount, "Session binding determines the repository");
  assert.equal(sessionWorkspace.status.branch, "main");
  assert.equal(sessionWorkspace.branches.current, "main");
  assert(Array.isArray(sessionWorkspace.profiles));
  const version = {
    kind: "git-blob", commit: git("rev-parse", "HEAD"), blob: git("rev-parse", "HEAD:host-file.txt"),
    repoPath: "host-file.txt", worktreePath: mount, linkedWorktree: false,
    repositoryId: await gitRepositoryId(join(mount, ".git")),
  };
  const historical = await first.evaluate(async (ref) => Promise.all([
    window.codeshell.readSessionFileVersion("index-visible", "root", ref),
    window.codeshell.readProjectFileVersion("host-smoke-project", "root", ref),
  ]), version);
  for (const file of historical) {
    assert.equal(file.status, "ok");
    assert.equal(file.text, "from-workspace");
  }
  const search = await first.evaluate(() => window.codeshell.searchSessionContent("search receipt"));
  assert(search.matches.some((match) => match.sessionId === "index-visible" &&
    match.snippets.some((snippet) => snippet.turnNumber === 4 && snippet.text.includes("search receipt"))));
  const diff = await first.evaluate((root) =>
    window.codeshell.getSessionWorktreeDiff("index-visible", root), mount);
  assert.equal(diff.changedFiles, 0);
  await assert.rejects(first.evaluate((other) =>
    window.codeshell.getSessionWorktreeDiff("index-visible", other), unregistered),
    /Desktop Host request failed/);

  assert.deepEqual(await readCatalog(second), catalog);
  const skillSource = join(isolated.home, "owned-skill-directory");
  const skillBody = "---\nname: host-smoke-skill\ndescription: Owned directory import\n---\nOwned body.\n";
  await mkdir(skillSource);
  await writeFile(join(skillSource, "SKILL.md"), skillBody);
  const installed = await first.evaluate(
    (source) => window.codeshell.installLocalSkill(source, "user", null, "host-smoke-skill"),
    skillSource,
  );
  assert.equal(await readFile(installed.filePath, "utf8"), skillBody);
  assert.equal(
    await second.evaluate((path) => window.codeshell.readSkillBody(null, path), installed.filePath),
    skillBody,
  );
  await second.evaluate(() =>
    window.codeshell.uninstallSkill({ scope: "user", skillName: "host-smoke-skill" }),
  );
  await assert.rejects(readFile(installed.filePath), { code: "ENOENT" });
  assert.equal(
    await first.evaluate(async () =>
      (await window.codeshell.listSkills(null)).some((skill) => skill.name === "host-smoke-skill"),
    ),
    false,
  );
  await first.evaluate(() =>
    window.codeshell.updateSettings("user", { hostSmokeReceipt: "committed" }),
  );
  assert.equal(
    await second.evaluate(
      async () => (await window.codeshell.getSettings("user"))?.hostSmokeReceipt,
    ),
    "committed",
  );
  await assert.rejects(
    first.evaluate(() => window.codeshell.updateSettings("user", { panelAppBindings: {} })),
    /reviewed project binding/,
  );

  await first.evaluate((root) => window.codeshell.setTrust(root, "trusted"), mount);
  assert.equal(await second.evaluate((root) => window.codeshell.getTrust(root), mount), "trusted");
  await first.evaluate((root) => window.codeshell.setTrust(root, "untrusted"), mount);
  assert.equal(
    await second.evaluate((root) => window.codeshell.getTrust(root), mount),
    "untrusted",
  );

  await second.evaluate(() => {
    window.hostRegistryRename = new Promise((resolve) => {
      const off = window.codeshell.projectRegistry.onChanged((projects) => {
        const project = projects.find(
          (p) => p.id === "host-smoke-project" && p.name === "Renamed Host project",
        );
        if (project) {
          off();
          resolve(project.name);
        }
      });
    });
  });
  await first.evaluate(() =>
    window.codeshell.projectRegistry.rename("host-smoke-project", "Renamed Host project"),
  );
  assert.equal(await second.evaluate(() => window.hostRegistryRename), "Renamed Host project");
  await first.evaluate(() =>
    window.codeshell.projectRegistry.setPinned("host-smoke-project", true),
  );
  assert.equal(
    await second.evaluate(
      async () =>
        (await window.codeshell.projectRegistry.list()).find((p) => p.id === "host-smoke-project")
          ?.pinned,
    ),
    true,
  );

  const uploaded = join(isolated.home, "native-picked-host-document.txt");
  await writeFile(uploaded, "Host source upload");
  await application.evaluate(({ dialog }, file) => {
    const original = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = (...args) => {
      if (args.at(-1)?.title === "选择数据源文件") {
        dialog.showOpenDialog = original;
        return Promise.resolve({ canceled: false, filePaths: [file] });
      }
      return original(...args);
    };
  }, uploaded);
  await first.evaluate(async () => {
    const api = window.codeshell;
    await api.saveSourceCatalog({ id: "host-source", kind: "mcp-resource", label: "Host source" });
    await api.bindProjectSource("host-smoke-project", {
      sourceId: "host-source",
      scopes: ["resources"],
      readPolicy: "ask",
    });
  });
  assert.ok(
    await second.evaluate(async () =>
      (await window.codeshell.projectSourceAccess("host-smoke-project")).bindings.some(
        (row) => row.sourceId === "host-source",
      ),
    ),
  );
  const names = await first.evaluate(() =>
    window.codeshell.pickAndUploadProjectSources("host-smoke-project"),
  );
  assert.deepEqual(names, ["native-picked-host-document.txt"]);
  assert.equal(
    await readFile(join(mount, ".code-shell", "uploads", names[0]), "utf8"),
    "Host source upload",
  );
  await second.evaluate(async () => {
    const api = window.codeshell;
    await api.deleteProjectUpload("host-smoke-project", "native-picked-host-document.txt");
    await api.unbindProjectSource("host-smoke-project", "host-source");
    await api.deleteSourceCatalog("host-source");
    const [builtIn] = await api.getModelCatalog();
    const saved = await api.saveCatalogEntry({ ...builtIn, id: "host-smoke-model" });
    if (!saved.ok) throw new Error(saved.error);
  });
  assert.equal(
    await first.evaluate(
      async () => (await window.codeshell.getCatalogOrigins())["host-smoke-model"],
    ),
    "user",
  );
  assert.equal(
    await first.evaluate(
      async () => (await window.codeshell.deleteCatalogEntry("host-smoke-model")).removed,
    ),
    true,
  );

  await first.evaluate(() => window.codeshell.saveMemory({
    level:"user",scope:"user",name:"Host memory smoke",type:"reference",description:"fixture",content:"memory on the Host",
  }));
  const dream = await first.evaluate(() => window.codeshell.runDream("user"));
  assert.ok(dream.ran && dream.summary);
  assert.ok(provider.requests.some(({ body }) =>
    body.tools?.some((tool) => tool.function?.name === "MemorySave")));
  const terminalId = "term:host-smoke";
  const started = await first.evaluate(
    async ({ cwd, sessionId }) => {
      window.hostTerminalText = "";
      window.codeshell.onPtyData((msg) => {
        if (msg.sessionId === sessionId) window.hostTerminalText += msg.data;
      });
      return window.codeshell.ptyStart({ cwd, sessionId });
    },
    { cwd: mount, sessionId: terminalId },
  );
  assert.equal(started.ok, true, started.detail);
  const denied = await second.evaluate(
    ({ cwd, sessionId }) => window.codeshell.ptyStart({ cwd, sessionId }),
    { cwd: mount, sessionId: terminalId },
  );
  assert.equal(
    denied.ok,
    false,
    "A second window cannot attach to the first window's live terminal",
  );
  await second.evaluate((id) => window.codeshell.ptyKill(id), terminalId);
  await first.evaluate(
    (id) => window.codeshell.ptyWrite(id, "node -p \"['HOST_TERMINAL','READY'].join('_')\"\r"),
    terminalId,
  );
  await first.waitForFunction(() =>
    window.hostTerminalText.includes("HOST_TERMINAL_READY"),
  );
  if (process.platform !== "win32") {
    await first.evaluate((id) => window.codeshell.ptyWrite(id, "codeshell-path-probe\r"), terminalId);
    await first.waitForFunction(() => window.hostTerminalText.includes("GUI_PATH_RECEIVED"));
    const start = (await stat(join(isolated.home, "path-probe-start"))).mtimeMs;
    const done = (await stat(join(isolated.home, "path-probe-done"))).mtimeMs;
    const paint = await first.evaluate(() => {
      const entry = performance.getEntriesByName("first-paint", "paint")[0];
      return entry ? performance.timeOrigin + entry.startTime : null;
    });
    assert.ok(Number.isFinite(paint), "The workbench produced its first frame");
    console.log(`GUI startup with a delayed login shell: first workbench paint ${Math.round(paint - start)}ms after probe start, shell finished ${Math.round(done-start)}ms after start; Host PTY found the new CLI.`);
  }
  const ownerWindow = await application.browserWindow(first);
  const otherWindow = await application.browserWindow(second);
  const fallback = (window, method, ...args) => window.evaluate(
    (win, request) => globalThis.smokeTerminalFallback(win, request.method, request.args),
    { method, args },
  );
  try {
    assert.equal((await fallback(ownerWindow, "pty:start", { cwd: mount, sessionId: terminalId })).pid, started.pid);
    assert.equal((await fallback(otherWindow, "pty:start", { cwd: mount, sessionId: terminalId })).ok, false);
    await fallback(ownerWindow, "pty:resize", terminalId, 90, 28);
    await fallback(ownerWindow, "pty:write", terminalId, 'node -p "String.fromCodePoint(32456,31471,0x1f60a)"\r');
    await first.waitForFunction(() => window.hostTerminalText.includes("终端😊"));
  } finally {
    await ownerWindow.dispose();
    await otherWindow.dispose();
  }
  await verifyPairedHostTerminal(first, terminalId, started.pid);
  await assert.rejects(first.evaluate((root) => window.codeshell.ccRoom.readHistory(root,"../other",4),mount),/Invalid CLI history request/);
  await assert.rejects(first.evaluate((root) => window.codeshell.ccRoom.listSessions(root),unregistered),/authority was revoked/);
  await first.evaluate(() => window.codeshell.renameSession("index-visible","Renamed through Host"));
  // Arm a renderer timer before blocking Main. Both timestamps come from the
  // renderer so a response delivered by Main after the pause cannot pass.
  const secondHandle = await application.browserWindow(second);
  const measured = await secondHandle.evaluate(async (nativeWindow, mount) => {
    const contents = nativeWindow.webContents;
    await contents.executeJavaScript(`window.hostSmokeRead = new Promise((resolve, reject) =>
      setTimeout(async () => {
        try {
          const begin = Date.now();
          const ids = (await window.codeshell.links.listLocalProviders()).map(({ id }) => id);
          const page = await window.codeshell.listDiskSessions({limit:1,sessionId:"index-visible"});
          const api = window.codeshell;
          const [ccList,ccPage] = await Promise.all([api.ccRoom.listSessions(${JSON.stringify(mount)}),api.ccRoom.readHistory(${JSON.stringify(mount)},"host-cli-fixture",5)]);
          if (!ccList.sessions.some(s=>s.sessionId==="host-cli-fixture") || ccPage.messages[0]?.text !== "Host CLI transcript") throw new Error("Host CLI history disagrees with the fixture on disk");
          const business = await Promise.all([
            api.projectRegistry.list(), api.recents(), api.listSourceCatalog(), api.getModelCatalog(),
            api.listPluginMcpTrust(), api.getPluginDetail("uninstalled-business-test"), api.getSettings("user"),
            api.listSkills(null),api.listPlugins(null),api.listMergedMcpServers({},[]),api.getConfigurationSettings({noRepo:true}),
            api.reasoningControl("openai","gpt-5"),api.listPluginHooks([])
          ]);
          const [projects, recents, sources, models, trust, plugin, settings, skills, plugins, mcp, projectSettings, reasoning, hooks] = business;
          const root = projects.find(p => p.id === "host-smoke-project").roots[0];
          const [memories, memory, pending] = await Promise.all([
            api.listMemory("user","user"),api.readMemory("user","user","Host memory smoke"),api.listPendingMemory(),
          ]);
          const [titles,logs,runs,usage] = await Promise.all([
            api.listSessionTitles(),api.tailLog("desktop",2),api.listRuns({includeSessions:false}),api.getUsageSummary({scope:"store"}),
          ]);
          const entries = await api.readProjectDir("host-smoke-project", root.id);
          const entry = entries.find(row => row.name === "host-file.txt");
          const [file, hits, exists, git] = await Promise.all([
            api.readProjectFileContent("host-smoke-project", root.id, entry.path),
            api.searchProjectFiles("host-smoke-project", "host-file", root.id),
            api.projectFileExists("host-smoke-project", root.id, entry.path),
            api.getProjectGitStatus("host-smoke-project"),
          ]);
          resolve({ begin, end: Date.now(), ids, sessionIds:page.sessions.map(row=>row.id),
            activityViews: titles["index-visible"] === "Renamed through Host" && Array.isArray(logs) && Array.isArray(runs) && usage !== null,
            memoryViews: memories.some(row => row.name === "Host memory smoke") && memory?.content.trim() === "memory on the Host" && Array.isArray(pending),
            workspaceViews:file.text === "from-workspace" && exists && hits.some(row => row.rootId === root.id && row.name === entry.name) && Array.isArray(git.entries),
            configurationViews: [projects, recents, sources, models, trust, skills, plugins].every(Array.isArray)
              && Array.isArray(hooks) && reasoning !== undefined && mcp !== null && typeof mcp === "object" && (projectSettings === null || typeof projectSettings === "object")
              && models.length > 0 && plugin === null && (settings === null || typeof settings === "object") });
        } catch (error) { reject(error); }
      }, 250)); void 0`);
    const begin = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600);
    const end = Date.now();
    return { begin, end, read: await contents.executeJavaScript("window.hostSmokeRead") };
  }, mount);
  await secondHandle.dispose();
  assert.deepEqual(measured.read.ids, catalog);
  assert.equal(measured.read.activityViews,true,"Activity history answered during the Main pause");
  assert.equal(measured.read.memoryViews,true,"Memory reads finished while Main was paused");
  assert.equal(await first.evaluate(()=>window.codeshell.deleteMemory("user","user","Host memory smoke")),true);
  assert.equal(await second.evaluate(()=>window.codeshell.readMemory("user","user","Host memory smoke")),null);
  assert.equal(
    measured.read.workspaceViews,
    true,
    "Workspace files and Git answered during the Main pause",
  );
  assert.deepEqual(measured.read.sessionIds, ["index-visible"]);
  assert.equal(
    measured.read.configurationViews,
    true,
    "Configuration views must resolve on the workbench Host port",
  );
  // A correct metadata page could also come from JSON fallback. Verify that this
  // Electron utility's actual worker committed the row in its WAL database.
  const storage = join(isolated.codeShellHome, ".codeshell-state");
  const roots = await readdir(storage);
  assert.equal(roots.length, 1);
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(storage, roots[0], "current", "state.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(
      database.prepare("SELECT title FROM sessions WHERE id=?").get("index-visible")?.title,
      "Host indexed row",
    );
  } finally {
    database.close();
  }
  assert.ok(
    measured.begin <= measured.read.begin && measured.read.end < measured.end,
    `Catalog read must finish during Main stall: ${JSON.stringify(measured)}`,
  );

  await first.reload({ waitUntil: "domcontentloaded" });
  await observeHost(first);
  assert.deepEqual(await readCatalog(first), catalog);
  const reattached = await first.evaluate(
    async ({ cwd, sessionId }) => {
      window.hostTerminalText = "";
      window.codeshell.onPtyData((msg) => {
        if (msg.sessionId === sessionId) window.hostTerminalText += msg.data;
      });
      return window.codeshell.ptyStart({ cwd, sessionId });
    },
    { cwd: mount, sessionId: terminalId },
  );
  assert.equal(reattached.pid, started.pid);
  await first.waitForFunction(() => window.hostTerminalText.includes("HOST_TERMINAL_READY"));
  await first.evaluate((id) => window.codeshell.ptyKill(id), terminalId);
  const receipt = await withdrawPendingRootMigration({
    isolated, mount, projectId, first, observeHost, fixture, application,
  });
  // A full local fork exercises actual worker stdio without performing inference.
  await first.evaluate(() => {
    window.hostSmokeFork = window.codeshell.forkSession({
      sourceSessionId: "index-visible",
      targetSessionId: "host-worker-copy",
      mode: "full",
    });
    void window.hostSmokeFork.catch(() => {});
  });
  assert.equal((await first.evaluate(() => window.hostSmokeFork)).sessionId, "host-worker-copy");
  assert.deepEqual((await first.evaluate(() => window.codeshell.configure({}))).result, {
    ok: true,
  });
  await verifyRootMigrations({ first, second, isolated, mount, secondRoot, projectId });
  const lifetimePty = await first.evaluate(async (cwd) => {
    window.hostTerminalLost = false;
    window.codeshell.onPtyExit((event) => {
      if (event.sessionId === "term:host-lifetime") window.hostTerminalLost = true;
    });
    return window.codeshell.ptyStart({ cwd, sessionId: "term:host-lifetime" });
  }, mount);
  assert.ok(lifetimePty.ok, lifetimePty.detail);
  const oldPid = await application.evaluate(() => {
    const child = globalThis.smokeHostChild;
    const pid = child?.pid;
    if (!pid || !child.kill()) throw new Error("Failed to stop the owned Desktop Host");
    return pid;
  });
  assert.equal(receipt.spawned[0].ppid, oldPid);
  assert.notEqual(oldPid, receipt.mainPid);
  for (const [pid, label] of [
    [receipt.spawned[0].pid, "stdio worker"],
    [lifetimePty.pid, "terminal shell"],
  ]) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.throws(
      () => process.kill(pid, 0),
      { code: "ESRCH" },
      "Original " + label + " must exit when its Host disappears",
    );
  }
  for (const page of [first, second]) {
    await page.waitForFunction(
      () =>
        window.hostSmokeStates.includes("reconnecting") &&
        window.hostSmokeStates.at(-1) === "ready",
    );
    assert.deepEqual(await readCatalog(page), catalog);
  }
  await first.waitForFunction(() => window.hostTerminalLost);
  const nextPid = await application.evaluate(() => globalThis.smokeHostChild.pid);
  assert.ok(nextPid && nextPid !== oldPid, "Expected a fresh Host process");

  await second.evaluate((id) => window.codeshell.projectRegistry.remove(id), projectId);
  assert.equal(await first.evaluate(async (id) =>
    (await window.codeshell.projectRegistry.list()).some(project => project.id === id), projectId), false);
  // Destroying all fixture windows bypasses interactive save prompts. Exercise
  // the application's real last-window and activate listeners.
  await application.evaluate(async ({ app, BrowserWindow }) => {
    const closed = new Promise((resolve) => app.once("window-all-closed", resolve));
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    await closed;
  });
  assert.equal(await application.evaluate(() => globalThis.smokeHostChild.pid), nextPid);
  const reopened = application.waitForEvent("window", { timeout: 15_000 });
  await application.evaluate(({ app }) => {
    app.emit("activate");
  });
  const restored = await reopened;
  await observeHost(restored);
  assert.deepEqual(await readCatalog(restored), catalog);
  assert.equal(await application.evaluate(() => globalThis.smokeHostChild.pid), nextPid);
  await assertOfflinePluginBootstrapHeld(isolated.codeShellHome);
  console.log(
    `Desktop Host passed: two workbenches, reload, process recovery and reopen. Catalog reply ${measured.read.end - measured.read.begin} ms during ${measured.end - measured.begin} ms Main stall.`,
  );
} finally {
  try {
    await application?.close();
  } finally {
    await provider?.close();
    await isolated.cleanup();
  }
}
