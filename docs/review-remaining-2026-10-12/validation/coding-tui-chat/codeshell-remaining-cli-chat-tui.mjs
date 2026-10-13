import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import cp from "node:child_process";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
assert.equal(process.env.CODE_SHELL_TEST_HOME,path.join(process.env.HOME,".code-shell"));
assert.notEqual(process.env.HOME,"/Users/admin");
const deny=()=>{throw Error("review TUI fixture denies every network origin and subprocess");};
globalThis.fetch=deny;net.Socket.prototype.connect=deny;http.request=http.get=deny;https.request=https.get=deny;tls.connect=deny;
for(const n of ["spawn","spawnSync","exec","execSync","execFile","execFileSync","fork"])cp[n]=deny;
syncBuiltinESMExports();
assert(process.stdin.isTTY&&process.stdout.isTTY,"requires actual PTY");
process.env.CODESHELL_NO_MODEL_SYNC="1";
const root="/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell";
const mode=process.argv[2];
const rawLog="/tmp/codeshell-remaining-cli-chat-tui-"+mode+"-"+(process.argv[3]??"run2")+".log";
fs.writeFileSync(rawLog,"");
for(const stream of [process.stdout,process.stderr]){const original=stream.write;stream.write=function(data,...args){fs.appendFileSync(rawLog,data);return original.call(this,data,...args);};}
const log=x=>process.stderr.write("\nREVIEW "+JSON.stringify(x)+"\n");
if(mode==="input"){
 const React=(await import(root+"/node_modules/react/index.js")).default;
 const {render,Text,useInput,useApp}=await import(root+"/packages/tui/dist/render/index.js");
 let input=[];
 function Screen(){const {exit}=useApp();useInput((s,key)=>{input.push({s,backspace:!!key.backspace,return:!!key.return});if(s==="q")exit();});return React.createElement(Text,null,"Owned PTY fixture: type x, backspace, then q");}
 const app=await render(React.createElement(Screen),{exitOnCtrlC:false,patchConsole:false});
 setTimeout(()=>log({case:"tui_ready",mode,pid:process.pid,isRaw:process.stdin.isRaw}),100);
 const timeout=setTimeout(()=>{app.unmount();log({case:"tui_timeout",input});process.exit(2)},15000);
 await app.waitUntilExit();clearTimeout(timeout);app.cleanup();assert(input.some(i=>i.s==="x"));assert(input.some(i=>i.backspace));assert.equal(process.stdin.isRaw,false);log({case:"tui_input_exit",input,isRaw:process.stdin.isRaw});
 process.exit(0);
}else{
 const {runInkOnboarding}=await import(root+"/packages/tui/dist/ui/onboarding-runner.js");
 let outcome="pending";
 const task=runInkOnboarding().then(result=>{outcome=result===null?"cancelled":"configured";});
 setTimeout(()=>log({case:"tui_ready",mode,pid:process.pid,isRaw:process.stdin.isRaw}),100);
 const deadline=Date.now()+15000;
 while(Date.now()<deadline&&outcome==="pending")await new Promise(r=>setTimeout(r,50));
 assert.equal(outcome,mode==="escape"?"cancelled":"pending");
 assert.equal(process.stdin.isRaw,false);
 log({case:"tui_onboarding",mode,outcome,isRaw:process.stdin.isRaw,hostStillRunning:true});
 process.exit(0);
}
