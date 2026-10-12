import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
// Only fixture-owned exact origins are admitted, before product imports.
const ownedOrigins = new Set<string>();
let blocked = 0;
const deny = () => { blocked++; throw new Error("review fixture denies every network origin"); };
const originalFetch = globalThis.fetch;
(globalThis as any).fetch = (input:any,init:any) => { const url=new URL(typeof input==="string"||input instanceof URL?input:input.url); if(!ownedOrigins.has(url.origin)) return deny();return originalFetch(input,{...init,redirect:"error"}); };
const originalConnect=net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function(...args:any[]) { const v=Array.isArray(args[0])?args[0]:args;const o=typeof v[0]==="object"?v[0]:{port:v[0],host:typeof v[1]==="string"?v[1]:undefined};if(o.path||!ownedOrigins.has(`http://${o.host??o.hostname??"localhost"}:${o.port}`))return deny();return originalConnect.apply(this,args as any);};
for(const name of ["request","get"]){const original=(http as any)[name];(http as any)[name]=function(input:any,...args:any[]){const url=typeof input==="string"||input instanceof URL?new URL(input):new URL(`http://${input.hostname??input.host??"localhost"}:${input.port??80}`);if(!ownedOrigins.has(url.origin))return deny();return original.call(this,input,...args);};}
(https as any).request = (https as any).get = deny;
(tls as any).connect = deny;
syncBuiltinESMExports();
try { await fetch("https://example.invalid"); } catch {}
expect(blocked).toBe(1);
const root = "/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell";
const { DeliveryQueue } = await import(root + "/packages/chat/src/delivery-queue.ts");
const { ChatGateway, createAllowlistMiddleware } = await import(root + "/packages/chat/src/chat-gateway.ts");
const cfg = { maxPending: 10, maxConcurrent: 1, maxPerTarget: 1, retryBaseMs: 100, retryMaxMs: 100, completedTtlMs: 60000 };
const msg = (id: string, senderId = "owner") => ({ channel: "fixture", target: "room", senderId, text: id, messageId: id });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => boolean, timeout = 2000) { const end=Date.now()+timeout; while(!fn()) { if(Date.now()>end) throw Error("fixture deadline"); await delay(5); } }

test("same-target retry overtaken by later message; normal control remains FIFO", async () => {
 for (const fails of [false,true]) {
  const calls: string[] = []; let attempt=0;
  const q = new DeliveryQueue(cfg, async (_id: string,m: any) => { calls.push(m.text); if(m.text === "a" && fails && ++attempt === 1) throw Error("temporary"); }, () => {});
  await q.start();
  try { await q.enqueue("fixture:0",msg("a")); await q.enqueue("fixture:0",msg("b")); await until(()=>q.status().pending===0); }
  finally { q.stop(); }
  expect(calls).toEqual(fails ? ["a","b","a"] : ["a","b"]);
  console.log(JSON.stringify({case:"fifo",fails,calls}));
 }
});

