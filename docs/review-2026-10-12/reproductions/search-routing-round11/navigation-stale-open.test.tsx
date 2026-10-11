import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const forbidden = (..._args: any[]) => { throw new Error("NETWORK_FORBIDDEN_round11"); };
globalThis.fetch = forbidden as any;
http.request = http.get = forbidden as any;
https.request = https.get = forbidden as any;
net.connect = net.createConnection = forbidden as any;
tls.connect = forbidden as any;
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) {
  throw new Error("guarded HOME required");
}

import { fileURLToPath } from "node:url";
const REVIEW_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
import React, { act } from "react";
import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createRoot } = await import(`${REVIEW_ROOT}/packages/desktop/node_modules/react-dom/client`);
const { ensureMiniDom, flushMicrotasks } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/test-utils/renderHook`);
ensureMiniDom();
// Presentation-only wrappers. Search parsing, request identity, match resolution,
// card opening, project selection and Main services below remain production code.
mock.module(`${REVIEW_ROOT}/packages/desktop/src/renderer/shell/SearchDialog`, () => ({
  SearchDialog: ({open, children}: any) => open ? <section role="dialog">{children}</section> : null,
}));
mock.module(`${REVIEW_ROOT}/packages/desktop/src/renderer/components/ui/command`, () => ({
  Command: ({children}: any) => <div>{children}</div>,
  CommandInput: React.forwardRef(({value, onValueChange, ...rest}: any, ref: any) => <input {...rest} ref={ref} value={value} onChange={(e) => onValueChange(e.target.value)}/>),
  CommandList: ({children}: any) => <div>{children}</div>,
  CommandItem: ({children, disabled, onSelect, value}: any) => <button data-command-value={value} disabled={disabled} onClick={() => onSelect()}>{children}</button>,
}));
const { SessionSearchModal } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/shell/SessionSearchModal`);
function nodes(node: any): any[] { return [node, ...Array.from(node?.childNodes ?? []).flatMap(nodes)]; }
function props(node: any): any { const k=Object.keys(node).find((x)=>x.startsWith("__reactProps$")); return k ? node[k] : {}; }
function textOf(v: any): string { if(typeof v==="string"||typeof v==="number") return String(v); if(Array.isArray(v))return v.map(textOf).join(""); return v?.props ? textOf(v.props.children) : ""; }
function visibleText(container: any) { return nodes(container).map((n)=>textOf(props(n).children)).join("|"); }
async function until(fn:()=>boolean, timeout=2000) { const deadline=Date.now()+timeout; while(!fn()){ if(Date.now()>deadline)throw Error("fixture wait timed out"); await act(async()=>{await new Promise(r=>setTimeout(r,5)); await flushMicrotasks();}); } }
let root: any;
let fixtureRoot="";
afterEach(async()=>{ if(root)await act(async()=>{root.unmount(); await flushMicrotasks();}); root=undefined; if(fixtureRoot)rmSync(fixtureRoot,{recursive:true,force:true}); fixtureRoot=""; });

