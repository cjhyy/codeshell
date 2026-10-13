import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const isolation = await import(repo + '/scripts/runtime-cost-smoke-isolation.mjs');
isolation.installLocalNetworkGuard('http://127.0.0.1:9');
const { default: React, act } = await import(repo + '/node_modules/react/index.js');
const { createRoot } = await import(repo + '/packages/web/node_modules/react-dom/client.js');
const { ensureMiniDom, flushMicrotasks } = await import(repo + '/packages/web/src/test-utils/renderHook.tsx');
const { useRemoteApp } = await import(repo + '/packages/web/src/hooks/useRemoteApp.ts');
const { DesktopApproval } = await import(repo + '/packages/web/app/DesktopControls.tsx');
const { ApprovalBridge } = await import(repo + '/packages/desktop/src/main/cc-room/approval-bridge.ts');
const { RoomManager } = await import(repo + '/packages/server/src/mobile-remote/room-manager.ts');
const { ResidentAgentProcess } = await import(repo + '/packages/server/src/mobile-remote/resident-agent.ts');
const { AgentServer } = await import(repo + '/packages/core/src/protocol/server.ts');
const { PendingMobileApprovals } = await import(repo + '/packages/server/src/mobile-remote/pending-approvals.ts');
const { injectAndAwaitResult } = await import(repo + '/packages/desktop/src/main/mobile-remote/handle-client-event.ts');

class Socket {
  static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
  static instances: Socket[]=[];
  readyState=0; sent: any[]=[]; onopen:any; onclose:any; onerror:any; onmessage:any;
  constructor(readonly url:string) { Socket.instances.push(this); }
  send(raw:string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState=1; this.onopen?.(); }
  close() { this.readyState=3; this.onclose?.(); }
  message(value:any) { this.onmessage?.({data:JSON.stringify(value)}); }
}
const disposals: Array<()=>any>=[];
function prop(o:any,k:string,v:any) {
  const previous=Object.getOwnPropertyDescriptor(o,k);
  Object.defineProperty(o,k,{configurable:true,writable:true,value:v});
  disposals.push(()=>previous?Object.defineProperty(o,k,previous):Reflect.deleteProperty(o,k));
}
function props(n:any):any { return n[Object.keys(n).find(k=>k.startsWith('__reactProps$'))!]; }
function all(n:any):any[] { return [n,...(n.childNodes??[]).flatMap(all)]; }
async function wait(f:()=>boolean) {
  const end=Date.now()+1800;
  while(!f()) { if(Date.now()>end) throw Error('fixture wait timed out'); await act(async()=>{await new Promise(r=>setTimeout(r,5));}); }
}
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse()) await dispose();});

