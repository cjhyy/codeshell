/* Real Desktop dock → native window → scoped Panel preload. No model/provider. */
/* global localStorage, window, document */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  expandSidebar,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedSessionCatalog,
  waitForSessionCatalogSelection,
} from "./electron-harness.mjs";

const usage =
  "node scripts/run-isolated-node-smoke.mjs --private-keyring packages/desktop/scripts/e2e-panel-app-window.mjs [--electron-executable /absolute/path/to/Electron]";
if (process.argv[2] === "--help") {
  console.log(
    `Build Desktop first, then run from the repository root:\n${usage}\nThe optional executable flag selects an already installed Electron binary.`,
  );
  process.exit(0);
}
assert.ok(process.env.CODE_SHELL_TEST_HOME, `Run through the isolated wrapper:\n${usage}`);
assert.ok(
  process.argv.length === 2 ||
    (process.argv.length === 4 && process.argv[2] === "--electron-executable"),
  "Expected optional --electron-executable <path>",
);
const executablePath = process.argv[3] ? resolve(process.argv[3]) : undefined;
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = await makeIsolatedElectronHome("codeshell-panel-window-");
const evidence = "/tmp/codeshell-panel-launcher-availability-qa/native";
const project = join(isolated.home, "window-project");
const secondaryProject = join(isolated.home, "catalog-secondary-project");
const appId = "window-fixture";
const fixtureAppIds = [appId, "window-fixture-two", "window-fixture-three", "window-fixture-four"];
const title = "Panel Window Fixture";
const install = join(isolated.codeShellHome, "panel-apps", appId);
const sessions = ["window-session-a", "window-session-b"];
const sessionTitles = ["Panel window source", "Another conversation"];
const report = { cases: [], errors: [], evidence };
let electron;
let win;
let processLog = "";
let failed;
const reservation = createServer((_request, response) => {
  report.errors.push("Unexpected fixture HTTP request");
  response.writeHead(404).end();
});

