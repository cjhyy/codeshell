/* Actual Main/ReviewService/preload/React. Only catalog:list is synthetic.
 * The original preparePrompt listener runs before its exact result is delayed.
 * Only bounded owned read-only agent metadata reaches its production listener.
 * Never starts agent turns, Engine/Worker/provider or OS operations.
 * Run through run-isolated-node-smoke.mjs; actual native execution is CI-only. */
/* global window, document */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
  waitForAsyncFunction,
  waitForSessionCatalogSelection,
} from "./electron-harness.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { createReviewOperationDiagnostics } from "./review-operation-diagnostics.mjs";
import { reviewDraftReadonlyRpcGuardSource } from "./review-draft-readonly-rpc-guard.mjs";

assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
assert.equal(process.argv.length, 4);
assert.equal(process.argv[2], "--evidence-dir");
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = await realpath(resolve(appDir, "../.."));
const outside = (parent, path) => {
  const part = relative(parent, path);
  return part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part);
};
const requested = resolve(process.argv[3]);
const evidence = join(await realpath(dirname(requested)), basename(requested));
const outerHome = await realpath(process.env.HOME);
assert.ok(outside(repo, evidence) && outside(outerHome, evidence));
await mkdir(evidence, { mode: 0o700 });
const diagnostics = createReviewOperationDiagnostics({ evidence, ownedRoots: [repo, evidence] });
diagnostics.phase("review-fixture-init");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeMessage = (error) => {
  try {
    return String(error?.message ?? error ?? "Unknown caught value").slice(0, 2048);
  } catch {
    return "Uninspectable fixture error";
  }
};
const put = async (file, value) => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
};
const operations = [],
  failures = [],
  observerFailures = [],
  rendererErrors = [];
const report = {
  fixture: "real-review-draft-operations",
  status: "failed",
  evidence,
  privateHomeRemoved: false,
  operations,
  failures,
  boundary: {
    actual:
      "Owned real Git, compiled Main ReviewService, preload, ReviewPanel, App bucket and ChatView input. No React internals or DOM fabrication.",
    controlled:
      "catalog:list returns an owned synthetic UI catalog. Two actual preparePrompt responses are held only after the production listener finishes; their result bytes are never replaced. Synthetic owned sidebar/disk Session metadata. Strict owned goalGet/backgroundWork/backgroundShells-list RPCs use the original production listener; no metadata replies are mocked. The production SessionManager may initialize mkdir/chmod/owned staging housekeeping inside this fixture HOME.",
    excluded:
      "No agent turns, configuration or goal writes, shell control, Worker, Engine, provider, credentials, network, native crypto or OS open. Not an OS egress sandbox. Three new operations/one Main are separate from the unchanged original eleven Review operations.",
  },
};
let isolated, app, win, fixture, captured, monitor, processClosed;
const sessions = [
  {
    id: "owned-review-draft-a",
    title: "Owned Review draft A",
    name: "Owned Review project A",
    staged: "OWNED_STAGED_A",
    unstaged: "OWNED_UNSTAGED_A",
  },
  {
    id: "owned-review-draft-b",
    title: "Owned Review draft B",
    name: "Owned Review project B",
    staged: "OWNED_STAGED_B",
    unstaged: "OWNED_UNSTAGED_B",
  },
];
const focus = "OWNED_REVIEW_FOCUS 权限与兼容性";
const prefixA = "OWNED_EXISTING_DRAFT_A 未发送";
const prefixB = "OWNED_EXISTING_DRAFT_B 未发送";
const bounded = async (promise, ms, label) => {
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
};
const git = (cwd, ...args) =>
  children.execFileSync(
    "git",
    ["-c", `core.hooksPath=${join(cwd, "absent-hooks")}`, "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", timeout: 5000 },
  );