const { SessionManager } = await import(`${REVIEW_ROOT}/packages/core/src/session/session-manager`);
const { useAutomationSessionImport } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/app/useAutomationSessionImport`);
const { useSessionNavigation } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/app/useSessionNavigation`);
const { useTrackedProjects } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/app/useTrackedProjects`);
const { saveProjects, trackedProjectFromRegistry, __resetProjectSnapshotForTest } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/projects`);
const { saveSessionIndex, bucketKey } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/transcripts`);
const { createPetTargetNavigator } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/pet/createPetTargetNavigator`);
const { PetLongTaskCard } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/pet/PetLongTaskSection`);
const { DialogProvider } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/ui/DialogProvider`);
const { SessionCwdIndex } = await import(`${REVIEW_ROOT}/packages/desktop/src/main/session-cwd-index`);
const { ProjectStore } = await import(`${REVIEW_ROOT}/packages/desktop/src/main/project-store`);
const { PetStateAggregator } = await import(`${REVIEW_ROOT}/packages/desktop/src/main/pet/pet-state-aggregator`);
const { registerPetIpc } = await import(`${REVIEW_ROOT}/packages/desktop/src/main/pet/pet-ipc`);
const { listDiskSessions } = await import(`${REVIEW_ROOT}/packages/server/src/sessions-service`);
let stopAggregator: any;
let disposeIpc: any;
afterEach(()=>{stopAggregator?.();stopAggregator=undefined;disposeIpc?.();disposeIpc=undefined;__resetProjectSnapshotForTest();});
async function scenario(delayResolution: boolean){
 fixtureRoot=realpathSync(mkdtempSync(join(tmpdir(),"codeshell-navigation-")));
 const pPath=join(fixtureRoot,"project-p"),qPath=join(fixtureRoot,"project-q"),sessionsRoot=join(fixtureRoot,"sessions");
 mkdirSync(pPath);mkdirSync(qPath);mkdirSync(sessionsRoot);
 // Materialize a complete ordinary persistent Core bundle, not catalog-only metadata.
 const creator=new SessionManager(sessionsRoot);
 const diskBundle=creator.create(pPath,"fixture-model-no-provider-call","fixture-provider-no-call","disk-B",null,"desktop","work");
 diskBundle.transcript.appendMessage("user","B durable user message");
 diskBundle.transcript.appendMessage("assistant","B durable assistant reply");
 creator.updateSessionState("disk-B",{title:"Real disk B",status:"completed"});
 const resumed=new SessionManager(sessionsRoot).resume("disk-B");
 expect(resumed.state.sessionId).toBe("disk-B");expect(resumed.state.cwd).toBe(pPath);
 expect(resumed.state.title).toBe("Real disk B");expect(resumed.state.origin).toBe("desktop");
 expect(resumed.state.kind).toBe("work");expect(resumed.state.parentSessionId).toBeNull();
 expect(resumed.state.workspace).toEqual({root:pPath,kind:"main"});
 expect(resumed.transcript.toMessages().filter(m=>m.role==="user"||m.role==="assistant").map(m=>m.content)).toEqual(["B durable user message","B durable assistant reply"]);
 const sessionIndex=new SessionCwdIndex({sessionsRoot});await sessionIndex.ensureLoaded();
 const store=new ProjectStore({file:join(fixtureRoot,"projects.json"),recentsFile:join(fixtureRoot,"recents.json"),migrationMarkerFile:join(fixtureRoot,"migration.json"),sessionIndex,noRepoPath:join(fixtureRoot,"no-repo")});
 const p=await store.createFromPath(pPath),q=await store.createFromPath(qPath);
 const storage=new Map<string,string>();
 Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
 __resetProjectSnapshotForTest();saveProjects([p,q].map(trackedProjectFromRegistry));
 const indices:any={[p.id]:{sessions:[{id:"indexed-A",title:"Indexed A",createdAt:1,updatedAt:1}],activeSessionId:"indexed-A"},[q.id]:{sessions:[{id:"indexed-C",title:"Choose indexed C",createdAt:2,updatedAt:2}],activeSessionId:null}};
 saveSessionIndex(p.id,indices[p.id]);saveSessionIndex(q.id,indices[q.id]);
 const aggregator=new PetStateAggregator({bridge:{hasLiveWorker:()=>false,requestPetProjectionSnapshot:async()=>null,subscribePetProjection:()=>()=>{}},listDiskSessions:options=>listDiskSessions(options,sessionsRoot),catalogRefreshIntervalMs:0});
 await aggregator.start();stopAggregator=()=>aggregator.stop();
 expect(aggregator.getSnapshot().sessions.map(s=>s.agentSessionId)).toContain("disk-B");
 const handlers=new Map<string,any>();
 disposeIpc=registerPetIpc({ipcMain:{handle:(c,h)=>handlers.set(c,h),removeHandler:c=>handlers.delete(c)},aggregator,windows:()=>[]});
 let releaseResolution:any;let resolutionReady=false;const resolutionGate=new Promise<void>(r=>releaseResolution=r);
 const calls:any[]=[];const targets:any[]=[];
 // Production App starts this importer after mounting; its asynchronous first page
 // is independent of Pet snapshot/task loading. Hold only that valid page's IPC reply.
 let releaseCatalog:any;let catalogReady=false;let catalogFinished=false;
 const catalogGate=new Promise<void>(r=>releaseCatalog=r);
 const catalogCalls:any[]=[];
 const api:any={openSession:async(request)=>{const value=await handlers.get("pet:open-session")({},request);targets.push(value);return value;}};
 Object.defineProperty(window,"codeshell",{configurable:true,value:{log(){},listRuns:async()=>[],listDiskSessions:async(options)=>{const result=await listDiskSessions(options,sessionsRoot);catalogCalls.push({options,result});catalogReady=true;await catalogGate;catalogFinished=true;return result;},projectRegistry:{resolveForCwdBatch:async(cwds,source)=>{const result=await store.resolveProjectForCwdBatch(cwds,source);calls.push({cwds,source,result});resolutionReady=true;if(delayResolution)await resolutionGate;return result;}}}});
 const container=document.createElement("div");root=createRoot(container);
 let state:any;let openPicker:any;let pendingOpen:Promise<any>|undefined;
 const snapshot=aggregator.getSnapshot();
 function Host(){
  const [projects,setProjects]=useTrackedProjects();const [sessionIndices,setSessionIndices]=React.useState(indices);const [activeProjectId,setActiveProjectId]=React.useState(p.id);const [view,setView]=React.useState<any>({viewMode:"pet",sidebarCollapsed:false});const [searchOpen,setSearchOpen]=React.useState(false);openPicker=setSearchOpen;
  const sessionIndicesRef=React.useRef(sessionIndices);sessionIndicesRef.current=sessionIndices;
  const importedCatalog=useAutomationSessionImport({sessionIndicesRef,setSessionIndices,setProjects});
  const activeBucketRef=React.useRef(bucketKey(p.id,"indexed-A"));
  const navigation=useSessionNavigation({projects,setProjects,activeProjectId,setActiveProjectId,sessionIndices,setSessionIndices,setCollapsedProjects:()=>{},setUnreadBuckets:()=>{},setPermissionOverrides:()=>{},setModelOverrides:()=>{},setGoalOverrides:()=>{},panelByBucket:{},setPanelByBucket:()=>{},activeBucketRef,setView,setRunsInitialRunId:()=>{}});
  const navigate=createPetTargetNavigator({api,activeBucketRef,updatePanelBucket:()=>{},setView,isNarrowWindow:false,markViewedPetCompletions:()=>{},openDiskSession:navigation.handleOpenAutomationDiskSession,toast:()=>{},t:key=>key});
  state={activeProjectId,sessionIndices,view,bucket:activeBucketRef.current,navigation,diskSessionCatalog:importedCatalog.diskSessionCatalog};
  const task:any={schemaVersion:1,id:"pet-task-0123456789abcdef01234567",originClientMessageId:"origin",objective:"Open disk B",sessionId:"disk-B",status:"completed",phase:"completed",attempt:1,revision:1,createdAt:1,updatedAt:1,events:[],artifacts:[]};
  return <DialogProvider><PetLongTaskCard task={task} busy={false} onControl={()=>{}} onOpenSession={sid=>{pendingOpen=navigate({agentSessionId:sid,snapshotVersion:snapshot.version,generation:snapshot.generation});}}/><SessionSearchModal open={searchOpen} onClose={()=>setSearchOpen(false)} projects={projects} sessions={sessionIndices} activeProjectId={activeProjectId} onPick={navigation.handleSelectSession}/></DialogProvider>;
 }
 await act(async()=>{root.render(<Host/>);await flushMicrotasks();});
 await until(()=>catalogReady);
 expect(catalogCalls[0].options).toEqual({limit:50});
 expect(catalogCalls[0].result.sessions.some(s=>s.engineSessionId==="disk-B")).toBe(true);
 expect(state.diskSessionCatalog).toEqual({initialized:false,loading:true,nextCursor:null});
 const button=nodes(container).find(n=>n.tagName==="BUTTON"&&/打开工作会话|Open work session/.test(textOf(props(n).children)));
 expect(button).toBeDefined();expect(props(button).disabled).not.toBe(true);
 await act(async()=>{props(button).onClick();await flushMicrotasks();});
 await until(()=>resolutionReady);
 expect(targets[0].status).toBe("ok");expect(targets[0].target.engineSessionId).toBe("disk-B");
 expect(calls[0].result).toEqual([{projectId:p.id,rootId:p.primaryRootId,created:false}]);
 if(!delayResolution){await act(async()=>{await pendingOpen;await flushMicrotasks();});expect(state.bucket).toBe(bucketKey(p.id,"disk-B"));}
 // The global session picker remains usable while the earlier open is pending.
 await act(async()=>{openPicker(true);await flushMicrotasks();});
 const chooseC=nodes(container).find(n=>props(n)["data-command-value"]===`${q.id}::indexed-C`);
 expect(chooseC).toBeDefined();expect(props(chooseC).disabled).not.toBe(true);
 await act(async()=>{props(chooseC).onClick();await flushMicrotasks();});
 expect(state.bucket).toBe(bucketKey(q.id,"indexed-C"));expect(state.activeProjectId).toBe(q.id);
 const newerSelection=state.bucket;
 if(delayResolution){await act(async()=>{releaseResolution();await pendingOpen;await flushMicrotasks();});expect(state.bucket).toBe(bucketKey(p.id,"disk-B"));expect(state.activeProjectId).toBe(p.id);expect(state.view.viewMode).toBe("chat");}
 else{expect(state.bucket).toBe(bucketKey(q.id,"indexed-C"));}
 // Re-selecting C after completion is a working local recovery, without a model.
 await act(async()=>{state.navigation.handleSelectSession(q.id,"indexed-C");await flushMicrotasks();});expect(state.bucket).toBe(bucketKey(q.id,"indexed-C"));
 // Releasing the real background import completes normally; it does not force selection.
 await act(async()=>{releaseCatalog();await flushMicrotasks();});
 await until(()=>catalogFinished&&state.diskSessionCatalog.initialized);
 expect(state.bucket).toBe(bucketKey(q.id,"indexed-C"));
 expect(state.diskSessionCatalog.loading).toBe(false);
 console.log(JSON.stringify({delayResolution,coreResumed:{sessionId:resumed.state.sessionId,kind:resumed.state.kind,origin:resumed.state.origin,title:resumed.state.title,transcriptMessages:resumed.transcript.toMessages().length},backgroundImport:{request:catalogCalls[0].options,finished:state.diskSessionCatalog.initialized},nativeTarget:targets[0],resolution:calls[0],newerSelection,lateSelection:delayResolution?bucketKey(p.id,"disk-B"):newerSelection,recovered:state.bucket}));
}
test("CONFIRMED delayed real disk-session open replaces a later global-search selection",()=>scenario(true));
test("CONTROL completed disk-session open followed by global search keeps the later selection",()=>scenario(false));