test("real Telegram adapter downloads denied sender attachment before gateway allowlist",async()=>{
 const {TelegramAdapter}=await import(root+"/packages/chat/src/telegram.ts");
 for(const senderId of ["stranger","owner"]){
  const dir=mkdtempSync(join(tmpdir(),"codeshell-remaining-cli-chat-allowlist-"));
  const abort=new AbortController();let polls=0,admitted=0;const calls:string[]=[];
  const server=http.createServer(async(req,res)=>{
   calls.push(req.url!);req.resume();res.setHeader("content-type","application/json");
   if(req.url?.endsWith("/getUpdates")){
    polls++;
    if(polls===1)res.end(JSON.stringify({ok:true,result:[{update_id:1,message:{message_id:1,date:Date.now()/1000,chat:{id:"room",type:"private"},from:{id:senderId},document:{file_id:"doc",file_unique_id:"doc",file_name:"doc.bin",file_size:1}}}]}));
    else{abort.abort();res.end(JSON.stringify({ok:true,result:[]}));}
   }else if(req.url?.endsWith("/getFile"))res.end(JSON.stringify({ok:true,result:{file_path:"doc.bin"}}));
   else if(req.url?.endsWith("/doc.bin")){res.setHeader("content-type","application/octet-stream");res.end(Buffer.from([1]));}
   else{res.statusCode=404;res.end("{}");}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;ownedOrigins.add(origin);
  const adapter=new TelegramAdapter({botToken:"fixture",apiBaseUrl:origin});
  const gateway=new ChatGateway({adapters:[adapter],delivery:{...cfg,path:join(dir,"inbox.json")}});
  gateway.use(createAllowlistMiddleware({telegram:{targetIds:["room"],userIds:["owner"]}}));gateway.use(async()=>{admitted++;});
  try{await gateway.run(abort.signal);await delay(20);expect(calls).toContain("/botfixture/getFile");expect(calls).toContain("/file/botfixture/doc.bin");expect(admitted).toBe(senderId==="owner"?1:0);console.log(JSON.stringify({case:"telegram_allowlist",senderId,admitted,calls}));}
  finally{abort.abort();await new Promise<void>(resolve=>server.close(()=>resolve()));ownedOrigins.delete(origin);rmSync(dir,{recursive:true,force:true});}
 }
});

test("Slack ACKs when the real durable inbox rejects the message; accepted control persists",async()=>{
 const {SlackAdapter}=await import(root+"/packages/chat/src/slack.ts");
 const {readFileSync}=await import("node:fs");
 for(const full of [false,true]){
  const dir=mkdtempSync(join(tmpdir(),"codeshell-remaining-cli-chat-slack-"));const inbox=join(dir,"inbox.json");
  let release:()=>void=()=>{};const blockedDelivery=new Promise<void>(r=>release=r);
  const q=new DeliveryQueue({...cfg,maxPending:1,path:inbox},async()=>{await blockedDelivery;},()=>{});await q.start();
  if(full)await q.enqueue("slack:0",{...msg("seed"),channel:"slack"});
  const adapter:any=new SlackAdapter({botToken:"fixture",appToken:"fixture"});
  adapter.socket.start=async()=>{};adapter.socket.disconnect=async()=>{};
  const abort=new AbortController();let ack=0,attempt=0;
  const running=adapter.run(async(m:any)=>{attempt++;await q.enqueue("slack:0",m);},abort.signal);
  try {
   await until(()=>adapter.socket.listenerCount("events_api")===1);
   const callback=adapter.socket.listeners("events_api")[0];
   await callback({event:{type:"message",channel:"room",user:"owner",text:"incoming",ts:"1"},ack:async()=>{ack++;}});
   const persisted=JSON.parse(readFileSync(inbox,"utf8")).pending.map((r:any)=>r.message.text);
   expect(attempt).toBe(1);expect(ack).toBe(1);expect(persisted).toEqual(full?["seed"]:["incoming"]);
   console.log(JSON.stringify({case:"slack_ack",full,attempt,ack,persisted}));
  } finally{q.stop();release();abort.abort();await running;await delay(20);rmSync(dir,{recursive:true,force:true});}
 }
});

test("NotebookEdit accepts array source but cannot read serialized string source",async()=>{
 const {notebookEditTool}=await import(root+"/packages/coding/src/tools/notebook-edit.ts");
 const {writeFileSync}=await import("node:fs");
 const dir=mkdtempSync(join(tmpdir(),"codeshell-remaining-cli-chat-notebook-"));const path=join(dir,"n.ipynb");
 try {
  for(const source of [["print(1)"],"print(1)"]){
   writeFileSync(path,JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{},cells:[{id:"one",cell_type:"code",source,metadata:{tags:["parameters"]},outputs:[],execution_count:null}]}));
   if(Array.isArray(source)) expect(await notebookEditTool({action:"read",file_path:path})).toContain("print(1)");
   else await expect(notebookEditTool({action:"read",file_path:path})).rejects.toThrow("join");
  }
 } finally{rmSync(dir,{recursive:true,force:true});}
});

