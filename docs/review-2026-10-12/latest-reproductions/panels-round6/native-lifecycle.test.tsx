import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "../../../../node_modules/typescript/lib/typescript.js";
import { guardProjectScopeNetwork } from "../../../../packages/server/src/panels/__fixtures__/project-scope-network.ts";

guardProjectScopeNetwork(afterAll);
const {
  preparePanelAppStorage,
  writePanelAppStorage,
  readPanelAppStorage,
  panelAppStorageKey,
  panelAppStorageQuotaBytes,
  panelAppStorageChange,
  panelAppStorageSnapshot,
  applyPanelAppStorageChange,
} = await import("../../../../packages/server/src/panels/storage-store.ts");
const { createDesktopPanelAutomationHost } = await import("../../../../packages/desktop/src/main/panel-automation-host.ts");
const { CronScheduler } = await import("../../../../packages/core/src/index.internal.ts");

// Execute actual Main methods without Electron startup or replacing their bind logic.
const source = readFileSync(new URL("../../../../packages/desktop/src/main/panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const methods = [
  "bindGuest",
  "assertProjectBinding",
  "assertSessionBinding",
  "assertLiveProjectBinding",
  "assertTrustedHost",
  "bindingFor",
  "waitForBoundGuest",
  "contextFor",
  "call",
  "revokeGuest",
  "dispatch",
  "requirePermission",
  "submitPrompt",
  "panelAutomationHost",
  "panelAutomationScope",
  "conditionalPanelAutomation",
  "automationId",
  "listPanelAutomations",
  "requireScopedPanelAutomation",
  "createPanelAutomation",
  "updatePanelAutomation",
  "controlPanelAutomation",
  "trustedWorkspaceRoot",
  "isWithinWorkspace",
  "ensureWorkspaceDirectory",
  "writeWorkspaceFile",
  "pinWorkspaceDirectory",
  "withWorkspaceWrite",
  "readBoundedWorkspaceFile",
  "writeStorage",
  "withStorageMutation",
  "storageVersioned",
  "storageSet",
  "storageDelete",
].map((name) => {
  const method = declaration.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name,
  );
  if (!method) throw new Error(`Missing real bridge method: ${name}`);
  return method.getText(parsed);
});
const compiled = ts.transpileModule(`class BindingBridge { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const storageSource = readFileSync(
  new URL("../../../../packages/server/src/panels/storage-store.ts", import.meta.url),
  "utf8",
);
const parsedStorage = ts.createSourceFile(
  "storage.ts",
  storageSource,
  ts.ScriptTarget.Latest,
  true,
);
const writer = parsedStorage.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "writePanelAppStorage",
)!;
const compiledWriter = ts.transpileModule(writer.getText(parsedStorage).replace(/^export /, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function scope(rootId = "root") {
  return {
    scope: { version: 1, environmentId: "environment", projectId: "project", rootId },
    assertCurrent() {},
  };
}
function fixture(permissions = ["context.workspace", "context.session"]) {
  const owner = {
    id: 1,
    closed: false,
    isDestroyed() {
      return this.closed;
    },
  };
  const sender = { id: 2 };
  const events: unknown[] = [];
  const guest = {
    id: 3,
    closed: false,
    isDestroyed() {
      return this.closed;
    },
    send(_channel: string, event: unknown) {
      events.push(event);
    },
  };
  const binding = {
    guest,
    ownerWindowId: owner.id,
    resource: { descriptor: { id: "descriptor", appId: "panel", permissions } },
    projectPath: "/project",
    context: {},
    callTimes: [],
    recordingWriteTimes: [],
  };
  let afterTempWrite: (() => Promise<void>) | undefined;
  let storageWriter = writePanelAppStorage;
  const Bridge = runInNewContext(`${compiled}\nBindingBridge`, {
    AbortController,
    isDeepStrictEqual,
    setTimeout,
    Buffer,
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      await afterTempWrite?.();
    },
    preparePanelAppStorage,
    readPanelAppStorage,
    panelAppStorageChange,
    panelAppStorageSnapshot,
    applyPanelAppStorageChange,
    writePanelAppStorage: (...args: Parameters<typeof writePanelAppStorage>) =>
      storageWriter(...args),
    acquireLockOnPath: () => () => {},
    chmodSync,
    constants,
    linkSync,
    lstatSync,
    realpathSync,
    renameSync,
    basename,
    dirname,
    join,
    resolve,
    sep,
    workspaceRevision: (value: Uint8Array) =>
      "sha256:" + createHash("sha256").update(value).digest("hex"),
    resolvePanelAppBindingProjectPath: actualResolvePanelAppBindingProjectPath,
    isPanelAppDescriptorSelected: () => true,
    BrowserWindow: {
      fromWebContents: (value: unknown) => (value === sender ? owner : undefined),
      fromId: () => owner,
    },
    PANEL_APP_API_VERSION: 14,
    PanelBridgeError: class extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(message);
      }
    },
    RESOURCE_TRANSFER_METHODS: new Set(),
    jsonBytes: (value: unknown) => JSON.stringify(value)?.length ?? 0,
    MAX_PARAMS_BYTES: 1_000_000,
    MAX_RESULT_BYTES: 1_000_000,
    MAX_WORKSPACE_READ_BYTES: 1_000_000,
    RATE_WINDOW_MS: 60_000,
    MAX_CALLS_PER_WINDOW: 1000,
    CALL_TIMEOUT_MS: 1000,
    MAX_AGENT_PROMPT_CHARS: 20_000,
    PANEL_AGENT_RUN_TIMEOUT_MS: 1000,
    panelExecutionGate: { run: (_scope: unknown, operation: () => unknown) => operation() },
    withTimeout: (operation: unknown) => operation,
    randomUUID: () => "fixture",
    parseExternalRuntimeModelKey: (key: string) =>
      key === "external" ? { kind: "fixture" } : null,
    claimPanelHostOwnerForRun() {},
  });
  const bridge = new Bridge();
  bridge.guests = new Map([[guest.id, binding]]);
  bridge.resourceTransfers = new Map();
  bridge.pendingAgentToolCalls = new Map();
  bridge.processService = { revokeGuest() {} };
  bridge.agentTaskService = { rebind() {} };
  bridge.agentTaskOwner = () => ({ projectPath: "/project" });
  bridge.workspaceWriteQueues = new Map();
  bridge.options = {
    isTrustedHost: (value: unknown) => value === sender,
    isPanelAppBound: () => true,
    isWorkspaceTrusted: () => true,
    resolveProjectScope: async () => scope(),
  };
  bridge.capabilitiesFor = () => ({ host: "desktop" });
  const input = {
    guestId: guest.id,
    appDescriptorId: "descriptor",
    tabId: "tab",
    bucket: "bucket",
    projectPath: "/project",
    cwd: "/project",
    sessionId: "session-a",
    locale: "en",
  };
  return {
    bridge,
    binding,
    guest,
    sender,
    owner,
    input,
    events,
    stageWrite(action: () => Promise<void>) {
      afterTempWrite = action;
    },
    useStorageWriter(writer: typeof writePanelAppStorage) {
      storageWriter = writer;
    },
  };
}


const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const { writeFileSync } = await import("node:fs");
const { resolvePanelAppBindingProjectPath: actualResolvePanelAppBindingProjectPath } = await import(repo + "/packages/core/src/panel-apps/bindings.ts");
const { ProjectStore } = await import(repo + "/packages/desktop/src/main/project-store.ts");
const { SessionCwdIndex } = await import(repo + "/packages/desktop/src/main/session-cwd-index.ts");
const { createDesktopPanelProjectScopeResolver } = await import(repo + "/packages/desktop/src/main/panel-project-scope.ts");
const React = await import(repo + "/node_modules/react/index.js");
const { act } = React;
const { createRoot } = await import(repo + "/packages/desktop/node_modules/react-dom/client.js");
const { ensureMiniDom, flushMicrotasks, renderHook } = await import(repo + "/packages/desktop/src/renderer/test-utils/renderHook.tsx");
const { useRunController } = await import(repo + "/packages/desktop/src/renderer/app/useRunController.ts");
const { switchActiveModel } = await import(repo + "/packages/desktop/src/renderer/app/switchActiveModel.ts");
const { INITIAL_STATE } = await import(repo + "/packages/desktop/src/renderer/types.ts");
const { saveSessionIndex } = await import(repo + "/packages/desktop/src/renderer/transcripts.ts");
const { PanelAppHost } = await import(repo + "/packages/desktop/src/renderer/panels/PanelAppHost.tsx");
const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
async function realProject() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scope-review-round6-")));
  roots.push(root);
  const cwd = join(root, "main");
  mkdirSync(cwd);
  const store = new ProjectStore({
    file: join(root, "registry/projects.json"), recentsFile: join(root, "registry/recents.json"),
    migrationMarkerFile: join(root, "registry/migration.json"),
    sessionIndex: new SessionCwdIndex({ sessionsRoot: join(root, "sessions") }), noRepoPath: join(root, "no-repo"),
  });
  const project = await store.createFromPath(cwd);
  const resolve = createDesktopPanelProjectScopeResolver({store, environmentDir: join(root,"environment")});
  return {root,cwd,store,project,resolve};
}
function nodes(node: any): any[] {return [node, ...(node.childNodes ?? []).flatMap(nodes)];}
function text(node: any): string {return node.nodeType === 3 ? node.nodeValue : (node.childNodes?.length ? node.childNodes.map(text).join("") : node.textContent ?? "");}
function hookParams(project: any, index: any, bucket: string) {
  const noop = () => {};
  return {
    shell: {t:(key: string)=>key,lang:"en",toast:noop,setView:noop},
    session: {activeProjectId:project.id,activeSessionId:index.activeSessionId,activeBucket:bucket,projects:[project],sessionIndices:{[project.id]:index},setSessionIndices:noop,ensureActiveSession:()=>index.activeSessionId},
    preferences:{permissionOverrides:{},setPermissionOverrides:noop,defaultPermissionMode:null,goalOverrides:{},setGoalOverrides:noop,modelOverrides:{},setModelOverrides:noop,defaultActiveModelKey:"native/model",quickChatDefaultModelKey:null},
    runtime:{setBusyForKey:noop,runningBucketRef:{current:null},engineToBucketRef:{current:new Map()},noRepoCwdRef:{current:null},quickChatSessionsRef:{current:{}},queuedInputs:{},setQueuedInputs:noop,busy:false,busyKeys:new Set(),relayingBuckets:new Set(),setRelayingBuckets:noop,steeredIdsRef:{current:new Set()},injectedSteerIdsRef:{current:new Set()},downgradeRunQueueRef:{current:Promise.resolve()},queuedSeqRef:{current:0},busySinceRef:{current:new Map()},compactingBucketsRef:{current:new Set()},setCompactingBuckets:noop},
    transcript:{dispatch:noop,state:INITIAL_STATE},
    approvals:{approval:null,approvalQueue:[],setApprovalQueue:noop,setApproval:noop,setApprovalHistory:noop,approvalBucketsRef:{current:new Map()}},
  } as any;
}

test("legacy UI session changes its bound Panel engine id through the actual model selector", async()=>{
  ensureMiniDom();
  const p = await realProject();
  const f = fixture(["context.workspace","context.session","automations.manage","agent.submitPrompt","storage"]);
  f.binding.projectPath = p.cwd;
  f.bridge.options.resolveProjectScope = p.resolve;
  let automationCalls=0,prepareCalls=0,runCalls=0;
  f.bridge.options.automations = {list:async()=>{automationCalls++;return[];}};
  const storage=new Map<string,string>();
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
  Object.defineProperty(document.documentElement,"classList",{configurable:true,writable:true,value:{contains:()=>false}});
  Object.defineProperty(HTMLElement.prototype,"getWebContentsId",{configurable:true,value:()=>f.guest.id});
  const descriptor={id:"descriptor",appId:"panel",title:"Fixture",version:"1",icon:"panel",singleton:true,hostId:"fixture",revision:"revision",permissions:f.binding.resource.descriptor.permissions};
  Object.assign(window,{codeshell:{log(){},configure:async()=>{throw Error("unexpected configure");},run:async()=>{runCalls++;throw Error("unexpected run");},preparePanelApp:async()=>{prepareCalls++;return{id:"descriptor",src:"cspanel://fixture/app/index.html",partition:"cspanel:fixture",revision:"revision"};},bindPanelApp:(input:any)=>f.bridge.bindGuest(f.sender,input)}});
  const session={id:"legacy-ui",engineSessionId:"legacy-engine",title:"Existing Session",createdAt:1,updatedAt:1};
  const index={sessions:[session],activeSessionId:session.id};
  saveSessionIndex(p.project.id,index);
  const bucket=p.project.id+"::"+session.id;
  const params=hookParams({...p.project,path:p.cwd},index,bucket);
  const hook=await renderHook(()=>useRunController(params));
  const container=document.createElement("div");
  const ui=createRoot(container);
  const render=async()=>{await act(async()=>{ui.render(React.createElement(PanelAppHost,{descriptor,tabId:"tab",bucket,busy:false,projectPath:p.cwd,cwd:p.cwd,engineSessionId:hook.result.current.resolveEngineSessionIdForBucket(bucket),modelKey:params.preferences.modelOverrides[bucket]??"native/model",permissionMode:"default",planMode:false,hasGoal:false,visible:true}));await flushMicrotasks();});};
  try {
    expect(hook.result.current.resolveEngineSessionIdForBucket(bucket)).toBe("legacy-engine");
    await render();
    const before=nodes(container).find(node=>node.tagName==="WEBVIEW");
    expect(before).toBeDefined();
    await act(async()=>{
      before.dispatchEvent(new Event("dom-ready"));
      // Scope capture includes local async directory work.
      for(let i=0;i<100 && !f.binding.bucket;i++)await new Promise(resolve=>setTimeout(resolve,5));
      await flushMicrotasks();
    });
    expect(f.binding.context.sessionId).toBe("legacy-engine");
    const originalScope=f.binding.context.projectScope;
    expect(await f.bridge.call(f.guest,"automations.list")).toEqual({automations:[]});
    switchActiveModel({currentModelKey:"native/model",nextModelKey:"codex/gpt-6.1-sol",activeBucket:bucket,activeProjectId:p.project.id,activeProjectBucketSegment:p.project.id,activeSessionId:session.id,engineSessionId:"legacy-engine",promptTokens:0,setModelOverrides:(update:any)=>{params.preferences.modelOverrides=update(params.preferences.modelOverrides);},setSessionIndices:()=>{},dispatch:()=>{}});
    await hook.rerender();
    expect(hook.result.current.resolveEngineSessionIdForBucket(bucket)).toBe("legacy-ui");
    await render();
    expect(f.binding.context.sessionId).toBe("legacy-ui");
    expect(f.binding.context.projectScope).toEqual(originalScope);
    expect(f.binding.sensitiveSessionRevoked).toBe(true);
    expect(nodes(container).find(node=>node.tagName==="WEBVIEW")).toBe(before);
    expect(prepareCalls).toBe(1);
    expect(text(container)).not.toContain("failed to load");
    expect(nodes(container).some(node=>node.tagName==="BUTTON")).toBe(false);
    await expect(f.bridge.call(f.guest,"automations.list")).rejects.toMatchObject({code:"SESSION_CHANGED"});
    await expect(f.bridge.call(f.guest,"agent.submitPrompt",{prompt:"do not dispatch fixture"})).rejects.toMatchObject({code:"SESSION_CHANGED"});
    expect(automationCalls).toBe(1);
    expect(runCalls).toBe(0);
    f.binding.projectScope!.assertCurrent();
    f.bridge.storageQuotaBytes=()=>4096;
    const storageFile=join(p.root,"storage/panel.json");
    await f.bridge.writeStorage(f.binding,storageFile,{draft:"project storage remains usable"});
    expect(JSON.parse(readFileSync(storageFile,"utf8"))).toEqual({draft:"project storage remains usable"});
    const fresh=fixture(["context.workspace","context.session","automations.manage"]);
    fresh.binding.projectPath=p.cwd;
    fresh.bridge.options.resolveProjectScope=p.resolve;
    fresh.bridge.options.automations={list:async()=>[]};
    await fresh.bridge.bindGuest(fresh.sender,{...fresh.input,projectPath:p.cwd,cwd:p.cwd,sessionId:"legacy-ui",bucket});
    expect(await fresh.bridge.call(fresh.guest,"automations.list")).toEqual({automations:[]});
    writeFileSync(new URL("./legacy-model-switch-observed.json",import.meta.url),JSON.stringify({uiSession:session.id,bucket,firstPanelSession:"legacy-engine",afterSelection:f.binding.context,stickyRevoked:f.binding.sensitiveSessionRevoked,prepareCalls,guestReused:true,hostError:text(container),automationCalls,runCalls,projectStorageUsable:true,reopenRecovered:true},null,2));
  } finally {await act(async()=>{ui.unmount();await flushMicrotasks();});await hook.unmount();delete(HTMLElement.prototype as any).getWebContentsId;}
});

test("R22 remains before scope capture although secondary root has the same registered project id",async()=>{
  const p=await realProject();
  const secondary=join(p.root,"secondary");mkdirSync(secondary);
  await p.store.addRoot(p.project.id,secondary);
  const a=await p.resolve(p.cwd,p.cwd),b=await p.resolve(secondary,secondary);
  expect(a!.scope.projectId).toBe(b!.scope.projectId);
  const f=fixture();f.binding.projectPath=p.cwd;
  let captures=0;f.bridge.options.resolveProjectScope=async(...args:any[])=>{captures++;return p.resolve(...args as [string,string]);};
  await expect(f.bridge.bindGuest(f.sender,{...f.input,projectPath:p.cwd,cwd:secondary})).rejects.toThrow("workspace does not belong");
  expect(captures).toBe(0);
  writeFileSync(new URL("./secondary-root-observed.json",import.meta.url),JSON.stringify({primaryScope:a!.scope,secondaryScope:b!.scope,registryRootStatus:p.store.resolveExactRootSync(secondary)?.mainRoot,bindResolverCalls:captures,rejectionBeforeResolver:true},null,2));
});


test("modern UI equals engine identity keeps Panel automation usable across model selection",async()=>{
  ensureMiniDom();
  const p=await realProject();
  const f=fixture(["context.workspace","context.session","automations.manage"]);
  f.binding.projectPath=p.cwd;f.bridge.options.resolveProjectScope=p.resolve;
  let calls=0;f.bridge.options.automations={list:async()=>{calls++;return[];}};
  const session={id:"modern-ui",engineSessionId:"modern-ui",title:"Current",createdAt:1,updatedAt:1};
  const bucket=p.project.id+"::"+session.id;
  const index={sessions:[session],activeSessionId:session.id};
  const params=hookParams({...p.project,path:p.cwd},index,bucket);
  const hook=await renderHook(()=>useRunController(params));
  try {
    await f.bridge.bindGuest(f.sender,{...f.input,projectPath:p.cwd,cwd:p.cwd,sessionId:hook.result.current.resolveEngineSessionIdForBucket(bucket),bucket});
    const stable=f.binding.context.projectScope;
    switchActiveModel({currentModelKey:"native/model",nextModelKey:"codex/gpt-6.1-sol",activeBucket:bucket,activeProjectId:p.project.id,activeProjectBucketSegment:p.project.id,activeSessionId:session.id,engineSessionId:session.engineSessionId,promptTokens:0,setModelOverrides:(update:any)=>{params.preferences.modelOverrides=update(params.preferences.modelOverrides);},setSessionIndices:()=>{},dispatch:()=>{}});
    await hook.rerender();
    expect(hook.result.current.resolveEngineSessionIdForBucket(bucket)).toBe("modern-ui");
    await f.bridge.bindGuest(f.sender,{...f.input,projectPath:p.cwd,cwd:p.cwd,sessionId:hook.result.current.resolveEngineSessionIdForBucket(bucket),bucket,modelKey:"codex/gpt-6.1-sol"});
    expect(f.binding.sensitiveSessionRevoked).not.toBe(true);
    expect(f.binding.context.projectScope).toEqual(stable);
    expect(await f.bridge.call(f.guest,"automations.list")).toEqual({automations:[]});
    expect(calls).toBe(1);
  } finally {await hook.unmount();}
});
