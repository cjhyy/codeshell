import React, { act } from "react";
import { afterEach, expect, test } from "bun:test";
import { createRoot } from "../../../../packages/web/node_modules/react-dom/client.js";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../../../../packages/web/src/test-utils/renderHook.tsx";
import { useHubController } from "../../../../packages/web/app/useHubController.tsx";
import { Workbench } from "../../../../packages/web/app/Workbench.tsx";
import { useRemoteApp } from "../../../../packages/web/src/hooks/useRemoteApp.ts";
import { useDesktopController } from "../../../../packages/web/app/DesktopApp.tsx";
import { setApiProject,setApiWorkspace } from "../../../../packages/web/app/api-context.ts";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const originalFetch=globalThis.fetch;

class MemoryStorage {
  values=new Map<string,string>([["cs.deviceId","device"],["cs.deviceSecret","secret"],["cs.deviceName","Fixture"]]);
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
class Socket {
  static CONNECTING=0; static OPEN=1; static CLOSED=3; static instances:Socket[]=[];
  static respond:((message:any)=>any)|undefined;
  readyState=0;sent:any[]=[];onopen?:()=>void;onclose?:(event:{code:number})=>void;onerror?:()=>void;onmessage?:(event:{data:string})=>void;
  constructor(readonly url:string){Socket.instances.push(this);}
  send(raw:string){const message=JSON.parse(raw);this.sent.push(message);const response=Socket.respond?.(message);if(response!==undefined)queueMicrotask(()=>this.message(response));}
  open(){this.readyState=1;this.onopen?.();}
  close(){this.readyState=3;this.onclose?.({code:1000});}
  message(message:any){this.onmessage?.({data:JSON.stringify(message)});}
}
const cleanup:Array<()=>void|Promise<void>>=[];
function property(target:object,key:string,value:any){const old=Object.getOwnPropertyDescriptor(target,key);Object.defineProperty(target,key,{configurable:true,writable:true,value});cleanup.push(()=>{if(old)Object.defineProperty(target,key,old);else Reflect.deleteProperty(target,key);});}
const configuration={workspace:{path:"/fixture",settingsScope:"local",skillDirectories:[]},defaults:{},connections:[],catalog:[],skills:[],mcpServers:[],restartRequired:false};
let managedSessions:any[]=[];
function setup(mobile=false,origin="http://fixture.invalid"){
  ensureMiniDom();Socket.instances=[];Socket.respond=undefined;managedSessions=[];setApiProject(null);setApiWorkspace(undefined);
  property(globalThis,"WebSocket",Socket);const storage=new MemoryStorage();property(globalThis,"localStorage",storage);property(window,"localStorage",storage);
  let location=new URL(mobile?`${origin}/mobile/`:`${origin}/`);
  for(const target of [window,globalThis]){const old=Object.getOwnPropertyDescriptor(target,"location");Object.defineProperty(target,"location",{configurable:true,get:()=>location});cleanup.push(()=>{if(old)Object.defineProperty(target,"location",old);else Reflect.deleteProperty(target,"location");});}
  property(window,"history",{state:null,replaceState(_state:any,_title:any,url:any){location=new URL(String(url),location);}});
  property(window,"matchMedia",()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  property(globalThis,"fetch",(async(url:any)=>{const path=String(url);if(path.includes("/api/v1/configuration"))return Response.json(configuration);if(path.includes("/api/v1/sessions"))return Response.json({sessions:managedSessions,nextCursor:null});if(path.includes("/api/v1/environment"))return Response.json({error:"no environment fixture"},{status:404});throw new Error(`Network forbidden: ${path}`);}) as typeof fetch);property(window,"fetch",globalThis.fetch);
}
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();setApiProject(null);setApiWorkspace(undefined);});
async function hub(workbench=false){
  setup();let current:any;let unmount:()=>Promise<void>;
  if(workbench){const container=document.createElement("div");document.body.appendChild(container);const root=createRoot(container);function Harness(){current=useHubController({hub:true});return <Workbench controller={current}/>;}await act(async()=>{root.render(<Harness/>);await flushMicrotasks();});unmount=async()=>{await act(async()=>root.unmount());container.parentNode?.removeChild(container);};}
  else {const hook=await renderHook(()=>useHubController({hub:true}));current=hook.result;unmount=()=>hook.unmount();}
  cleanup.push(unmount);const read=()=>workbench?current:current.current;
  const socket=Socket.instances[0];await act(async()=>{socket.open();await flushMicrotasks();});return{read,socket,unmount};
}
async function mobile(){
  setup(true);const hook=await renderHook(()=>{const app=useRemoteApp();return{app,controller:useDesktopController(app,undefined,()=>{})};});cleanup.push(()=>hook.unmount());const socket=Socket.instances[0];await act(async()=>{socket.open();socket.message({type:"auth.ok",device:{id:"device",name:"Fixture"}});await flushMicrotasks();hook.result.current.controller.selectSession("native");await flushMicrotasks();});return{hook,socket};
}
const flush=async()=>{for(let i=0;i<6;i++)await flushMicrotasks();};
const beforeUnload=()=>{const event=new Event("beforeunload",{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;};

test("normal: Hub rejected pre-admission request restores the original draft and allows retry",async()=>{
  const f=await hub();await act(async()=>{f.read().setDraft("original failed task");await flush();});
  await act(async()=>{expect(f.read().send()).toBe(true);await flush();});const run=f.socket.sent.find(frame=>frame.method==="agent/run");
  await act(async()=>{f.socket.message({id:run.id,error:{code:-32009,message:"配置正在保存，请稍后重新发送任务。"}});await flush();});
  expect(f.read().draft).toBe("original failed task");expect(f.read().hasUnsent).toBe(true);expect(f.read().chat.items.some((item:any)=>item.kind==="user")).toBe(false);expect(f.read().error).toContain("内容和附件已恢复");
  await act(async()=>{expect(f.read().send()).toBe(true);await flush();});const retry=f.socket.sent.filter(frame=>frame.method==="agent/run").at(-1);expect(retry.params.task).toBe("original failed task");
  await act(async()=>{f.socket.message({id:retry.id,error:{code:-32009,message:"fixture still saving"}});await flush();});
});

test("confirmed: a newer draft makes the rejected Hub submission disappear from both draft and message history",async()=>{
  const f=await hub();await act(async()=>{f.read().setDraft("original important task");await flush();});
  await act(async()=>{f.read().send();await flush();});const run=f.socket.sent.find(frame=>frame.method==="agent/run");
  await act(async()=>{f.read().setDraft("a later follow-up draft");await flush();});
  await act(async()=>{f.socket.message({id:run.id,error:{code:-32009,message:"配置正在保存，请稍后重新发送任务。"}});await flush();});
  expect(f.read().draft).toBe("a later follow-up draft");expect(f.read().localDrafts.map((item:any)=>item.draft.text)).toEqual(["a later follow-up draft"]);expect(f.read().chat.items.some((item:any)=>item.kind==="user"&&item.text==="original important task")).toBe(false);
  console.log("HUB_FAILED_SUBMISSION_LOST",JSON.stringify({newerDraftPreserved:true,originalInDrafts:false,originalInChat:false,accepted:false}));
});

test("normal: paired send rejection restores unchanged text, but a newly typed follow-up loses the rejected text",async()=>{
  const f=await mobile();await act(async()=>{f.hook.result.current.controller.setDraft("first task");await flush();});await act(async()=>{expect(f.hook.result.current.controller.send()).toBe(true);await flush();});
  let frame=f.socket.sent.filter(frame=>frame.type==="chat.send").at(-1);await act(async()=>{f.socket.message({type:"error",message:"worker rejected before queue",clientMessageId:frame.clientMessageId});await flush();});
  expect(f.hook.result.current.controller.draft).toBe("first task");
  await act(async()=>{expect(f.hook.result.current.controller.send()).toBe(true);await flush();});frame=f.socket.sent.filter(frame=>frame.type==="chat.send").at(-1);
  await act(async()=>{f.hook.result.current.controller.setDraft("newer task");await flush();});
  await act(async()=>{f.socket.message({type:"error",message:"worker rejected before queue",clientMessageId:frame.clientMessageId});await flush();});
  expect(f.hook.result.current.controller.draft).toBe("newer task");expect(f.hook.result.current.app.chat.items.some(item=>item.kind==="user"&&item.text==="first task")).toBe(false);expect(f.hook.result.current.controller.localDrafts).toHaveLength(0);expect(f.hook.result.current.controller.error).toContain("内容和附件已保留");
  console.log("PAIRED_FAILED_SUBMISSION_LOST",JSON.stringify({newerDraftPreserved:true,originalInDrafts:false,originalInChat:false,claimedPreserved:true,accepted:false}));
});

test("confirmed: an uncertain unsent Hub submission has no beforeunload protection and is lost on reload",async()=>{
  const f=await hub(true);await act(async()=>{f.read().setDraft("not delivered task to retain");await flush();});expect(beforeUnload()).toBe(true);
  await act(async()=>{expect(f.read().send()).toBe(true);await flush();});
  await act(async()=>{f.socket.close();await flush();});
  expect(f.read().uncertain).toBe(true);expect(f.read().hasUnsent).toBe(false);expect(f.read().uploadBusy).toBe(false);expect(beforeUnload()).toBe(false);
  await f.unmount();cleanup.pop();
  const hook=await renderHook(()=>useHubController({hub:true}));cleanup.push(()=>hook.unmount());const socket=Socket.instances.at(-1)!;
  Socket.respond=(request:any)=>request.params?.type==="session_detail"?{id:request.id,error:{code:-32001,message:`Session not found: ${request.params.sessionId}`}}:undefined;
  await act(async()=>{socket.open();await flush();});
  expect(hook.result.current.draft).toBe("");expect(hook.result.current.localDrafts).toHaveLength(0);expect(hook.result.current.chat.items).toHaveLength(0);expect(hook.result.current.uncertain).toBe(false);
  console.log("UNCERTAIN_RELOAD_LOSS",JSON.stringify({normalDraftGuard:true,uncertain:true,uncertainUnloadGuard:false,afterReloadDraft:"",afterReloadLocalDraftCount:0,serverAccepted:false}));
});

test("normal: stopping an accepted Hub run releases the send guard and preserves an independently typed next draft",async()=>{
  const f=await hub();await act(async()=>{f.read().setDraft("task to cancel");await flush();});await act(async()=>{f.read().send();await flush();});const run=f.socket.sent.find(frame=>frame.method==="agent/run"),sessionId=run.params.sessionId;
  await act(async()=>{f.socket.message({method:"agent/runAccepted",params:{sessionId,requestId:run.id}});f.socket.message({method:"serve/sessionStatus",params:{sessionId,running:true}});f.socket.message({method:"agent/streamEvent",params:{sessionId,event:{type:"stream_request_start"}}});f.read().setDraft("next task after stop");await flush();});
  await act(async()=>{f.read().stop();await flush();});const cancel=f.socket.sent.find(frame=>frame.method==="agent/cancel");expect(cancel.params.sessionId).toBe(sessionId);
  await act(async()=>{f.socket.message({id:cancel.id,result:{cancelled:true}});f.socket.message({method:"agent/streamEvent",params:{sessionId,event:{type:"turn_complete",reason:"aborted_streaming"}}});f.socket.message({method:"serve/sessionStatus",params:{sessionId,running:false}});f.socket.message({id:run.id,result:{reason:"aborted_streaming",text:"",turnCount:0}});await flush();});
  expect(f.read().running).toBe(false);expect(f.read().draft).toBe("next task after stop");
  await act(async()=>{expect(f.read().send()).toBe(true);await flush();});const next=f.socket.sent.filter(frame=>frame.method==="agent/run").at(-1);expect(next.params.task).toBe("next task after stop");
  await act(async()=>{f.socket.message({id:next.id,error:{code:-32009,message:"fixture end"}});await flush();});
});

test("normal: a model error after acceptance retains the user turn and allows a new task once the real run ends",async()=>{
  const f=await hub();await act(async()=>{f.read().setDraft("accepted task");await flush();});await act(async()=>{f.read().send();await flush();});const run=f.socket.sent.find(frame=>frame.method==="agent/run"),sessionId=run.params.sessionId;
  await act(async()=>{f.socket.message({method:"agent/runAccepted",params:{sessionId}});f.socket.message({method:"serve/sessionStatus",params:{sessionId,running:true}});f.socket.message({method:"agent/streamEvent",params:{sessionId,event:{type:"error",error:"fixture provider temporarily unavailable"}}});f.socket.message({method:"agent/streamEvent",params:{sessionId,event:{type:"turn_complete",reason:"model_error"}}});f.socket.message({method:"serve/sessionStatus",params:{sessionId,running:false}});f.socket.message({id:run.id,result:{reason:"model_error",text:"",turnCount:0}});await flush();});
  expect(f.read().running).toBe(false);expect(f.read().chat.items.some((item:any)=>item.kind==="system_error"&&item.text.includes("temporarily unavailable"))).toBe(true);expect(f.read().chat.items.some((item:any)=>item.kind==="user"&&item.text==="accepted task")).toBe(true);
  await act(async()=>{f.read().setDraft("retry explicitly");await flush();});await act(async()=>{expect(f.read().send()).toBe(true);await flush();});const next=f.socket.sent.filter(frame=>frame.method==="agent/run").at(-1);await act(async()=>{f.socket.message({id:next.id,error:{code:-32009,message:"fixture end"}});await flush();});
});

test("normal: opening another history session ignores an earlier delayed detail and preserves both drafts",async()=>{
  const f=await hub();managedSessions=[{sessionId:"history-a",cwd:"/fixture",startedAt:1,status:"completed",model:"fixture",turnCount:1},{sessionId:"history-b",cwd:"/fixture",startedAt:2,status:"completed",model:"fixture",turnCount:1}];
  await act(async()=>{await f.read().refreshSessions();await flush();});
  Socket.respond=(request:any)=>{if(request.method!=="agent/query")return;if(request.params.type==="output_journal")return{id:request.id,error:{code:-32602,message:"Unknown query type: output_journal"}};if(request.params.type==="session_detail"&&request.params.sessionId==="history-b")return{id:request.id,result:{type:"session_detail",data:{state:managedSessions[1],transcript:[{message:{role:"assistant",content:"B saved reply"}}],running:false}}};};
  let openingA!:Promise<void>;
  await act(async()=>{openingA=f.read().selectSession("history-a");await flush();});
  const queryA=f.socket.sent.filter(frame=>frame.params?.type==="session_detail").at(-1);
  await act(async()=>{f.read().setDraft("A unsent draft");await flush();});
  await act(async()=>{await f.read().selectSession("history-b");await flush();});
  await act(async()=>{f.read().setDraft("B unsent draft");f.socket.message({id:queryA.id,result:{type:"session_detail",data:{state:managedSessions[0],transcript:[{message:{role:"assistant",content:"A late reply"}}],running:false}}});await openingA;await flush();});
  expect(f.read().activeId).toBe("history-b");expect(f.read().draft).toBe("B unsent draft");expect(f.read().chat.items.filter((item:any)=>item.kind==="assistant").map((item:any)=>item.text)).toEqual(["B saved reply"]);
  Socket.respond=(request:any)=>request.params?.type==="output_journal"?{id:request.id,error:{code:-32602,message:"Unknown query type: output_journal"}}:request.params?.type==="session_detail"?{id:request.id,result:{type:"session_detail",data:{state:managedSessions[0],transcript:[],running:false}}}:undefined;
  await act(async()=>{await f.read().selectSession("history-a");await flush();});expect(f.read().draft).toBe("A unsent draft");
});

test("normal: paired native Stop targets the bound session, clears a terminal synchronous approval and permits the retained next draft",async()=>{
  const f=await mobile();
  await act(async()=>{f.socket.message({method:"agent/streamEvent",params:{sessionId:"native",event:{type:"stream_request_start"}}});f.socket.message({method:"agent/approvalRequest",params:{sessionId:"native",requestId:"blocking",request:{toolName:"Bash",args:{command:"fixture"},description:"fixture"}}});f.hook.result.current.controller.setDraft("retained next task");await flush();});
  expect(f.hook.result.current.controller.running).toBe(true);
  await act(async()=>{f.hook.result.current.controller.stop();await flush();});expect(f.socket.sent.filter(frame=>frame.type==="run.stop").at(-1)).toEqual({type:"run.stop",sessionId:"native"});
  await act(async()=>{f.socket.message({method:"agent/streamEvent",params:{sessionId:"native",event:{type:"turn_complete",reason:"aborted_streaming"}}});await flush();});
  expect(f.hook.result.current.controller.running).toBe(false);expect(f.hook.result.current.controller.approvals).toHaveLength(0);expect(f.hook.result.current.controller.draft).toBe("retained next task");
  await act(async()=>{expect(f.hook.result.current.controller.send()).toBe(true);await flush();});const sent=f.socket.sent.filter(frame=>frame.type==="chat.send").at(-1);await act(async()=>{f.socket.message({type:"chat.accepted",clientMessageId:sent.clientMessageId,sessionId:"native"});await flush();});
});

test("confirmed with a real authenticated Hub: a dropped pre-host submission loses its only intent copy on unguarded reload",async()=>{
  property(globalThis,"fetch",async()=>{throw new Error("Core import network disabled");});
  const {startHeadlessServer}=await import("../../../../packages/server/src/serve/headless-server.ts");
  const {WebSocket:NativeSocket}=await import("ws");
  const directory=mkdtempSync(join(tmpdir(),"codeshell-review-20261012-web-round5-hub-"));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));const worker=join(directory,"never-called-worker.cjs");writeFileSync(worker,"process.stdin.resume();\n");
  const host=await startHeadlessServer({cwd:directory,dataDir:join(directory,"host"),workerEntryPath:worker,authMode:"hub",port:0});cleanup.push(()=>host.close());const origin=host.url;
  let cookie="";const exactFetch=(async(input:any,init?:RequestInit)=>{const url=new URL(String(input),origin);if(url.origin!==origin)throw new Error("Nonfixture network forbidden");const headers=new Headers(init?.headers);headers.set("Origin",origin);if(cookie)headers.set("Cookie",cookie);return originalFetch(url,{...init,headers});}) as typeof fetch;
  const response=await exactFetch(`${origin}/api/v1/auth/setup`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:host.bootstrapToken,username:"fixture",password:"fixture-only-password",deviceName:"Review"})});expect(response.status).toBe(200);cookie=response.headers.get("set-cookie")!.split(";",1)[0];
  setup(false,origin);property(globalThis,"fetch",exactFetch);property(window,"fetch",exactFetch);
  let dropped=0;let current:any;
  class BrowserSocket {
    static OPEN=1;static CONNECTING=0;static CLOSED=3;
    readonly real:any;onopen?:()=>void;onclose?:(e:{code:number})=>void;onmessage?:(e:{data:string})=>void;onerror?:()=>void;
    get readyState(){return this.real.readyState;}
    constructor(url:string){if(new URL(url).origin!==origin.replace(/^http/,"ws"))throw new Error("Nonfixture WS forbidden");this.real=new NativeSocket(url,{headers:{Origin:origin,Cookie:cookie}});this.real.on("open",()=>act(()=>this.onopen?.()));this.real.on("message",(data:any)=>act(()=>this.onmessage?.({data:String(data)})));this.real.on("close",(code:number)=>act(()=>this.onclose?.({code})));this.real.on("error",()=>act(()=>this.onerror?.()));}
    send(raw:string){if(JSON.parse(raw).method==="agent/run"){dropped++;queueMicrotask(()=>this.real.terminate());return;}this.real.send(raw);}
    close(){this.real.close();}
  }
  property(globalThis,"WebSocket",BrowserSocket);
  const waitFor=async(check:()=>boolean)=>{for(let index=0;index<400;index++){if(check())return;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));await flush();});}throw new Error("real Hub fixture did not settle");};
  const container=document.createElement("div");document.body.appendChild(container);const root=createRoot(container);let mounted=true;const unmount=async()=>{if(!mounted)return;mounted=false;await act(async()=>root.unmount());container.parentNode?.removeChild(container);};cleanup.push(unmount);
  function Harness(){current=useHubController({hub:true});return <Workbench controller={current}/>;}
  await act(async()=>{root.render(<Harness/>);await flush();});await waitFor(()=>current?.connection==="open");
  await act(async()=>{current.setDraft("undelivered original intent");await flush();});expect(beforeUnload()).toBe(true);
  await act(async()=>{expect(current.send()).toBe(true);await flush();});await waitFor(()=>current.uncertain===true);expect(dropped).toBe(1);expect(beforeUnload()).toBe(false);
  const beforeReload=await(await exactFetch(`${origin}/api/v1/sessions`)).json();expect(beforeReload.sessions).toEqual([]);
  await unmount();
  const hook=await renderHook(()=>useHubController({hub:true}));cleanup.push(()=>hook.unmount());await waitFor(()=>hook.result.current.connection==="open");
  expect(hook.result.current.draft).toBe("");expect(hook.result.current.localDrafts).toEqual([]);expect(hook.result.current.chat.items).toEqual([]);const afterReload=await(await exactFetch(`${origin}/api/v1/sessions`)).json();expect(afterReload.sessions).toEqual([]);
  console.log("REAL_HUB_UNCERTAIN_RELOAD_LOSS",JSON.stringify({authenticated:true,submissionFramesDroppedBeforeHost:dropped,durableSessionsBeforeReload:beforeReload.sessions.length,durableSessionsAfterReload:afterReload.sessions.length,unloadGuardWhileUncertain:false,reloadedIntentCopies:0,modelRequests:0}));
});
