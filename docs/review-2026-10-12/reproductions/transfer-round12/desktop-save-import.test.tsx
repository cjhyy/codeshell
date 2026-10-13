import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const deny=()=>{throw Error("NETWORK_FORBIDDEN_round12");};
globalThis.fetch=deny as any;http.request=http.get=deny as any;https.request=https.get=deny as any;net.connect=net.createConnection=deny as any;tls.connect=deny as any;
if(!process.env.CODE_SHELL_TEST_HOME||!process.env.HOME?.includes("codeshell-bun-completion-"))throw Error("guarded HOME required");
const repo = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
import React,{act} from "react";
import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const {createRoot}=await import(`${repo}/packages/desktop/node_modules/react-dom/client`);
const {ensureMiniDom,flushMicrotasks}=await import(`${repo}/packages/desktop/src/renderer/test-utils/renderHook`);
ensureMiniDom();
const {Lightbox}=await import(`${repo}/packages/desktop/src/renderer/chat/Lightbox`);
const {ToastProvider}=await import(`${repo}/packages/desktop/src/renderer/ui/ToastProvider`);
const {useAutomationSessionImport}=await import(`${repo}/packages/desktop/src/renderer/app/useAutomationSessionImport`);
const {useTrackedProjects}=await import(`${repo}/packages/desktop/src/renderer/app/useTrackedProjects`);
const {saveProjects,trackedProjectFromRegistry,__resetProjectSnapshotForTest}=await import(`${repo}/packages/desktop/src/renderer/projects`);
const {saveSessionIndex,loadSessionIndex,saveTranscript,loadTranscript}=await import(`${repo}/packages/desktop/src/renderer/transcripts`);
const {foldTranscript}=await import(`${repo}/packages/desktop/src/renderer/automation/foldTranscript`);
const {SessionManager}=await import(`${repo}/packages/core/src/session/session-manager`);
const {SessionCwdIndex}=await import(`${repo}/packages/desktop/src/main/session-cwd-index`);
const {ProjectStore}=await import(`${repo}/packages/desktop/src/main/project-store`);
const {listDiskSessions}=await import(`${repo}/packages/server/src/sessions-service`);
let root:any,container:any,temporary="";
function nodes(n:any):any[]{return[n,...Array.from(n?.childNodes??[]).flatMap(nodes)];}
function props(n:any):any{const k=Object.keys(n).find(k=>k.startsWith("__reactProps$"));return k?n[k]:{};}
function label(n:any):string{const p=props(n);return p["aria-label"]??p.title??"";}
function text(n:any):string{if(n.nodeType===3)return n.data;return Array.from(n.childNodes??[]).map(text).join("")||(typeof props(n).children==="string"?props(n).children:"");}
const settle=async()=>{await flushMicrotasks();await new Promise(r=>setTimeout(r,0));await flushMicrotasks();};
async function until(fn:()=>boolean){const end=Date.now()+2000;while(!fn()){if(Date.now()>end)throw Error("fixture wait timeout");await act(settle);}}
async function mount(component:any){container=document.createElement("div");document.body.appendChild(container);root=createRoot(container);await act(async()=>{root.render(component);await settle();});}
async function click(pattern:RegExp){const button=nodes(document.body).find(n=>n.tagName==="BUTTON"&&pattern.test(label(n)));expect(button).toBeDefined();await act(async()=>{props(button).onClick();await settle();});}
afterEach(async()=>{if(root)await act(async()=>{root.unmount();await settle();});root=undefined;if(container?.parentNode)container.parentNode.removeChild(container);container=undefined;__resetProjectSnapshotForTest();if(temporary)rmSync(temporary,{recursive:true,force:true});temporary="";});

test("CONTROL actual Lightbox cancels quietly, reports save failure, and retries the current image",async()=>{
 const a="data:image/png;base64,YQ==",b="data:image/png;base64,Yg==";const calls:any[]=[];let outcome:any=null;
 Object.defineProperty(window,"codeshell",{configurable:true,value:{saveImage:async(src,options)=>{calls.push({src,options});if(outcome instanceof Error)throw outcome;if(typeof outcome==="function")return outcome();return outcome;}}});
 await mount(<ToastProvider><Lightbox src={a} alt="first" onClose={()=>{}} items={[{src:a,alt:"first",name:"first.png"},{src:b,alt:"second",name:"second.png"}]}/></ToastProvider>);
 await click(/^下载$|^Download$/);expect(calls).toEqual([{src:a,options:{name:"first.png"}}]);expect(text(document.body)).not.toMatch(/图片已保存|Image saved|保存失败|Save failed/);
 outcome=new Error("controlled destination write refusal");await click(/^下载$|^Download$/);expect(text(document.body)).toMatch(/保存失败|Save failed/);
 expect(nodes(document.body).filter(n=>n.tagName==="IMG").some(n=>props(n).src===a)).toBe(true);
 await click(/下一|Next/);expect(nodes(document.body).filter(n=>n.tagName==="IMG").some(n=>props(n).src===b)).toBe(true);
 let resolveSave:any;outcome=()=>new Promise(r=>resolveSave=r);await click(/^下载$|^Download$/);
 expect(calls.at(-1)).toEqual({src:b,options:{name:"second.png"}});
 await click(/上一|Prev/);
 await act(async()=>{resolveSave("/owned-fixture-destination/second.png");await settle();});
 expect(text(document.body)).toMatch(/图片已保存|Image saved/);
 expect(calls.at(-1).src).toBe(b);expect(nodes(document.body).filter(n=>n.tagName==="IMG").some(n=>props(n).src===a)).toBe(true);
 console.log(JSON.stringify({control:"lightbox-save",cancelledDidNotToastSuccess:true,failureVisible:true,retryPayload:"second.png",navigationWhilePendingPreservedPayload:true,scope:"actual React Lightbox/ToastProvider; native save dialog/fs bridge replaced with controlled replies"}));
});