test("DingTalk sends SUCCESS when the real durable inbox rejects; accepted control persists",async()=>{
 const {DingTalkAdapter}=await import(root+"/packages/chat/src/dingtalk.ts");
 const {readFileSync}=await import("node:fs");
 for(const full of [false,true]){
  const dir=mkdtempSync(join(tmpdir(),"codeshell-remaining-cli-chat-dingtalk-"));const inbox=join(dir,"inbox.json");
  let release:()=>void=()=>{};const blockedDelivery=new Promise<void>(r=>release=r);
  const q=new DeliveryQueue({...cfg,maxPending:1,path:inbox},async()=>{await blockedDelivery;},()=>{});await q.start();
  if(full)await q.enqueue("dingtalk:0",{...msg("seed"),channel:"dingtalk"});
  const adapter:any=new DingTalkAdapter({clientId:"fixture",clientSecret:"fixture"});
  let callback:any;const acks:any[]=[];
  adapter.client.registerCallbackListener=(_topic:any,fn:any)=>{callback=fn;};adapter.client.connect=async()=>{};adapter.client.disconnect=()=>{};adapter.client.socketCallBackResponse=(...args:any[])=>{acks.push(args);};
  const abort=new AbortController();let attempt=0;
  const running=adapter.run(async(m:any)=>{attempt++;await q.enqueue("dingtalk:0",m);},abort.signal);
  try{
   await callback({headers:{messageId:"incoming-id"},data:JSON.stringify({msgtype:"text",text:{content:"incoming"},conversationId:"room",conversationType:"1",senderStaffId:"owner",sessionWebhook:"https://example.invalid/never-called"})});
   const persisted=JSON.parse(readFileSync(inbox,"utf8")).pending.map((r:any)=>r.message.text);
   expect(attempt).toBe(1);expect(acks).toEqual([["incoming-id",{status:"SUCCESS"}]]);expect(persisted).toEqual(full?["seed"]:["incoming"]);
   console.log(JSON.stringify({case:"dingtalk_ack",full,attempt,acks,persisted}));
  }finally{q.stop();release();abort.abort();await running;await delay(20);rmSync(dir,{recursive:true,force:true});}
 }
});

test("NotebookEdit replace discards the cell id and unrelated metadata",async()=>{
 const {notebookEditTool}=await import(root+"/packages/coding/src/tools/notebook-edit.ts");
 const {writeFileSync,readFileSync}=await import("node:fs");
 const dir=mkdtempSync(join(tmpdir(),"codeshell-remaining-cli-chat-notebook-"));const path=join(dir,"n.ipynb");
 try {
  writeFileSync(path,JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{},cells:[{id:"one",cell_type:"code",source:["a=1"],metadata:{tags:["parameters"]},outputs:[],execution_count:null}]}));
  await notebookEditTool({action:"replace",file_path:path,cell_index:0,source:"a=2"});
  const cell=JSON.parse(readFileSync(path,"utf8")).cells[0];expect(cell.metadata).toEqual({});expect(cell.id).toBeUndefined();expect(cell.source).toEqual(["a=2"]);
  console.log(JSON.stringify({case:"notebook_replace",cell}));
 } finally{rmSync(dir,{recursive:true,force:true});}
});

test("Link manifest local provider/action catalog agrees with production core registry",async()=>{
 const {LINK_PROVIDER_MANIFESTS}=await import(root+"/packages/link/src/catalog.ts");
 const {listLocalLinkProviders}=await import(root+"/packages/core/src/links/providers.ts");
 const actual=listLocalLinkProviders();
 expect(LINK_PROVIDER_MANIFESTS.map((p:any)=>p.id).sort()).toEqual(actual.map((p:any)=>p.id).sort());
 for(const p of LINK_PROVIDER_MANIFESTS){const active=actual.find((a:any)=>a.id===p.id)!;expect([...p.actionIds].sort()).toEqual(active.actions.map((a:any)=>a.id).sort());}
 console.log(JSON.stringify({case:"link_contract",providers:actual.length,actions:actual.reduce((sum:number,p:any)=>sum+p.actions.length,0)}));
});