async function until(read, message) {
  const deadline = Date.now() + 15_000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw new Error(message);
}
async function dismissTrust(page) {
  const button = page.getByRole("button", { name: /^(仅查看|View only)/ });
  if (
    await button.waitFor({ state: "visible", timeout: 2000 }).then(
      () => true,
      () => false,
    )
  )
    await button.click();
}
async function openLauncher() {
  const plus = win.locator('[data-panel-action="new-tab"]');
  if (!(await plus.isVisible())) await win.locator('[data-panel-action="toggle"]').click();
  const launcher = win.locator('[data-panel-launcher]:not([aria-hidden="true"])');
  if (!(await launcher.isVisible())) await plus.click();
  await launcher.waitFor();
  return launcher;
}
async function panelWindows() {
  return electron.evaluate(({ BrowserWindow }, expectedTitle) => {
    return BrowserWindow.getAllWindows()
      .filter((item) => !item.isDestroyed() && item.getTitle() === expectedTitle)
      .map((item) => ({
        id: item.id,
        focused: item.isFocused(),
        views: item.contentView.children
          .filter((view) => view.webContents)
          .map((view) => ({ id: view.webContents.id, url: view.webContents.getURL() })),
      }));
  }, title);
}
async function popupContents() {
  return until(async () => {
    const windows = await panelWindows();
    const loaded = windows[0]?.views.find((view) => view.url.startsWith("cspanel://"));
    return windows.length === 1 && loaded ? { windowId: windows[0].id, guestId: loaded.id } : null;
  }, "Exactly one native Panel window must load its scoped guest");
}
async function executePopup(popup, code) {
  return electron.evaluate(
    ({ webContents }, { id, code }) => {
      const guest = webContents.fromId(id);
      if (!guest || guest.isDestroyed()) throw new Error("Panel window guest disappeared");
      return guest.executeJavaScript(code);
    },
    { id: popup.guestId, code },
  );
}
async function executeSource(view, code) {
  return view.evaluate((node, expression) => node.executeJavaScript(expression), code);
}
async function expectNoPopup(label) {
  await until(async () => (await panelWindows()).length === 0, label);
  report.cases.push(label);
}
async function closePopup(popup) {
  await electron.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(),
    popup.windowId,
  );
  await expectNoPopup("Closing the native window releases it");
  // Electron closes WebContents asynchronously even after BrowserWindow is
  // gone; require actual guest destruction before continuing the lifecycle.
  await until(
    () => electron.evaluate(({ webContents }, id) => !webContents.fromId(id), popup.guestId),
    "WebContentsView guest must be destroyed when its native window closes",
  );
}
async function seedFixture() {
  await Promise.all([
    mkdir(join(install, ".codeshell-panel"), { recursive: true }),
    mkdir(join(install, "app"), { recursive: true }),
    mkdir(join(project, ".code-shell"), { recursive: true }),
    mkdir(join(secondaryProject, ".code-shell"), { recursive: true }),
    mkdir(join(isolated.codeShellHome, "desktop"), { recursive: true }),
    mkdir(evidence, { recursive: true }),
  ]);
  const manifest = {
    schemaVersion: 2,
    id: appId,
    version: "1.0.0",
    title: { default: title },
    entry: "app/index.html",
    icon: "panel",
    singleton: true,
    placement: "right-dock",
    permissions: ["context.session", "context.workspace", "storage"],
    agent: {
      tools: [
        {
          name: "context_probe",
          description: "Read this fixture instance and its scoped context.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          readOnly: true,
        },
      ],
    },
  };
  const installedAt = new Date().toISOString();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui;margin:0;padding:28px;color:#202124;background:#fafafa}body.dark{color:#eee;background:#171717}main{max-width:720px;margin:auto}h1{font-size:22px}p{color:#777;line-height:1.6}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid #8885;border-radius:12px}button{font:inherit;padding:10px 16px;border:1px solid #8885;border-radius:8px;background:transparent;color:inherit}</style>
</head><body><main><h1>${title}</h1><p>This Panel uses the context of its source conversation.</p><pre id="context">Loading scoped context…</pre><button id="increment">Local counter: 0</button></main><script src="./app.js"></script></body></html>`;
  const script = `window.fixture={marker:Math.random().toString(36).slice(2),counter:0,toolCalls:0,contexts:[]};
async function refresh(){const value=await window.codeshellPanel.getContext();window.fixture.contexts.push(value);document.body.classList.toggle('dark',value.theme==='dark');document.getElementById('context').textContent=JSON.stringify({appId:value.appId,sessionId:value.sessionId,cwd:value.cwd,visible:value.visible},null,2);window.fixture.ready=true;}
window.codeshellPanel.on('context.changed',refresh);
window.codeshellPanel.registerTool('context_probe',async()=>{window.fixture.toolCalls++;return {marker:window.fixture.marker,calls:window.fixture.toolCalls,context:await window.codeshellPanel.getContext()}});
document.getElementById('increment').onclick=()=>{window.fixture.counter++;document.getElementById('increment').textContent='Local counter: '+window.fixture.counter};
refresh().catch(error=>{window.fixture.error=String(error)});
`;
  for (const [index, id] of fixtureAppIds.entries()) {
    const folder = join(isolated.codeShellHome, "panel-apps", id);
    await mkdir(join(folder, ".codeshell-panel"), { recursive: true });
    await mkdir(join(folder, "app"), { recursive: true });
    await Promise.all([
      writeFile(
        join(folder, ".codeshell-panel/panel.json"),
        JSON.stringify({
          ...manifest,
          id,
          title: { default: index === 0 ? title : `${title} ${index + 1}` },
        }),
      ),
      writeFile(join(folder, "app/index.html"), html),
      writeFile(join(folder, "app/app.js"), script),
      writeFile(
        join(folder, ".cs-panel-app-meta.json"),
        JSON.stringify({
          schemaVersion: 1,
          id,
          version: "1.0.0",
          source: folder,
          installedAt,
        }),
      ),
    ]);
  }
  await Promise.all([
    writeFile(
      join(isolated.codeShellHome, "panel-apps/installed.json"),
      JSON.stringify({
        version: 1,
        apps: fixtureAppIds.map((id) => ({
          id,
          version: "1.0.0",
          source: join(isolated.codeShellHome, "panel-apps", id),
          installedAt,
          lastUpdated: installedAt,
        })),
      }),
    ),
    writeFile(
      join(project, ".code-shell/settings.json"),
      JSON.stringify({ panelAppBindings: fixtureAppIds }),
    ),
    writeFile(
      join(secondaryProject, ".code-shell/settings.json"),
      JSON.stringify({ panelAppBindings: [] }),
    ),
    writeFile(
      join(isolated.codeShellHome, "desktop/recents.json"),
      JSON.stringify([{ path: project, name: "window-project", lastOpenedAt: Date.now() }]),
    ),
  ]);
}

try {
  await seedFixture();
  await new Promise((done, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", done);
  });
  const origin = `http://127.0.0.1:${reservation.address().port}`;
  const confined = await prepareConfinedElectronFixture({ appDir, isolated, origin });
  // Installed before production Main creates any Electron Session. Node/Main
  // HTTP uses the maintained guard; Chromium may only read owned local assets.
  const beforeMain = `import {app as fixtureApp,ipcMain as fixtureIpc} from 'electron';
import {appendFileSync as fixtureAppend} from 'node:fs';
import {fileURLToPath as fixtureFilePath} from 'node:url';
const fixtureAssets=${JSON.stringify(join(appDir, "out/renderer/"))};
const fixtureReceipt=${JSON.stringify(join(isolated.home, "chromium-network.jsonl"))};
globalThis.__panelWindowFixture={hosts:new Set(),requests:[],sessions:0,catalog:[],holdBind:false,heldBindings:0,bindReleases:[]};
const fixtureHandle=fixtureIpc.handle.bind(fixtureIpc);
fixtureIpc.handle=(channel,handler)=>fixtureHandle(channel,channel==='panel-apps:listForProjects'?async function(event,...args){
 const paths=args[0];const failed=Array.isArray(paths)&&paths.length>1;
 const request={paths,failed};globalThis.__panelWindowFixture.catalog.push(request);
 if(failed)throw new Error('Synthetic batch catalog unavailable');
 try{const result=await handler.call(this,event,...args);request.success=true;request.response={descriptors:result.descriptors.map(({id,appId,hostId,projectPaths})=>({id,appId,hostId,projectPaths})),boundProjectPathsByAppId:result.boundProjectPathsByAppId};return result}catch(error){request.error=String(error);throw error}
}:channel==='panel-apps:bind'?async function(event,...args){
 const result=await handler.call(this,event,...args);
 if(globalThis.__panelWindowFixture.holdBind){globalThis.__panelWindowFixture.heldBindings++;await new Promise(resolve=>globalThis.__panelWindowFixture.bindReleases.push(resolve))}
 return result;
}:handler);
fixtureApp.commandLine.appendSwitch('disable-background-networking');
fixtureApp.commandLine.appendSwitch('disable-component-update');
fixtureApp.commandLine.appendSwitch('no-pings');
fixtureApp.on('session-created',ses=>{
 globalThis.__panelWindowFixture.sessions++;
 ses.webRequest.onBeforeRequest((details,done)=>{
  const url=new URL(details.url);
  const allowed=url.protocol==='about:'||url.protocol==='data:'||url.protocol==='cstheme:'||(url.protocol==='cspanel:'&&globalThis.__panelWindowFixture.hosts.has(url.hostname))||(url.protocol==='file:'&&fixtureFilePath(url).startsWith(fixtureAssets));
  if(!allowed){const item={url:details.url,resourceType:details.resourceType};globalThis.__panelWindowFixture.requests.push(item);fixtureAppend(fixtureReceipt,JSON.stringify(item)+'\\n',{mode:0o600})}
  done({cancel:!allowed});
 });
});
`;
  await writeFile(confined.mainEntry, beforeMain + (await readFile(confined.mainEntry, "utf8")), {
    mode: 0o600,
  });
  electron = await launchCodeShellElectron(
    {
      appDir,
      home: isolated.home,
      userDataDir: isolated.userDataDir,
      mainEntry: confined.mainEntry,
      env: confined.env,
    },
    executablePath
      ? {
          launch: async (options) =>
            (await import("playwright"))._electron.launch({ ...options, executablePath }),
        }
      : undefined,
  );
  electron.process().stderr?.on("data", (chunk) => {
    processLog = (processLog + chunk).slice(-30000);
  });
  win = await findCodeShellWindow(electron);
  if (new URL(win.url()).searchParams.has("popout")) {
    win = await until(
      () =>
        electron
          .windows()
          .find(
            (page) =>
              !new URL(page.url()).searchParams.has("popout") &&
              page.url().includes("renderer/index.html"),
          ),
      "Main Desktop window must load",
    );
  }
  win.setDefaultTimeout(15_000);
  win.on("pageerror", (error) => report.errors.push(error.message));
  await win.setViewportSize({ width: 1200, height: 780 });
  await dismissTrust(win);
  await win.evaluate((cwd) => window.codeshell.setTrust(cwd, "trusted"), project);
  const recent = win.getByText("window-project", { exact: true });
  if (await recent.count()) await recent.first().click();
  await dismissTrust(win);
  const registered = await until(
    () =>
      win.evaluate(
        async (cwd) =>
          (await window.codeshell.projectRegistry.list()).find((item) =>
            item.roots.some((root) => root.path === cwd),
          ),
        project,
      ),
    "Fixture project must be registered through Desktop",
  );
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, secondaryProject);
  const secondary = await win.evaluate(() => window.codeshell.projectRegistry.createFromPicker());
  assert.ok(
    secondary?.id && secondary.id !== registered.id,
    "A second real Main project registration exercises batch fallback",
  );
  for (let index = 0; index < sessions.length; index++) {
    const sessionId = sessions[index],
      folder = join(isolated.codeShellHome, "sessions", sessionId),
      now = Date.now();
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "state.json"),
      JSON.stringify({
        sessionId,
        title: sessionTitles[index],
        cwd: project,
        project: { projectId: registered.id, mainRootId: registered.primaryRootId },
        origin: "desktop",
        kind: "work",
        parentSessionId: null,
        status: "completed",
        startedAt: now,
      }),
    );
    const rows = [
      { type: "session_meta", data: { sessionId } },
      {
        type: "message",
        data: {
          role: "user",
          content: sessionTitles[index],
          clientMessageId: sessionId + "-input",
        },
      },
    ].map((event, row) => ({
      id: sessionId + "-" + row,
      timestamp: now + row,
      turnNumber: 1,
      ...event,
    }));
    await writeFile(join(folder, "transcript.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  }
  await seedSessionCatalog(win, {
    [registered.id]: {
      sessions: sessions.map((id, index) => ({
        id,
        engineSessionId: id,
        title: sessionTitles[index],
        createdAt: Date.now() - index,
        updatedAt: Date.now() - index,
      })),
      activeSessionId: null,
    },
  });
  await win.reload();
  await dismissTrust(win);
  await expandSidebar(win);
  await win.getByRole("button", { name: sessionTitles[0], exact: true }).click();
  await dismissTrust(win);
  // Real Main operations migrate these isolated legacy installs into retained,
  // project-pinned packages. No renderer catalog or project registry is mocked.
  for (const id of fixtureAppIds) {
    await win.evaluate(
      async ({ cwd, id }) => {
        const binding = (await window.codeshell.getPanelAppBindings(cwd)).find(
          (item) => item.appId === id,
        );
        if (!binding) throw new Error(`Missing installed fixture binding ${id}`);
        await window.codeshell.setPanelAppProjectBinding(cwd, id, true, binding.revision);
      },
      { cwd: project, id },
    );
  }
  const projectSettings = JSON.parse(
    await readFile(join(project, ".code-shell/settings.json"), "utf8"),
  );
  assert.deepEqual([...projectSettings.panelAppBindings].sort(), [...fixtureAppIds].sort());
  assert.deepEqual(Object.keys(projectSettings.panelAppPins).sort(), [...fixtureAppIds].sort());
  for (const pin of Object.values(projectSettings.panelAppPins)) {
    assert.equal(pin.version, "1.0.0");
    assert.match(pin.packageDigest, /^[a-f0-9]{64}$/);
  }
  report.availability = {
    projectId: registered.id,
    bindings: fixtureAppIds,
    pins: projectSettings.panelAppPins,
  };
  const descriptor = await until(
    () =>
      win.evaluate(
        async (cwd) =>
          (await window.codeshell.listPanelApps(cwd, "en")).find(
            (item) => item.appId === "window-fixture",
          ),
        project,
      ),
    "Bound fixture descriptor must be listed",
  );
  const prepared = await win.evaluate(({ id, cwd }) => window.codeshell.preparePanelApp(id, cwd), {
    id: descriptor.id,
    cwd: project,
  });
  await electron.evaluate(
    (_electron, host) => globalThis.__panelWindowFixture.hosts.add(host),
    new URL(prepared.src).hostname,
  );
  const launcher = await openLauncher();
  const descriptors = await win.evaluate(
    (cwd) => window.codeshell.listPanelApps(cwd, "en"),
    project,
  );
  assert.deepEqual(descriptors.map((item) => item.appId).sort(), [...fixtureAppIds].sort());
  await until(
    async () => (await launcher.locator("[data-panel-launcher-window-kind]").count()) === 4,
    "All four project-pinned apps must appear in the actual launcher",
  );
  await until(
    () => launcher.locator("[data-panel-launcher-refresh]").isEnabled(),
    "Launcher catalog must settle after the overlapping authorized reads",
  );
  report.availability.cards = await launcher.locator("[data-panel-launcher-window-kind]").count();
  assert.equal(
    report.availability.cards,
    4,
    "Settled catalog retains all four project-pinned apps",
  );
  const catalogRequests = await electron.evaluate(() => globalThis.__panelWindowFixture.catalog);
  assert.ok(
    catalogRequests.some((item) => item.failed && item.paths.length > 1),
    "The actual App encounters a failed batch request",
  );
  for (const cwd of [project, secondaryProject])
    assert.ok(
      catalogRequests.some(
        (item) => item.success && item.paths.length === 1 && item.paths[0] === cwd,
      ),
      "Per-project fallback retains real Main authorization for " + cwd,
    );
  report.availability.catalogRequests = catalogRequests;
  report.cases.push(
    "A failed real batch catalog recovers four bound cards through authorized per-project fallback",
  );
  await launcher.locator('[data-panel-launcher-group="panels"]').scrollIntoViewIfNeeded();
  await win.evaluate(() => document.activeElement?.blur());
  await win.screenshot({
    path: join(evidence, "launcher-four-bound-panels.png"),
    animations: "disabled",
  });
  assert.equal((await panelWindows()).length, 0);
  assert.equal(
    await win.locator(`webview[src="${prepared.src}"]`).count(),
    0,
    "Listing cards does not mount a source guest",
  );
  // Hold only the real binding acknowledgement, after Main has authorized the
  // source; opening still must wait for the Host to report ready to PanelArea.
  await electron.evaluate(() => {
    globalThis.__panelWindowFixture.holdBind = true;
  });
  await launcher.locator(`[data-panel-launcher-window-kind="${descriptor.id}"]`).click();
  const view = win.locator(`webview[src="${prepared.src}"]`);
  await view.waitFor();
  await until(
    async () => await executeSource(view, "window.fixture?.ready"),
    "Source guest must bind its scoped preload",
  );
  await until(
    () => electron.evaluate(() => globalThis.__panelWindowFixture.heldBindings > 0),
    "Source binding acknowledgement is deferred by the fixture",
  );
  assert.equal(
    (await panelWindows()).length,
    0,
    "One-click open waits for binding acknowledgement",
  );
  assert.equal(await win.locator('[data-panel-action="popout"]').isDisabled(), true);
  await electron.evaluate(() => {
    const fixture = globalThis.__panelWindowFixture;
    fixture.holdBind = false;
    for (const release of fixture.bindReleases.splice(0)) release();
  });
  report.cases.push("Deferred real source binding cannot open a native window prematurely");
  const sourceId = await view.evaluate((node) => node.getWebContentsId());
  const sourceState = await executeSource(
    view,
    "(async()=>({...window.fixture,context:await window.codeshellPanel.getContext()}))()",
  );
  assert.equal(sourceState.context.sessionId, sessions[0]);
  assert.equal(sourceState.context.cwd, project);
  await executeSource(view, "window.fixture.counter=17");
  await executeSource(
    view,
    'window.codeshellPanel.call("storage.set",{key:"fixture-key",value:{saved:"Shared project data"}})',
  );
  const target = await win.evaluate((appDescriptorId) => {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key.startsWith("codeshell.panelState.")) continue;
      const state = JSON.parse(localStorage.getItem(key));
      if (
        state.open &&
        state.tabs.some((tab) => tab.id === state.activeId && tab.kind === appDescriptorId)
      )
        return {
          appDescriptorId,
          tabId: state.activeId,
          bucket: key.slice("codeshell.panelState.".length),
        };
    }
  }, descriptor.id);
  assert.ok(target?.tabId && target?.bucket, "Real dock persisted target must identify its source");
  let popup = await popupContents();
  await until(
    () => executePopup(popup, "window.fixture?.ready"),
    "Native guest must load the actual Panel preload",
  );
  const nativeState = await executePopup(
    popup,
    "(async()=>({...window.fixture,context:await window.codeshellPanel.getContext(),hasDesktopBridge:typeof window.codeshell!=='undefined',hasNode:typeof process!=='undefined'||typeof require!=='undefined'}))()",
  );
  assert.notEqual(popup.guestId, sourceId, "New view has a separate guest");
  assert.notEqual(
    nativeState.marker,
    sourceState.marker,
    "Separate guest has its own transient memory",
  );
  assert.equal(
    nativeState.hasDesktopBridge,
    false,
    "Native Panel never loads the Desktop bridge/App shell",
  );
  assert.equal(nativeState.hasNode, false, "Native Panel remains sandboxed");
  for (const field of ["appId", "sessionId", "cwd", "trusted", "theme", "locale", "apiVersion"])
    assert.deepEqual(
      nativeState.context[field],
      sourceState.context[field],
      `Source-derived ${field} survives opening`,
    );
  assert.deepEqual(nativeState.context.projectScope, sourceState.context.projectScope);
  assert.deepEqual(
    await executePopup(popup, 'window.codeshellPanel.call("storage.get",{key:"fixture-key"})'),
    { saved: "Shared project data" },
    "Separate view reads the source project's saved data",
  );
  assert.equal(
    await executeSource(view, "window.fixture.counter"),
    17,
    "Original guest memory stays mounted",
  );
  assert.equal(await view.evaluate((node) => node.getWebContentsId()), sourceId);
  report.cases.push("Four real project bindings and pins expose four launcher window actions");
  report.cases.push(
    "One launcher window action binds a real source and opens its sandboxed native Panel window",
  );
  await electron.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows()
      .find((item) => item.webContents.getURL() === url)
      ?.focus();
  }, win.url());
  await until(
    () =>
      electron.evaluate(
        ({ BrowserWindow }, url) =>
          BrowserWindow.getAllWindows().some(
            (item) => item.webContents.getURL() === url && item.isFocused(),
          ),
        win.url(),
      ),
    "The main window must own focus before testing repeated popup focus",
  );
  const repeatedLauncher = await openLauncher();
  await repeatedLauncher.locator(`[data-panel-launcher-window-kind="${descriptor.id}"]`).click();
  assert.deepEqual(
    await popupContents(),
    popup,
    "Repeated launcher action reuses the native window and guest",
  );
  await until(
    async () => (await panelWindows())[0]?.focused,
    "Repeated launcher action focuses its native window",
  );
  assert.equal(
    await view.evaluate((node) => node.getWebContentsId()),
    sourceId,
    "Repeated launcher action retains the owning source guest",
  );
  assert.equal(await executeSource(view, "window.fixture.counter"), 17);
  report.cases.push(
    "Repeated launcher window action focuses the same window and retains one source owner",
  );
  await win.evaluate(
    (input) =>
      Promise.all([
        window.codeshell.openPanelAppWindow(input),
        window.codeshell.openPanelAppWindow(input),
      ]),
    target,
  );
  assert.deepEqual(await popupContents(), popup, "Repeated open focuses the existing guest/window");
  const invoked = await win.evaluate(
    (input) =>
      window.codeshell.invokePanelAppAgentTool({
        ...input,
        toolName: "context_probe",
        arguments: {},
      }),
    { appDescriptorId: descriptor.id, bucket: target.bucket },
  );
  assert.equal(
    invoked.marker,
    sourceState.marker,
    "Agent tools continue routing to the owning source guest",
  );
  assert.equal(invoked.calls, 1);
  assert.equal(
    await executePopup(popup, "window.fixture.toolCalls"),
    0,
    "Popout does not duplicate source tool execution",
  );
  report.cases.push(
    "Repeated open and one source-owned Agent tool invocation do not duplicate work",
  );
  for (const field of ["appDescriptorId", "tabId", "bucket"]) {
    const rejected = await win.evaluate(
      async (input) => {
        try {
          await window.codeshell.openPanelAppWindow(input);
          return false;
        } catch {
          return true;
        }
      },
      { ...target, [field]: "forged-window-target" },
    );
    assert.equal(rejected, true, `Forged ${field} cannot select another context`);
  }
  assert.equal((await panelWindows()).length, 1);
  report.cases.push("Forged descriptor/tab/bucket are rejected without creating windows");
  await win.screenshot({ path: join(evidence, "source-and-panel.png"), animations: "disabled" });
  const png = await until(
    () =>
      electron.evaluate(async ({ webContents }, id) => {
        const image = await webContents.fromId(id).capturePage();
        return image.isEmpty() ? null : image.toPNG().toString("base64");
      }, popup.guestId),
    "The native Panel WebContentsView must paint a nonempty frame",
  );
  await writeFile(join(evidence, "native-panel.png"), Buffer.from(png, "base64"));
  report.opened = {
    sourceGuestId: sourceId,
    nativeGuestId: popup.guestId,
    nativeWindowId: popup.windowId,
    sessionId: nativeState.context.sessionId,
    cwd: nativeState.context.cwd,
    projectScope: nativeState.context.projectScope,
    sourceCounter: 17,
    savedDataShared: true,
  };
  await expandSidebar(win);
  await win.getByRole("button", { name: sessionTitles[1], exact: true }).click();
  await waitForSessionCatalogSelection(win, registered.id, sessions[1]);
  await until(
    async () => (await executeSource(view, "window.codeshellPanel.getContext()")).visible === false,
    "Original source becomes hidden when main changes conversations",
  );
  await until(
    async () =>
      (await executePopup(popup, "window.codeshellPanel.getContext()")).sessionId === sessions[0],
    "Popout retains its source Session after main switches conversations",
  );
  assert.equal((await executePopup(popup, "window.codeshellPanel.getContext()")).cwd, project);
  await win.getByRole("button", { name: sessionTitles[0], exact: true }).click();
  await view.waitFor();
  assert.equal(await view.evaluate((node) => node.getWebContentsId()), sourceId);
  report.cases.push("Main conversation switch preserves the original Panel identity");
  await closePopup(popup);
  assert.equal(await executeSource(view, "window.fixture.counter"), 17);
  await win.locator('[data-panel-action="popout"]').click();
  popup = await popupContents();
  await until(
    () => executePopup(popup, "window.fixture?.ready"),
    "Reopened native Panel must bind",
  );
  await closePopup(popup);
  // One controlled load failure, injected before a new view is constructed.
  await electron.evaluate(({ app }) => {
    const wrapped = [];
    const listener = (_event, wc) => {
      const original = wc.loadURL;
      wc.loadURL = function (url, ...args) {
        if (String(url).startsWith("cspanel://")) {
          app.removeListener("web-contents-created", listener);
          for (const [contents, method] of wrapped)
            if (!contents.isDestroyed()) contents.loadURL = method;
          throw new Error("Synthetic Panel window load failure");
        }
        return original.call(this, url, ...args);
      };
      wrapped.push([wc, original]);
    };
    app.on("web-contents-created", listener);
  });
  const loadFailure = await win.evaluate(async (input) => {
    try {
      await window.codeshell.openPanelAppWindow(input);
      return "";
    } catch (error) {
      return String(error);
    }
  }, target);
  assert.match(loadFailure, /Synthetic Panel window load failure/);
  await expectNoPopup("Failed native load rolls back its window and guest");
  await win.locator('[data-panel-action="popout"]').click();
  popup = await popupContents();
  await until(
    () => executePopup(popup, "window.fixture?.ready"),
    "Header retry after load failure succeeds",
  );
  const tab = win.getByRole("tab", { name: title, exact: true });
  await tab.focus();
  await tab.press("Delete");
  await expectNoPopup("Closing the source tab releases its native window");
  await until(
    () => electron.evaluate(({ webContents }, id) => !webContents.fromId(id), popup.guestId),
    "Source cleanup must destroy the native guest",
  );
  await (await openLauncher())
    .locator(`[data-panel-launcher-window-kind="${descriptor.id}"]`)
    .click();
  await until(() => executeSource(view, "window.fixture?.ready"), "Reopened source guest binds");
  popup = await popupContents();
  const parentId = await electron.evaluate(
    ({ BrowserWindow }, url) =>
      BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === url).id,
    win.url(),
  );
  await win.evaluate(() => window.codeshell.newWindow());
  await until(
    () =>
      electron.evaluate(
        ({ BrowserWindow }, id) =>
          BrowserWindow.getAllWindows().some(
            (item) =>
              item.id !== id &&
              item.webContents.getURL().includes("renderer/index.html") &&
              !new URL(item.webContents.getURL()).searchParams.has("popout"),
          ),
        parentId,
      ),
    "A second main window keeps Electron alive for parent cleanup verification",
  );
  await electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), parentId);
  await expectNoPopup("Closing the owning main window releases its Panel window");
  await until(
    () => electron.evaluate(({ webContents }, id) => !webContents.fromId(id), popup.guestId),
    "Owner cleanup must destroy the native guest",
  );
  report.confinement = await confined.assertWorker(electron, { requireWorker: false });
  const network = await electron.evaluate(() => ({
    sessions: globalThis.__panelWindowFixture.sessions,
    requests: globalThis.__panelWindowFixture.requests,
  }));
  assert.ok(network.sessions >= 2, "Chromium guard covers renderer and Panel partition");
  assert.deepEqual(network.requests, [], "No nonlocal Chromium request was attempted");
  assert.deepEqual(report.errors, []);
  report.network = network;
  report.result = "pass";
} catch (error) {
  failed = error;
  report.result = "fail";
  report.failure = error.stack;
  if (electron)
    report.catalogFailureRequests = await electron
      .evaluate(() => globalThis.__panelWindowFixture?.catalog)
      .catch(() => null);
  if (win && !win.isClosed())
    report.rendererFailure = await win
      .evaluate(
        async (cwd) => ({
          catalog: await window.codeshell
            .listPanelAppsForProjects([cwd], "en")
            .catch((error) => ({ error: String(error) })),
          registry: await window.codeshell.projectRegistry.list(),
          alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
          cards: document.querySelectorAll("[data-panel-launcher-window-kind]").length,
          // Failure diagnostics only; pass assertions use the visible UI and
          // real Main APIs, never React implementation details.
          panelScopes: [...document.querySelectorAll('[data-theme-surface="panel"]')].map(
            (node) => {
              const key = Object.keys(node).find((key) => key.startsWith("__reactFiber$"));
              let fiber = key ? node[key] : null;
              for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
                const props = fiber.memoizedProps;
                if (props && typeof props.setTabs === "function" && "projectPath" in props)
                  return {
                    projectPath: props.projectPath,
                    cwd: props.cwd,
                    engineSessionId: props.engineSessionId,
                    bucket: props.bucket,
                  };
              }
              return null;
            },
          ),
        }),
        project,
      )
      .catch((error) => ({ error: String(error) }));
  if (win && !win.isClosed())
    await win.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
} finally {
  if (electron) await electron.close().catch(() => {});
  await new Promise((done) => reservation.close(done));
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(evidence, "process.log"), processLog);
  await isolated.cleanup();
}
console.log(
  JSON.stringify(
    {
      result: report.result,
      cases: report.cases,
      errors: report.errors,
      availability: report.availability && {
        bindings: report.availability.bindings.length,
        pins: Object.keys(report.availability.pins).length,
        cards: report.availability.cards,
      },
      failure: report.failure,
      evidence,
    },
    null,
    2,
  ),
);
if (failed) throw failed;