test("CONTROL initial disk import failure retains known history and retries real persisted sessions without hydrating transcripts",async()=>{
 temporary=realpathSync(mkdtempSync(join(tmpdir(),"codeshell-transfer-import-")));const cwd=join(temporary,"project"),sessionsRoot=join(temporary,"sessions");mkdirSync(cwd);
 const manager=new SessionManager(sessionsRoot);const b=manager.create(cwd,"fixture-model","fixture-provider","disk-owned",null,"desktop");b.transcript.appendMessage("user","Persisted B");manager.updateSessionState("disk-owned",{title:"Persisted B",status:"completed"});
 const cwdIndex=new SessionCwdIndex({sessionsRoot});await cwdIndex.ensureLoaded();
 const store=new ProjectStore({file:join(temporary,"projects.json"),recentsFile:join(temporary,"recents.json"),migrationMarkerFile:join(temporary,"migration.json"),sessionIndex:cwdIndex,noRepoPath:join(temporary,"no-repo")});const project=await store.createFromPath(cwd);
 const values=new Map<string,string>();Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});
 __resetProjectSnapshotForTest();saveProjects([trackedProjectFromRegistry(project)]);
 const live=foldTranscript([{kind:"user",text:"Unchanged loaded A",timestamp:1}]);
 saveSessionIndex(project.id,{sessions:[{id:"known-A",title:"Known A",createdAt:1,updatedAt:1}],activeSessionId:"known-A"});saveTranscript(project.id,"known-A",live);
 let calls=0,transcriptReads=0;const logs:any[]=[];
 Object.defineProperty(window,"codeshell",{configurable:true,value:{log:(...args)=>logs.push(args),listRuns:async()=>[],listDiskSessions:async(options)=>{calls++;if(calls===1)throw Error("controlled initial catalog failure");return listDiskSessions(options,sessionsRoot);},getSessionTranscript:async()=>{transcriptReads++;throw Error("must not hydrate during import");},projectRegistry:{resolveForCwdBatch:(cwds,source)=>store.resolveProjectForCwdBatch(cwds,source)}}});
 let state:any;
 function Host(){const [,setProjects]=useTrackedProjects();const[indices,setSessionIndices]=React.useState({[project.id]:loadSessionIndex(project.id)});const ref=React.useRef(indices);ref.current=indices;const catalog=useAutomationSessionImport({sessionIndicesRef:ref,setSessionIndices,setProjects});state={indices,catalog};return <div/>;}
 await mount(<Host/>);await until(()=>state.catalog.diskSessionCatalog.initialized);
 expect(state.catalog.diskSessionCatalog).toEqual({initialized:true,loading:false,nextCursor:""});expect(state.indices[project.id].sessions.map(s=>s.id)).toEqual(["known-A"]);expect(logs.some(v=>v[0]==="sidebar.disk_catalog_page_failed")).toBe(true);
 await act(async()=>{await state.catalog.loadDiskSessionCatalogPage(state.catalog.diskSessionCatalog.nextCursor||undefined);await settle();});
 expect(calls).toBe(2);expect(state.catalog.diskSessionCatalog).toEqual({initialized:true,loading:false,nextCursor:null});expect(state.indices[project.id].sessions.map(s=>s.id)).toContain("disk-owned");expect(state.indices[project.id].activeSessionId).toBe("known-A");
 expect(loadTranscript(project.id,"known-A")).toEqual(live);expect(transcriptReads).toBe(0);
 expect(new SessionManager(sessionsRoot).resume("disk-owned").transcript.toMessages().some(m=>m.content==="Persisted B")).toBe(true);
 console.log(JSON.stringify({control:"disk-import-retry",initialRetryCursor:"",retriedWithActualService:true,knownSelectionPreserved:true,liveSnapshotPreserved:true,transcriptReads}));
});