async function fixture(input:any={command:'pwd'},toolName='Bash',timeoutMs=5000) {
  ensureMiniDom(); Socket.instances=[];
  const storage=new Map([['cs.deviceId','fixture-device'],['cs.deviceSecret','fixture-secret'],['cs.deviceName','Fixture']]);
  prop(globalThis,'localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});
  prop(globalThis,'WebSocket',Socket);
  prop(window,'location',{origin:'http://127.0.0.1:9',search:'',pathname:'/mobile/'});
  prop(window,'history',{replaceState(){}});
  const folder=mkdtempSync(join(tmpdir(),'approval-quality-'));
  const received=join(folder,'control.json');
  const executable=join(folder,'cli-fixture');
  // Pure local stdio protocol fixture: no packages, accounts, transports, models, or real CLI.
  writeFileSync(executable, '#!/usr/bin/env node\n'+
    "const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin});\n"+
    'const pending='+JSON.stringify({type:'control_request',request_id:'control-1',request:{subtype:'can_use_tool',tool_name:toolName,input}})+';\n'+
    "rl.on('line',line=>{const value=JSON.parse(line);if(value.type==='user'){console.log(JSON.stringify(pending));}else if(value.type==='control_response'){fs.writeFileSync("+JSON.stringify(received)+",line);console.log(JSON.stringify({type:'result',subtype:'success'}));}});\n");
  chmodSync(executable,0o700);
  const container=document.createElement('div'); const root=createRoot(container);
  let app:any;
  function View(){app=useRemoteApp();return React.createElement(React.Fragment,null,...app.approvals.map((approval:any)=>React.createElement(DesktopApproval,{key:approval.requestId,approval,app})));}
  await act(async()=>{root.render(React.createElement(View));await flushMicrotasks();});
  const socket=Socket.instances[0]!;
  await act(async()=>{socket.open();socket.message({type:'auth.ok',device:{id:'fixture-device',name:'Fixture'}});await flushMicrotasks();});
  let manager:any;
  const settlements: Promise<any>[]=[];
  const bridge=new ApprovalBridge({timeoutMs,onPush:(roomId:string,req:any)=>socket.message({type:'ccRoom.approvalRequest',roomId,req}),onResolve:(roomId:string,requestId:string)=>socket.message({type:'ccRoom.approvalResolved',roomId,requestId})});
  manager=new RoomManager({rootDir:join(folder,'rooms'),createAgent:(room:any,onEvent:any)=>new ResidentAgentProcess({command:executable,cwd:folder,permissionMode:'default',onEvent}),onMessage(){},onApprovalRequest:(roomId:string,request:any)=>settlements.push(bridge.request(roomId,request.requestId,request).then((decision:any)=>manager.respondApproval(roomId,request.requestId,decision))),onRoomEnded:(roomId:string)=>bridge.cancelRoom(roomId)});
  const room=manager.createRoom({cwd:folder});
  const opened=()=>socket.message({type:'ccRoom.opened',roomId:room.id,sessionId:'cli-fixture-session',status:'running'});
  await act(async()=>{socket.message({type:'room.list.ok',rooms:[room]});opened();await flushMicrotasks();});
  manager.open(room.id);manager.send(room.id,'one local protocol turn');
  await wait(()=>app.approvals.length===1);
  disposals.push(async()=>{manager.closeAll();bridge.cancelRoom(room.id);await Promise.allSettled(settlements);await act(async()=>{root.unmount();await flushMicrotasks();});rmSync(folder,{recursive:true,force:true});});
  return {get app(){return app;},container,socket,bridge,manager,room,received,opened,settlements};
}

test('R10: actual local resident stdio control remains unanswered after room restoration; explicit response recovers it',async()=>{
  const f=await fixture();
  expect(f.app.approvals).toHaveLength(1);
  expect(existsSync(f.received)).toBe(false);
  await act(async()=>{f.app.selectSession('native-fixture');await flushMicrotasks();f.opened();f.socket.message({type:'room.history.ok',roomId:f.room.id,latestSeq:1,messages:[{seq:1,ts:1,from:'agent',type:'approval',tool:'Bash',summary:'pwd'}]});await flushMicrotasks();});
  expect(f.app.approvals).toHaveLength(0);
  expect(existsSync(f.received)).toBe(false);
  await act(async()=>{expect(f.bridge.respond(f.room.id,'control-1',{behavior:'deny',message:'explicit fixture recovery'})).toBe(true);await flushMicrotasks();});
  await wait(()=>existsSync(f.received));
  expect(JSON.parse(readFileSync(f.received,'utf8')).response.response.behavior).toBe('deny');
});

test('R11 negative: actual offline approval buttons are disabled and the guarded handler preserves the card',async()=>{
  const f=await fixture();
  await act(async()=>{f.socket.close();await flushMicrotasks();});
  expect(f.app.status).toBe('offline');
  const allow=all(f.container).find(n=>n.tagName==='BUTTON'&&props(n)?.children==='允许');
  expect(props(allow).disabled).toBe(true);
  await act(async()=>{props(allow).onClick();await flushMicrotasks();});
  expect(f.app.approvals).toHaveLength(1);
  expect(existsSync(f.received)).toBe(false);
});

test('R11 restricted: actual enabled card drops when readyState starts closing before onclose updates online state',async()=>{
  const f=await fixture();
  const allow=all(f.container).find(n=>n.tagName==='BUTTON'&&props(n)?.children==='允许');
  expect(f.app.status).toBe('online');expect(props(allow).disabled).toBe(false);
  const sent=f.socket.sent.length;
  f.socket.readyState=Socket.CLOSING; // deterministic transport/event ordering seam; no claim of a live-browser capture.
  await act(async()=>{props(allow).onClick();await flushMicrotasks();});
  expect(f.socket.sent).toHaveLength(sent);expect(f.app.approvals).toHaveLength(0);
  expect(existsSync(f.received)).toBe(false);
  await act(async()=>{expect(f.bridge.respond(f.room.id,'control-1',{behavior:'deny',message:'fixture cleanup'})).toBe(true);await flushMicrotasks();});
  await wait(()=>existsSync(f.received));
});

test('R12: actual resident stdin gets one terminal response containing only first question answer',async()=>{
  const f=await fixture({questions:[{question:'Language?',options:[{label:'TypeScript'}]},{question:'Framework?',options:[{label:'React'}]}]},'AskUserQuestion');
  expect(f.app.approvals[0].description).toBe('Language?');
  expect(all(f.container).some(n=>props(n)?.children==='1. React')).toBe(false);
  expect(existsSync(f.received)).toBe(false);
  await act(async()=>{expect(f.bridge.respond(f.room.id,'control-1',{behavior:'allow',answer:'TypeScript'})).toBe(true);await flushMicrotasks();});
  await wait(()=>existsSync(f.received));
  const wire=JSON.parse(readFileSync(f.received,'utf8')).response;
  expect(wire.request_id).toBe('control-1');
  expect(wire.response.updatedInput.questions).toHaveLength(2);
  expect(wire.response.updatedInput.answers).toEqual({'Language?':'TypeScript'});
  expect(f.bridge.respond(f.room.id,'control-1',{behavior:'allow',answer:'React'})).toBe(false);
  expect(f.manager.respondApproval(f.room.id,'control-1',{behavior:'allow',answer:'React'})).toBe(false);
});

test('R19 boundary: held pre-processing delivery times out with a real Core approval still pending, snapshot recovers, normal delivery resolves immediately',async()=>{
  const f=await fixture();
  await act(async()=>{f.bridge.respond(f.room.id,'control-1',{behavior:'deny',message:'CC fixture done'});await flushMicrotasks();});
  await wait(()=>existsSync(f.received));
  await act(async()=>{f.app.selectSession('native-fixture');await flushMicrotasks();});
  const outbound=new Set<(line:string)=>void>(); const observed=new PendingMobileApprovals();
  const messages:any[]=[]; let deliver:any;
  const server=new AgentServer({engine:{isHeadless:()=>true} as any,ownsBackgroundWakeups:false,transport:{onMessage:(cb:any)=>{deliver=cb;},send:(message:any)=>{messages.push(message);observed.observeOutboundLine(JSON.stringify(message));if(message.method)f.socket.message(message);for(const cb of outbound)cb(JSON.stringify(message));},close(){}} as any});
  disposals.push(()=>server.close());
  let answer:any;
  let held:any;
  await act(async()=>{void (server as any).requestApprovalFromClient({sessionId:'native-fixture',toolName:'Bash',args:{command:'pwd'},description:'Approval fixture'}).then((v:any)=>{answer=v;});await flushMicrotasks();});
  const request=messages.find(m=>m.method==='agent/approvalRequest');
  expect(f.app.approvals).toHaveLength(1);
  const allow=all(f.container).find(n=>n.tagName==='BUTTON'&&props(n)?.children==='允许');
  await act(async()=>{props(allow).onClick();await flushMicrotasks();});
  expect(f.app.approvals).toHaveLength(0);
  const bridge:any={subscribeOutbound:(cb:any)=>{outbound.add(cb);return()=>outbound.delete(cb);},injectWorkerMessage:(raw:string)=>{held=JSON.parse(raw);}};
  const result=await injectAndAwaitResult(bridge,'agent/approve',{sessionId:'native-fixture',requestId:request.params.requestId,decision:{approved:true}},{origin:'mobile',producer:'quality-fixture'},20);
  expect(result).toEqual({ok:false,message:'worker did not respond'});
  expect((server as any).pendingApprovals.has(request.params.requestId)).toBe(true);
  expect(answer).toBeUndefined();
  await act(async()=>{f.socket.message({type:'error',approvalId:request.params.requestId,message:'worker did not respond'});await flushMicrotasks();});
  expect(f.app.approvals).toHaveLength(0);expect(f.app.notice).toBe('worker did not respond');
  const beforeFocus=f.socket.sent.length;
  await act(async()=>{window.dispatchEvent(new Event('focus'));await flushMicrotasks();});
  expect(f.socket.sent.slice(beforeFocus).some(message=>message.type==='session.sync'&&message.sessionId==='native-fixture')).toBe(true);
  await act(async()=>{for(const line of observed.replayLines('native-fixture'))f.socket.message(JSON.parse(line));await flushMicrotasks();});
  expect(f.app.approvals).toHaveLength(1);
  await act(async()=>{deliver(held);await flushMicrotasks();});
  expect(answer).toEqual({approved:true});expect((server as any).pendingApprovals.size).toBe(0);
  // No model invocation or worker stall is needed for a regular awaiting approval:
  // direct processing settles promptly; a busy async engine is covered by existing Core tests.
  await act(async()=>{void (server as any).requestApprovalFromClient({sessionId:'native-fixture',toolName:'Bash',args:{command:'pwd'},description:'Second approval'});await flushMicrotasks();});
  const second=messages.filter(m=>m.method==='agent/approvalRequest').at(-1);
  bridge.injectWorkerMessage=(raw:string)=>deliver(JSON.parse(raw));
  const accepted=await injectAndAwaitResult(bridge,'agent/approve',{sessionId:'native-fixture',requestId:second.params.requestId,decision:{approved:true}},{origin:'mobile',producer:'quality-fixture'},20);
  expect(accepted.ok).toBe(true);expect((server as any).pendingApprovals.size).toBe(0);
});
