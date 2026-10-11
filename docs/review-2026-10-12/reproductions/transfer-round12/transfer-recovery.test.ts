import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw Error("guarded HOME required");
const repo = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const temporary = mkdtempSync(join(tmpdir(), "codeshell-transfer-round12-"));
const cwd = join(temporary, "workspace"); mkdirSync(cwd);
let files:any, history:any;
let completed = 0, aborted = 0;
const server = createServer(async (req,res) => {
  res.on("close",()=>{if(!res.writableEnded)aborted++;});
  try {
    if(await files.handle(req,res))return;
    if(await history.handle(req,res))return;
    res.writeHead(404).end();
  } finally {completed++;}
});
await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard(origin);
// Direct outbound socket APIs are forbidden too. The one owned HTTP fixture
// is allowed by the exact-origin fetch/http guard installed before all Core imports.
const deny = ()=>{throw Error("NETWORK_FORBIDDEN_round12");};
net.connect=net.createConnection=deny as any;tls.connect=deny as any;
const { createHubFiles } = await import(`${repo}/packages/server/src/hub/files.ts`);
const { createHubSessions } = await import(`${repo}/packages/server/src/hub/session-management.ts`);
const { SessionManager } = await import(`${repo}/packages/core/src/session/session-manager.ts`);
const sessionsRoot = join(temporary,"sessions");
const manager = new SessionManager(sessionsRoot);
const running = new Set<string>();
const changed:string[]=[];
files=createHubFiles({cwd,isAuthorized:async()=>true});
history=createHubSessions({cwd,sessionRootDir:sessionsRoot,dataDir:join(temporary,"data"),isAuthorized:async()=>true,isRunning:(id:string)=>running.has(id),onChanged:(id:string)=>changed.push(id)});
const hash=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const pause=()=>new Promise(r=>setTimeout(r,5));
async function until(fn:()=>boolean){const deadline=Date.now()+2000;while(!fn()){if(Date.now()>deadline)throw Error("fixture completion timeout");await pause();}}
const request=(path:string,method="GET",body?:unknown)=>fetch(origin+path,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
afterAll(async()=>{files?.close();await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});rmSync(temporary,{recursive:true,force:true});});

test("CONTROL aborted writable consumer releases file-service reader slots and preserves source",async()=>{
  const large=join(cwd,"owned-large.bin"),small=join(cwd,"owned-small.txt");
  writeFileSync(large,Buffer.alloc(2*1024*1024,0x65));writeFileSync(small,"after-cancel 完整 bytes");
  const before=hash(large);let abortedConsumers=0;
  class AbortedConsumer extends Writable {
    headersSent=false;statusCode=0;received=0;
    writeHead(status:number,_headers:any){this.statusCode=status;this.headersSent=true;return this;}
    _write(chunk:any,_encoding:any,callback:any){
      this.received+=chunk.length;
      // Abort a destination while the production pipeline owns the source handle.
      this.destroy();callback();
    }
  }
  for(let i=0;i<17;i++){
    const response=new AbortedConsumer();
    expect(await files.handle({url:"/api/v1/files/content?path=owned-large.bin",method:"GET",headers:{}},response)).toBe(true);
    expect(response.statusCode).toBe(200);expect(response.received).toBeGreaterThan(0);
    expect(response.received).toBeLessThan(2*1024*1024);expect(response.destroyed).toBe(true);
    abortedConsumers++;
  }
  const after=await request("/api/v1/files/content?path=owned-small.txt");
  expect(after.status).toBe(200);expect(await after.text()).toBe("after-cancel 完整 bytes");
  expect(hash(large)).toBe(before);
  console.log(JSON.stringify({control:"aborted-writable-consumer",abortedConsumers,sourceHashPreserved:true,nextActualHttpDownloadStatus:after.status,scope:"production file handler and pipeline, controlled writable destination; not native browser cancellation"}));
});

test("CONTROL export errors and active-run refusal preserve history and release export admission",async()=>{
  const bundle=manager.create(cwd,"fixture-model","fixture-provider","export-owned",null,"desktop");
  bundle.transcript.appendMessage("user","Round 12 用户原记录");bundle.transcript.appendMessage("assistant","Round 12 assistant record");
  manager.updateSessionState("export-owned",{title:"Transfer review",status:"completed"});
  const transcript=join(sessionsRoot,"export-owned","transcript.jsonl"),state=join(sessionsRoot,"export-owned","state.json");
  const original=readFileSync(transcript),beforeState=hash(state);
  for(let i=0;i<3;i++)expect((await request("/api/v1/sessions/export-owned/export?format=unsupported")).status).toBe(400);
  expect(hash(state)).toBe(beforeState);expect(readFileSync(transcript)).toEqual(original);
  running.add("export-owned");
  expect((await request("/api/v1/sessions/export-owned/export?format=json")).status).toBe(409);
  expect((await request("/api/v1/sessions/export-owned","PATCH",{archived:true})).status).toBe(409);
  expect(hash(state)).toBe(beforeState);expect(changed).toEqual([]);running.delete("export-owned");
  writeFileSync(transcript,Buffer.concat([original,Buffer.from("not a complete valid interior record\n")]));
  const corrupt=readFileSync(transcript);
  expect((await request("/api/v1/sessions/export-owned/export?format=json")).status).toBe(422);
  expect(readFileSync(transcript)).toEqual(corrupt);expect(hash(state)).toBe(beforeState);
  // Controlled fixture backup repair, not a claim of an automatic UI repair feature.
  writeFileSync(transcript,original);
  const exported=await request("/api/v1/sessions/export-owned/export?format=json");
  expect(exported.status).toBe(200);const json:any=await exported.json();
  expect(json.state.sessionId).toBe("export-owned");
  expect(json.transcript.filter((e:any)=>e.type==="message").map((e:any)=>e.data.content)).toEqual(["Round 12 用户原记录","Round 12 assistant record"]);
  expect(readFileSync(transcript)).toEqual(original);expect(hash(state)).toBe(beforeState);
  expect((await request("/api/v1/sessions/export-owned","PATCH",{archived:true})).status).toBe(200);
  expect((await request("/api/v1/sessions/export-owned","PATCH",{archived:false})).status).toBe(200);
  expect(new SessionManager(sessionsRoot).resume("export-owned").transcript.toMessages().filter((e:any)=>e.role==="user"||e.role==="assistant")).toHaveLength(2);
  console.log(JSON.stringify({control:"export-history-failure-recovery",badFormatStatuses:[400,400,400],runningExportStatus:409,runningArchiveStatus:409,corruptInteriorStatus:422,nextExportStatus:200,sourcePreserved:true,archiveRestoreResumable:true}));
});

test("CONTROL closing the file service fences new downloads while retaining original files",async()=>{
  const original=readFileSync(join(cwd,"owned-small.txt"));files.close();
  const response=await request("/api/v1/files/content?path=owned-small.txt");
  expect(response.status).toBe(503);expect((await response.json() as any).error).toContain("关闭");
  expect(readFileSync(join(cwd,"owned-small.txt"))).toEqual(original);
  files=createHubFiles({cwd,isAuthorized:async()=>true});
  expect(await (await request("/api/v1/files/content?path=owned-small.txt")).text()).toBe(original.toString());
});
