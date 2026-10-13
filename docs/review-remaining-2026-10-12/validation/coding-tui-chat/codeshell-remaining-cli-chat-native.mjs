import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import {syncBuiltinESMExports} from "node:module";
const root="/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell";
assert.equal(process.env.CODE_SHELL_TEST_HOME,path.join(process.env.HOME,".code-shell"));
assert.notEqual(process.env.HOME,"/Users/admin");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"codeshell-remaining-cli-chat-native-"));
const owned=new Map();const live=new Set();const evidence=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const log=data=>{evidence.push(data);console.log(JSON.stringify(data));};
const guard=path.join(dir,"guard.mjs");
const guardSource=`import net from 'node:net';import http from 'node:http';import https from 'node:https';import tls from 'node:tls';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{throw Error('review fixture denies every network origin')};globalThis.fetch=deny;net.Socket.prototype.connect=deny;http.request=http.get=deny;https.request=https.get=deny;tls.connect=deny;syncBuiltinESMExports();`;
fs.writeFileSync(guard,guardSource);
process.env.NODE_OPTIONS=`--import=${guard}`;
await import(guard);
const originalSpawn=childProcess.spawn;
childProcess.spawn=function(command,args=[],options={}){
 const target=command===process.execPath?args[0]:command;
 assert(owned.has(target),"only owned exact subprocess entry is allowed: "+target);
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),owned.get(target));
 assert(!options.shell&&!options.detached);
 assert.equal((options.env??process.env).HOME,process.env.HOME);
 assert.equal((options.env??process.env).NODE_OPTIONS,process.env.NODE_OPTIONS);
 const child=originalSpawn.call(this,command,args,options);if(child.pid){live.add(child.pid);child.once('exit',()=>live.delete(child.pid));}return child;
};
for(const name of ['exec','execSync','execFile','execFileSync','spawnSync','fork'])childProcess[name]=()=>{throw Error('review fixture denies non-owned process')};
syncBuiltinESMExports();
function fixture(name,source,executable=false){const file=path.join(dir,name);fs.writeFileSync(file,(executable?`#!${process.execPath}\n`:"")+source,{mode:0o700});owned.set(file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));return file;}
const lsp=(extra="")=>`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(dir,"lsp.pid"))},String(process.pid));let b=Buffer.alloc(0);const send=(o)=>{const body=JSON.stringify(o);process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);};process.stdin.on('data',chunk=>{b=Buffer.concat([b,chunk]);while(true){const h=b.indexOf('\\r\\n\\r\\n');if(h<0)return;const n=Number(b.subarray(0,h).toString().match(/Content-Length:\\s*(\\d+)/i)[1]);if(b.length<h+4+n)return;const m=JSON.parse(b.subarray(h+4,h+4+n));b=b.subarray(h+4+n);if(m.method==='initialize'){${extra||"send({id:m.id,result:{capabilities:{}}});"}}else if(m.method==='shutdown')send({id:m.id,result:null});else if(m.method==='exit')process.exit(0);else if(m.id)send({id:m.id,result:[]});}});setInterval(()=>{},1000);`;
try{
 const {LSPClient}=await import(root+"/packages/coding/dist/lsp/client.js");
 const {LSPServerManager}=await import(root+"/packages/coding/dist/lsp/manager.js");
 const {CodexRuntime}=await import(root+"/packages/coding/dist/external-runtimes/codex/runtime.js");
 const {ClaudeCodeRuntime}=await import(root+"/packages/coding/dist/external-runtimes/claude-code/runtime.js");
 const bridge={url:"http://127.0.0.1:1/mcp",token:"fixture",tokenEnvVar:"CODESHELL_CODEX_MCP_TOKEN",close:async()=>{}};
 // Normal owned language-server handshake/shutdown.
 const happy=fixture("lsp-happy.mjs",lsp());const client=new LSPClient(process.execPath,[happy],dir);await client.start();await client.initialize('file://'+dir);assert(client.isInitialized);await client.shutdown();log({case:'lsp_control',initialized:true,alive:client.isAlive});
 // Initialization failure loses the cleanup handle in the manager.
 const failing=fixture("lsp-init-error.mjs",lsp("send({id:m.id,error:{code:-1,message:'initialization refused'}});"));
 const manager=new LSPServerManager(dir);manager.servers.get('typescript').config={name:'typescript',command:process.execPath,args:[failing]};
 assert.equal(await manager.getClient('typescript'),undefined);const pid=Number(fs.readFileSync(path.join(dir,'lsp.pid'),'utf8'));await manager.shutdownAll();assert(alive(pid));log({case:'lsp_init_failure',returnedUndefined:true,aliveAfterShutdown:alive(pid)});process.kill(pid,'SIGKILL');
 // A slow, valid initialize lets another caller report the server unavailable.
 const slow=fixture('lsp-slow.mjs',lsp("setTimeout(()=>send({id:m.id,result:{capabilities:{}}}),2200);"));
 const concurrent=new LSPServerManager(dir);concurrent.servers.get('typescript').config={name:'typescript',command:process.execPath,args:[slow]};
 const first=concurrent.getClient('typescript');await wait(20);const second=await concurrent.getClient('typescript');assert.equal(second,undefined);const ready=await first;assert(ready);log({case:'lsp_concurrent_cold',secondUndefined:true,firstReady:!!ready});await concurrent.shutdownAll();
 // Process exits after ready, yet isAlive remains true and manager reuses it.
 const exits=fixture('lsp-exits.mjs',lsp("send({id:m.id,result:{capabilities:{}}});setTimeout(()=>process.exit(3),50);"));
 const deadManager=new LSPServerManager(dir);deadManager.servers.get('typescript').config={name:'typescript',command:process.execPath,args:[exits]};
 const dead=await deadManager.getClient('typescript');await wait(150);assert(dead.isAlive);assert.equal(await deadManager.getClient('typescript'),dead);log({case:'lsp_exited',isAlive:dead.isAlive,reused:true,exitCode:dead.process.exitCode});dead.process=undefined;await deadManager.shutdownAll();
 // Missing cwd errors are not listened to by LSPClient, crashing the native host.
 const spawnCase=fixture('lsp-spawn-case.mjs',`const {LSPClient}=await import(${JSON.stringify(root+'/packages/coding/dist/lsp/client.js')});await new LSPClient(process.execPath,[],${JSON.stringify(path.join(dir,'removed-cwd'))}).start();setTimeout(()=>process.exit(0),100);`);
 const c=childProcess.spawn(process.execPath,[spawnCase],{stdio:['ignore','pipe','pipe']});let stderr='';c.stderr.on('data',b=>stderr+=b);const code=await new Promise(r=>c.once('close',r));assert.notEqual(code,0);assert.match(stderr,/ENOENT/);log({case:'lsp_spawn_error',exitCode:code,unhandled:stderr.includes("Unhandled 'error' event"),error:stderr.slice(0,500)});
 // Codex app-server crash after accepting turn/start leaves done pending.
 for(const crash of [false,true]){
  const fake=fixture('codex-'+crash+'.mjs',`import{createInterface}from'node:readline';const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{}});else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-fixture'}}});else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn-fixture'}}});send({method:'turn/started',params:{threadId:'thread-fixture',turn:{id:'turn-fixture'}}});setTimeout(()=>{${crash?"process.exit(7)":"send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}})"}},30);}else if(m.id)send({id:m.id,result:{}});});`);
  const events=[];const runtime=new CodexRuntime({cwd:dir,businessSessionId:'review',bridge,client:{command:process.execPath,args:[fake]}},{onEvent:e=>events.push(e)});
  try{await runtime.start();const turn=await runtime.send({text:'owned fixture turn'});const outcome=await Promise.race([turn.done.then(()=>"done"),wait(200).then(()=>"pending")]);assert.equal(outcome,crash?'pending':'done');log({case:'codex_crash',crash,outcome,clientClosed:runtime.client.isClosed,events:events.map(e=>e.type)});}
  finally{await runtime.close();}
 }
 // Cooperative owned CLI is the normal close control.
 const cooperative=fixture('claude-cooperative.mjs',`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(dir,'claude-control.pid'))},String(process.pid));process.stdin.resume();process.stdin.on('end',()=>{});setInterval(()=>{},1000);`,true);
 const claudeControl=new ClaudeCodeRuntime({cwd:dir,businessSessionId:'review',bridge,exposedToolNames:[],command:cooperative});const controlTurn=await claudeControl.send({text:'owned control turn'});for(let i=0;i<100&&!fs.existsSync(path.join(dir,'claude-control.pid'));i++)await wait(10);const controlPid=Number(fs.readFileSync(path.join(dir,'claude-control.pid'),'utf8'));await claudeControl.close();await controlTurn.done;assert(!alive(controlPid));log({case:'claude_control',aliveAfterDone:alive(controlPid),done:'done'});
 // Claude close returns even when owned CLI ignores SIGTERM.
 const stubborn=fixture('claude-owned.mjs',`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(dir,'claude.pid'))},String(process.pid));process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>{});setInterval(()=>{},1000);`,true);
 const claude=new ClaudeCodeRuntime({cwd:dir,businessSessionId:'review',bridge,exposedToolNames:[],command:stubborn});const turn=await claude.send({text:'owned fixture turn'});for(let i=0;i<100&&!fs.existsSync(path.join(dir,'claude.pid'));i++)await wait(10);const cp=Number(fs.readFileSync(path.join(dir,'claude.pid'),'utf8'));await claude.close();await wait(700);assert(alive(cp));const outcome=await Promise.race([turn.done.then(()=>"done"),wait(50).then(()=>"pending")]);assert.equal(outcome,'pending');log({case:'claude_close',aliveAfter700ms:alive(cp),done:outcome});process.kill(cp,'SIGKILL');await turn.done;
} finally {
 for(const pid of live){try{process.kill(pid,'SIGKILL')}catch{}}
 await wait(100);log({case:'cleanup',livePids:[...live].filter(alive)});fs.rmSync(dir,{recursive:true,force:true});
}
