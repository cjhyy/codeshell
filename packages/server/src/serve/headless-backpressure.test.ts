import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverEntry = fileURLToPath(new URL("../../dist/serve/headless-server.js", import.meta.url));
const serverPackage = fileURLToPath(new URL("../../package.json", import.meta.url));

// Native ws exposes TCP backpressure; Bun's compatibility WebSocket does not
// provide the same socket.pause()/bufferedAmount behavior. Exercise the built
// deployment artifact in Node, after the normal build/typecheck gate.
const NATIVE_FIXTURE = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { startHeadlessServer } = await import(pathToFileURL(process.argv[2]).href);
const { WebSocket } = createRequire(process.argv[3])('ws');
const dir = realpathSync(process.argv[4]);
const cwd = join(dir,'workspace'); mkdirSync(cwd);
const stored = join(dir,'data/worker/sessions/history'); mkdirSync(stored,{recursive:true});
writeFileSync(join(stored,'state.json'),JSON.stringify({sessionId:'history',cwd,startedAt:1,status:'completed',turnCount:1}));
const historyBytes = 9*1024*1024;
writeFileSync(join(stored,'transcript.jsonl'),JSON.stringify({id:'one',type:'message',timestamp:1,turnNumber:1,data:{role:'assistant',content:'x'.repeat(historyBytes)}})+'\n');
const drops=[];
const server = await startHeadlessServer({host:'127.0.0.1',port:0,cwd,dataDir:join(dir,'data'),workerEntryPath:join(dir,'unused-worker.cjs'),authMode:'hub',log:(event,data)=>{if(event==='tab.backpressure_drop')drops.push(data)}});
let slow,healthy,slowPort=0,peak=0;
const send = WebSocket.prototype.send;
WebSocket.prototype.send=function(...args){const value=send.apply(this,args);if(this._isServer&&this._socket?.remotePort===slowPort)peak=Math.max(peak,this.bufferedAmount);return value};
try {
 const setup=await fetch(server.url+'/api/v1/auth/setup',{method:'POST',headers:{origin:server.url,'content-type':'application/json'},body:JSON.stringify({token:server.bootstrapToken,username:'fixture',password:'snapshot-backpressure-fixture'})});
 assert.equal(setup.status,200);
 const cookie=setup.headers.get('set-cookie').split(';')[0];
 const connect=async()=>{const ws=new WebSocket(server.url.replace('http:','ws:')+'/ws',{headers:{cookie,origin:server.url}});ws.on('error',()=>{});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});return ws};
 slow=await connect(); healthy=await connect(); slowPort=slow._socket.localPort; slow._socket.pause();
 let healthyResult;
 healthy.on('message',data=>{const message=JSON.parse(data);if(message.id==='healthy')healthyResult=message});
 for(let i=0;i<6;i++) {
  slow.send(JSON.stringify({jsonrpc:'2.0',id:'slow-'+i,method:'agent/query',params:{type:'session_detail',sessionId:'history'}}));
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 healthy.send(JSON.stringify({jsonrpc:'2.0',id:'healthy',method:'agent/query',params:{type:'session_detail',sessionId:'history'}}));
 const deadline=Date.now()+4000;
 while((!healthyResult||server.tabCount()!==1)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(drops.length,1,'repeat snapshots must hit the same outbound guard as live events');
 assert.equal(drops[0].reason,'socket-backlog');
 assert(peak<20*1024*1024,'the paused peer must not queue every requested history');
 assert.equal(server.tabCount(),1);
 assert.equal(healthy.readyState,WebSocket.OPEN);
 assert.equal(healthyResult?.error,undefined);
 assert.equal(healthyResult?.result.data.transcript[0].data.content.length,historyBytes);
 assert.equal(server.bridge.hasChild(),false,'reading history must not start an agent worker');
 console.log(JSON.stringify({peakBufferedBytes:peak,healthyHistoryBytes:historyBytes,dropReason:drops[0].reason,workerStarted:false}));
} finally {
 slow?.terminate(); healthy?.terminate(); await server.close(); WebSocket.prototype.send=send;
}
`;

test.skipIf(!existsSync(serverEntry))(
  "native Hub bounds repeated large snapshots while a healthy peer receives its complete history",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-hub-native-backpressure-"));
    const entry = join(dir, "fixture.mjs");
    const isolatedHome = join(dir, "home");
    mkdirSync(isolatedHome);
    writeFileSync(entry, NATIVE_FIXTURE);
    try {
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn("node", [entry, serverEntry, serverPackage, dir], {
            // The deployment fixture must not discover a developer's user settings or plugins.
            env: {
              ...process.env,
              HOME: isolatedHome,
              USERPROFILE: isolatedHome,
              CODE_SHELL_HOME: join(isolatedHome, ".code-shell"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          const capture = (part: Buffer) => {
            output = (output + part.toString()).slice(-20_000);
          };
          child.stdout.on("data", capture);
          child.stderr.on("data", capture);
          const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, output });
          });
        },
      );
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('"healthyHistoryBytes":9437184');
      expect(result.output).toContain('"workerStarted":false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