const composer = () => win.locator('textarea[aria-autocomplete="list"]:visible');
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
async function openSession(session) {
  await expandSidebar(win);
  const project = win.getByRole("button", { name: session.name, exact: true }).first();
  if ((await project.getAttribute("aria-expanded")) === "false") await project.click();
  await win.getByRole("button", { name: session.title, exact: true }).click();
  await dismissTrust();
  await waitForSessionCatalogSelection(win, session.project.id, session.id);
  await composer().waitFor();
}
async function reviewPanel() {
  const toggle = win.locator('[data-panel-action="toggle"]');
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  const slot = win.locator('[data-panel-id="review"]');
  if (await slot.count())
    await win.locator(`[id="${await slot.getAttribute("aria-labelledby")}"]`).click();
  else {
    await win.locator('[data-panel-action="new-tab"]').click();
    await win.locator('[data-panel-menu-kind="review"]').click();
  }
  const panel = win.locator('[data-panel-id="review"][data-panel-active="true"]');
  await panel.waitFor();
  return panel;
}
async function chooseScope(panel, mode) {
  await panel.getByRole("button", { name: /^(选择审查范围|Choose review scope)$/ }).click();
  await win
    .getByRole("menuitem", {
      name: mode === "staged" ? /^(已暂存|Staged)$/ : /^(未暂存|Unstaged)$/,
    })
    .click();
}
async function reviewOptions(panel) {
  const toggle = panel.getByRole("button", { name: /^(准备 AI 代码审查|Prepare AI code review)$/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const field = panel.getByRole("textbox", {
    name: /^(审查关注点（可选）|Review focus \(optional\))$/,
  });
  await field.fill(focus);
  return panel.getByRole("button", { name: /^(添加审查草稿|Add review draft)$/ });
}
async function controls() {
  const model = win.locator("button[data-active-model]:visible");
  const permission = win.getByRole("button", {
    name: /^(当前对话权限：|Conversation permission:)/,
  });
  return {
    model: await model.getAttribute("data-active-model"),
    modelLabel: await model.getAttribute("aria-label"),
    permission: await permission.getAttribute("aria-label"),
  };
}
async function gate() {
  return app.evaluate(() => globalThis.__ownedReviewDraft.gate.snapshot());
}
async function waitGate(id, status) {
  await waitForAsyncFunction(
    app,
    ({ id, status }) =>
      globalThis.__ownedReviewDraft.gate.snapshot().calls[id - 1]?.status === status,
    { id, status },
    { timeout: 5000, polling: 50 },
  );
  return (await gate()).calls[id - 1];
}
async function draftEquals(value) {
  await win.waitForFunction(
    (expected) => {
      const fields = [...document.querySelectorAll('textarea[aria-autocomplete="list"]')].filter(
        (node) => node.getClientRects().length > 0,
      );
      return fields.length === 1 && fields[0].value === expected;
    },
    value,
    { timeout: 5000 },
  );
  return composer().inputValue();
}
try {
  isolated = await makeIsolatedElectronHome("codeshell-review-draft-native-");
  report.privateHome = isolated.home;
  assert.ok(outside(outerHome, isolated.home), "Failure HOME must survive the outer runner");
  await put(join(evidence, "receipt.json"), report);
  diagnostics.phase("review-git-setup");
  for (const [index, session] of sessions.entries()) {
    session.path = join(isolated.home, `owned-review-project-${index}`);
    await mkdir(session.path, { mode: 0o700 });
    git(session.path, "init", "--quiet", "-b", "main");
    git(session.path, "config", "user.name", "Owned Review draft fixture");
    git(session.path, "config", "user.email", "review-draft@example.invalid");
    await put(join(session.path, "staged.txt"), "owned original staged\n");
    await put(join(session.path, "unstaged.txt"), "owned original unstaged\n");
    git(session.path, "add", ".");
    git(session.path, "commit", "--quiet", "-m", "Owned draft baseline");
    await put(join(session.path, "staged.txt"), session.staged + "\n");
    git(session.path, "add", "--", "staged.txt");
    await put(join(session.path, "unstaged.txt"), session.unstaged + "\n");
    await put(
      join(evidence, `owned-git-${index}.diff`),
      git(session.path, "diff", "--no-ext-diff", "HEAD"),
    );
  }
  await put(join(isolated.codeShellHome, "settings.json"), {
    autoUpdates: false,
    permissionMode: "default",
    modelConnections: [
      {
        id: "owned-review-ui-model",
        catalogId: "owned-review-ui",
        tag: "text",
        model: "owned-review-ui",
      },
    ],
    defaults: { text: "owned-review-ui-model" },
    credentials: [],
  });
  await put(
    join(isolated.codeShellHome, "desktop/recents.json"),
    sessions.map((session) => ({
      path: session.path,
      name: session.name,
      lastOpenedAt: Date.now(),
    })),
  );
  diagnostics.phase("review-guard-setup");
  const guard = join(isolated.home, "review-draft-guard.mjs");
  await put(
    guard,
    `
import children from "node:child_process";
import {appendFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
await import(${JSON.stringify(new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href)});
await import(${JSON.stringify(new URL("../../../scripts/runtime-cost-smoke-isolation.mjs", import.meta.url).href)});
const {app,ipcMain,net,safeStorage,shell} = await import("electron");
const {createReviewDraftResponseGate} = await import(${JSON.stringify(new URL("./review-draft-response-gate.mjs", import.meta.url).href)});
let ipcBytes=0;const ipcFile=${JSON.stringify(join(isolated.home, "review-draft-ipc.jsonl"))};
const recordReviewIpc=(row)=>{const line=JSON.stringify(row)+"\\n";ipcBytes+=Buffer.byteLength(line);if(ipcBytes>512*1024)throw Error("Review IPC ledger cap");appendFileSync(ipcFile,line,{mode:0o600});};
const state = globalThis.__ownedReviewDraft = {gate:createReviewDraftResponseGate(${JSON.stringify(sessions.map((s) => s.id))},{onRecord:recordReviewIpc}),catalogCalls:0,registered:0,agentMessages:[],readonlyAgentRequests:[],unexpected:[],probes:[],probing:false};
const deny = (kind,metadata={}) => { if(!state.probing) {state.unexpected.push(kind);appendFileSync(${JSON.stringify(join(isolated.home, "denied-attempts.jsonl"))},JSON.stringify({pid:process.pid,kind,...metadata})+"\\n",{mode:0o600});} throw Error("Owned Review draft denied "+kind); };
globalThis.fetch=()=>deny("fetch");
for(const name of ["node:http","node:https"]) {const transport=(await import(name)).default;for(const method of ["get","request"])transport[method]=()=>deny(name+"."+method);}
for(const [name,methods]of [["node:net",["connect","createConnection"]],["node:tls",["connect"]]]) {const transport=(await import(name)).default;for(const method of methods)transport[method]=()=>deny(name+"."+method);}
net.fetch=net.request=()=>deny("electron.net");
for(const name of ["isEncryptionAvailable","getSelectedStorageBackend","encryptString","decryptString"])if(typeof safeStorage[name]==="function")safeStorage[name]=()=>deny("crypto");
for(const name of ["openPath","openExternal","showItemInFolder"])shell[name]=()=>deny("OS-open");
const spawn=children.spawn;children.spawn=function(command,args,options){if(args?.some(arg=>String(arg).includes("agent-server-stdio")))return deny("Worker");return spawn.call(this,command,args,options);};
syncBuiltinESMExports();
app.on("web-contents-created",(_event,contents)=>contents.session.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*","ws://*/*","wss://*/*"]},(_details,done)=>{state.unexpected.push("chromium-network");appendFileSync(${JSON.stringify(join(isolated.home, "denied-attempts.jsonl"))},JSON.stringify({pid:process.pid,kind:"chromium-network"})+"\\n",{mode:0o600});done({cancel:true});}));
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>{
 if(channel==="catalog:list")return handle(channel,()=>{state.catalogCalls++;return [{id:"owned-review-ui",tag:"text",adapterKind:"openai",displayName:"Owned Review UI model",description:"No provider exists",defaultBaseUrl:"http://127.0.0.1:9",modelPresets:[{value:"owned-review-ui",label:"Owned Review UI model",maxContextTokens:4096}]}];});
 if(channel!=="review:preparePrompt")return handle(channel,listener);
 state.registered++;if(state.registered!==1)throw Error("Duplicate Review production listener");
 return handle(channel,(...args)=>state.gate.invoke(listener,args));
};
${reviewDraftReadonlyRpcGuardSource(sessions.map((session) => session.id))}
state.probing=true;
for(const[name,probe]of [
 ["fetch external",()=>fetch("https://example.invalid/blocked")],
 ["HTTP external",async()=>(await import("node:http")).request("http://example.invalid/blocked")],
 ["HTTP other loopback",async()=>(await import("node:http")).request("http://127.0.0.1:10/blocked")],
 ["HTTPS external",async()=>(await import("node:https")).get("https://example.invalid/blocked")],
 ["raw socket",async()=>(await import("node:net")).connect(443,"example.invalid")],
 ["TLS socket",async()=>(await import("node:tls")).connect(443,"example.invalid")],
 ["Electron net",()=>net.request("https://example.invalid/blocked")],
]){let blocked=false;try{await probe();}catch(error){blocked=error.message.startsWith("Owned Review draft denied ");}state.probes.push({name,blocked});if(!blocked)throw Error("Review guard probe escaped");}
state.probing=false;
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
    gateSHA256: hash(await readFile(new URL("./review-draft-response-gate.mjs", import.meta.url))),
    readonlyRpcGuardSHA256: hash(
      await readFile(new URL("./review-draft-readonly-rpc-guard.mjs", import.meta.url)),
    ),
    mainSHA256: hash(await readFile(join(appDir, "out/main/index.mjs"))),
    preloadSHA256: hash(await readFile(join(appDir, "out/preload/index.cjs"))),
  };
  assert.equal(report.build.sourceDirty, false);
  diagnostics.provenance({
    ...report.build,
    platform: process.platform,
    arch: process.arch,
    privateHome: isolated.home,
  });
  const executable = await realpath(createRequire(import.meta.url)("electron"));
  const originalSpawn = children.spawn;
  children.spawn = function (command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    if (command === executable && options?.env?.HOME === isolated.home) {
      assert.equal(captured, undefined);
      captured = child;
      diagnostics.observeChild(child);
      processClosed = new Promise((done) =>
        child.once("close", (code, signal) => done({ code, signal })),
      );
      child.once("error", (error) => {
        diagnostics.error(error, child);
        observerFailures.push("Owned Main spawn error");
      });
      monitor = watchElectronTestProcess(child, {
        timeoutMs: 120000,
        reportFailure: (message) => {
          diagnostics.error(new Error(message), child);
          observerFailures.push(message);
        },
        signalProcess: (pid, signal) => {
          diagnostics.signal(pid, signal);
          process.kill(pid, signal);
        },
      });
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    diagnostics.phase("review-launch");
    app = await launchCodeShellElectron(
      { appDir, ...isolated, mainEntry: fixture.mainEntry, env: fixture.env },
      {
        diagnostics,
        reportFailure: (message) => observerFailures.push(message),
        watch: (child) => {
          assert.equal(child, captured);
          return monitor;
        },
      },
    );
  } finally {
    children.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  assert.equal(captured, app.process());
  diagnostics.phase("review-find-renderer");
  win = await findCodeShellWindow(app);
  win.setDefaultTimeout(10000);
  await win.addInitScript(() => {
    window.__ownedReviewSeedEvents = [];
    window.addEventListener("codeshell:composer-seed-request", (event) => {
      const { source, sessionId, text } = event.detail;
      window.__ownedReviewSeedEvents.push({ source, sessionId, text });
    });
  });
  rendererErrors.push(captureRendererErrors(win));
  await win.setViewportSize({ width: 1440, height: 960 });
  for (const session of sessions) {
    await dismissTrust();
    await win.getByRole("button", { name: session.name, exact: true }).first().click();
    await dismissTrust();
    session.project = await win.evaluate(
      async (path) =>
        (await window.codeshell.projectRegistry.list()).find((project) =>
          project.roots.some((root) => root.path === path),
        ),
      session.path,
    );
    assert.ok(session.project?.id);
  }
  diagnostics.phase("review-session-seed");
  for (const session of sessions) {
    await put(join(isolated.codeShellHome, "sessions", session.id, "state.json"), {
      sessionId: session.id,
      title: session.title,
      cwd: session.path,
      project: { projectId: session.project.id, mainRootId: session.project.primaryRootId },
      origin: "desktop",
      kind: "work",
      parentSessionId: null,
      status: "completed",
      startedAt: Date.now(),
    });
    await put(
      join(isolated.codeShellHome, "sessions", session.id, "transcript.jsonl"),
      JSON.stringify({
        id: session.id + "-message",
        timestamp: Date.now(),
        turnNumber: 1,
        type: "message",
        data: { role: "user", content: session.title },
      }) + "\n",
    );
  }
  await seedSessionCatalog(
    win,
    Object.fromEntries(
      sessions.map((session) => [
        session.project.id,
        {
          sessions: [
            {
              id: session.id,
              engineSessionId: session.id,
              title: session.title,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          activeSessionId: null,
        },
      ]),
    ),
  );
  await win.reload();
  await dismissTrust();
  const [a, b] = sessions;
  await openSession(b);
  await composer().fill(prefixB);
  const controlsB = await controls();
  await openSession(a);
  await composer().fill(prefixA);
  const controlsA = await controls();
  assert.ok(controlsA.model && controlsB.model, "Owned synthetic model selection must be visible");
  report.confinement = await fixture.assertWorker(app, { requireWorker: false });
  assert.equal(report.confinement.workerCreated, false);
  diagnostics.phase("review-ui-operations");
  let panel = await reviewPanel();
  await chooseScope(panel, "staged");
  await panel.getByText(a.staged, { exact: true }).waitFor();
  await (await reviewOptions(panel)).click();
  const first = await waitGate(1, "returned");
  assert.equal(first.sessionId, a.id);
  assert.equal(first.request.scope.mode, "staged");
  assert.ok(first.response.prompt.includes(a.staged) && first.response.prompt.includes(focus));
  assert.ok(
    !first.response.prompt.includes(a.unstaged) && !first.response.prompt.includes(b.staged),
  );
  const draft1 = prefixA + "\n\n" + first.response.prompt;
  assert.equal(await draftEquals(draft1), draft1);
  assert.deepEqual(await controls(), controlsA);
  operations.push({
    action: "Actual staged Review adds only A plus focus once and preserves the unsent prefix",
    ipc: first,
    input: await composer().inputValue(),
    before: prefixA,
    controls: controlsA,
  });
  diagnostics.caseCompleted(operations.at(-1).action, operations.length);
  await win.screenshot({ path: join(evidence, "review-draft-staged.png") });

  await app.evaluate(({ id }) => globalThis.__ownedReviewDraft.gate.arm(id, "staged"), {
    id: a.id,
  });
  await (await reviewOptions(panel)).click();
  const oldScope = await waitGate(2, "held-after-production-result");
  assert.ok(oldScope.response.prompt.includes(a.staged));
  await chooseScope(panel, "unstaged");
  await panel.getByText(a.unstaged, { exact: true }).waitFor();
  await app.evaluate(() => globalThis.__ownedReviewDraft.gate.release(2));
  await waitGate(2, "returned");
  assert.equal(await draftEquals(draft1), draft1);
  await (await reviewOptions(panel)).click();
  const currentScope = await waitGate(3, "returned");
  assert.equal(currentScope.request.scope.mode, "unstaged");
  assert.ok(
    currentScope.response.prompt.includes(a.unstaged) &&
      !currentScope.response.prompt.includes(a.staged),
  );
  const draft2 = draft1 + "\n\n" + currentScope.response.prompt;
  assert.equal(await draftEquals(draft2), draft2);
  assert.deepEqual(await controls(), controlsA);
  operations.push({
    action:
      "Late staged result cannot append after real scope change; current result appends only the unstaged marker",
    held: oldScope,
    current: currentScope,
    before: draft1,
    input: await composer().inputValue(),
    controls: controlsA,
  });
  diagnostics.caseCompleted(operations.at(-1).action, operations.length);
  await win.screenshot({ path: join(evidence, "review-draft-scope-fence.png") });

  await chooseScope(panel, "staged");
  await panel.getByText(a.staged, { exact: true }).waitFor();
  await app.evaluate(({ id }) => globalThis.__ownedReviewDraft.gate.arm(id, "staged"), {
    id: a.id,
  });
  await (await reviewOptions(panel)).click();
  const oldSession = await waitGate(4, "held-after-production-result");
  await openSession(b);
  assert.equal(await draftEquals(prefixB), prefixB);
  await app.evaluate(() => globalThis.__ownedReviewDraft.gate.release(4));
  await waitGate(4, "returned");
  assert.equal(await draftEquals(prefixB), prefixB);
  assert.deepEqual(await controls(), controlsB);
  panel = await reviewPanel();
  await chooseScope(panel, "staged");
  await panel.getByText(b.staged, { exact: true }).waitFor();
  await (await reviewOptions(panel)).click();
  const currentSession = await waitGate(5, "returned");
  assert.equal(currentSession.sessionId, b.id);
  assert.ok(
    currentSession.response.prompt.includes(b.staged) &&
      !currentSession.response.prompt.includes(a.staged) &&
      !currentSession.response.prompt.includes(a.unstaged),
  );
  const draftB = prefixB + "\n\n" + currentSession.response.prompt;
  assert.equal(await draftEquals(draftB), draftB);
  assert.deepEqual(await controls(), controlsB);
  await openSession(a);
  assert.equal(await draftEquals(draft2), draft2);
  assert.deepEqual(await controls(), controlsA);
  await openSession(b);
  assert.equal(await draftEquals(draftB), draftB);
  operations.push({
    action:
      "Actual sidebar Session/project switch isolates late A and writes the new B draft only to B",
    held: oldSession,
    current: currentSession,
    aInput: draft2,
    bInput: await composer().inputValue(),
    aControls: controlsA,
    bControls: controlsB,
  });
  diagnostics.caseCompleted(operations.at(-1).action, operations.length);
  await win.screenshot({ path: join(evidence, "review-draft-session-fence.png") });
  report.rendererSeedEvents = await win.evaluate(() => window.__ownedReviewSeedEvents);
  assert.deepEqual(
    report.rendererSeedEvents,
    [first, currentScope, currentSession].map((call) => ({
      source: "code-review",
      sessionId: call.sessionId,
      text: call.response.prompt,
    })),
  );
  assert.equal(operations.length, 3);
} catch (error) {
  diagnostics.error(error, captured);
  failures.push({
    stage: "original",
    message: safeMessage(error),
  });
  await win?.screenshot({ path: join(evidence, "failure.png"), timeout: 2000 }).catch(() => {});
} finally {
  if (app) {
    try {
      report.main = await bounded(
        app.evaluate(() => {
          const state = globalThis.__ownedReviewDraft;
          const result = {
            gate: state.gate.snapshot(),
            registered: state.registered,
            catalogCalls: state.catalogCalls,
            agentMessages: state.agentMessages,
            readonlyAgentRequests: state.readonlyAgentRequests,
            unexpected: state.unexpected,
            probes: state.probes,
          };
          state.gate.close();
          return result;
        }),
        3000,
        "Review response ledger unavailable",
      );
      assert.deepEqual(report.main.gate.violations, []);
      assert.equal(report.main.gate.hold, null);
      assert.equal(report.main.registered, 1);
      assert.equal(report.main.gate.calls.length, 5);
      assert.deepEqual(
        report.main.gate.calls.map((call) => call.held),
        [false, true, false, true, false],
      );
      assert.ok(report.main.gate.calls.every((call) => call.status === "returned"));
      assert.deepEqual(report.main.agentMessages, []);
      assert.ok(report.main.readonlyAgentRequests.length > 0);
      assert.deepEqual(report.main.unexpected, []);
      assert.equal(report.main.probes.length, 7);
      assert.ok(report.main.probes.every((probe) => probe.blocked));
    } catch (error) {
      diagnostics.error(error, captured);
      failures.push({ stage: "main-ledgers", message: safeMessage(error) });
    }
  }
  const cleanup = diagnostics.cleanup(failures.length ? "cycle-error" : "cycle-complete", captured);
  try {
    if (app && monitor) {
      diagnostics.phase("review-graceful-close");
      diagnostics.request(cleanup, "application.close", captured);
      await bounded(app.close(), 8000, "Owned Review draft close timed out");
      diagnostics.closeReturned(captured);
    }
  } catch (error) {
    diagnostics.error(error, captured);
    failures.push({ stage: "close", message: safeMessage(error) });
  }
  try {
    diagnostics.phase("review-custody");
    assert.ok(monitor, "Owned Main custody missing");
    diagnostics.request(cleanup, "monitor.terminate", captured);
    report.settlement = await monitor.terminate();
    diagnostics.settled(cleanup, captured);
    assert.equal(report.settlement.status, "cleaned");
    assert.equal(report.settlement.remainingCount, 0);
    assert.deepEqual(report.settlement.remaining, []);
    assert.equal(report.settlement.queryFailed, false);
    assert.equal(report.settlement.evidenceTruncated, false);
    assert.ok(
      report.settlement.owned.some(
        (row) => row.pid === captured.pid && row.ppid === process.pid && row.birth,
      ),
    );
    diagnostics.phase("review-main-close");
    report.mainExit = await bounded(processClosed, 3000, "Owned Main exit unavailable");
    assert.deepEqual(report.mainExit, { code: 0, signal: null });
    diagnostics.phase("review-transport");
    report.windowsTransport = assertSourceElectronTransportSettled(captured);
  } catch (error) {
    diagnostics.error(error, captured);
    failures.push({ stage: "custody", message: safeMessage(error) });
    captured?.unref();
    captured?.stdout?.unref?.();
    captured?.stderr?.unref?.();
  }
  report.rendererErrors = rendererErrors.flat().map(safeMessage);
  if (report.rendererErrors.length)
    failures.push({ stage: "renderer", message: "Renderer errors observed" });
  if (observerFailures.length)
    failures.push({ stage: "observer", message: "Custody/transport errors", observerFailures });
  diagnostics.phase("review-final-ledgers");
  for (const name of [
    "denied-attempts.jsonl",
    "spawned-workers.jsonl",
    "cost-gui-guard.jsonl",
    "network-guard.jsonl",
    "review-draft-ipc.jsonl",
  ]) {
    try {
      const content = await readFile(join(isolated.home, name), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      await put(join(evidence, name), content);
      if (name === "review-draft-ipc.jsonl") {
        assert.ok(Buffer.byteLength(content) <= 512 * 1024);
        const rows = content.trim().split("\n").map(JSON.parse);
        const calls = report.main?.gate.calls;
        assert.equal(rows.filter((row) => row.kind === "violation").length, 0);
        assert.deepEqual(
          rows
            .filter((row) => row.kind === "request")
            .map(({ id, sessionId, request }) => ({ id, sessionId, request })),
          calls.map(({ id, sessionId, request }) => ({ id, sessionId, request })),
        );
        assert.deepEqual(
          rows
            .filter((row) => row.kind === "production-result")
            .map(({ id, sessionId, response }) => ({ id, sessionId, response })),
          calls.map(({ id, sessionId, response }) => ({ id, sessionId, response })),
        );
        assert.deepEqual(
          rows.filter((row) => row.kind === "returned").map((row) => row.id),
          [1, 2, 3, 4, 5],
        );
        assert.deepEqual(
          rows.filter((row) => row.kind === "response-released").map((row) => row.id),
          [2, 4],
        );
        assert.equal(rows.filter((row) => row.kind === "gate-closed").length, 1);
        assert.deepEqual(
          rows
            .filter((row) => row.kind === "readonly-agent-rpc")
            .map(({ method, sessionId, id }) => ({ method, sessionId, id })),
          report.main.readonlyAgentRequests,
        );
        report.ipcLedger = {
          bytes: Buffer.byteLength(content),
          sha256: hash(content),
          records: rows.length,
          boundary:
            "Actual production IPC arguments/results and fixture response release, not a model turn",
        };
      }
      if (["denied-attempts.jsonl", "spawned-workers.jsonl"].includes(name) && content.trim())
        failures.push({ stage: "late-ledger", message: `Forbidden runtime side effect: ${name}` });
    } catch (error) {
      diagnostics.error(error, captured);
      failures.push({ stage: "late-ledger", message: safeMessage(error) });
    }
  }
  diagnostics.phase("review-home-cleanup");
  try {
    report.windowsTransport = assertSourceElectronTransportSettled(captured);
  } catch (error) {
    diagnostics.error(error, captured);
    failures.push({ stage: "final-transport", message: safeMessage(error) });
  }
  if (observerFailures.length && !failures.some((row) => row.stage === "observer"))
    failures.push({
      stage: "observer",
      message: "Late custody/transport errors",
      observerFailures,
    });
  if (diagnostics.hasRecordingFailure())
    failures.push({ message: "Review diagnostic recording failed/truncated" });
  if (
    operations.length === 3 &&
    !failures.length &&
    report.settlement?.status === "cleaned" &&
    report.mainExit?.code === 0 &&
    report.mainExit?.signal === null
  ) {
    try {
      await isolated.cleanup();
      report.privateHomeRemoved = true;
      report.status = "passed";
    } catch (error) {
      diagnostics.error(error, captured);
      failures.push({ stage: "home-cleanup", message: safeMessage(error) });
    }
  }
  report.retainedHome = report.privateHomeRemoved ? null : (isolated?.home ?? null);
  diagnostics.homeRemoved(report.privateHomeRemoved);
  diagnostics.phase("review-final-report");
  if (diagnostics.hasRecordingFailure()) {
    report.status = "failed";
    failures.push({ message: "Final diagnostic recording failed/truncated" });
  }
  await put(join(evidence, "receipt.json"), report).catch((error) => {
    diagnostics.error(error, captured);
    throw error;
  });
  diagnostics.finalReportWritten(report.status);
  if (diagnostics.hasRecordingFailure() && report.status === "passed") {
    report.status = "failed";
    failures.push({
      message: "Post-removal final diagnostic write failed; removed HOME cannot be restored",
    });
    await put(join(evidence, "receipt.json"), report);
    diagnostics.finalReportWritten(report.status);
  }
}
console.log(
  JSON.stringify({ status: report.status, evidence, operations: operations.length, failures }),
);
assert.equal(
  report.status,
  "passed",
  "Review draft acceptance failed; see truthful privateHomeRemoved/retainedHome receipt",
);
