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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, realpathSync } from "node:fs";
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

const { searchSessionTranscripts } = await import(`${REVIEW_ROOT}/packages/pet/src/disclosure/search`);
const { listWorkSessionsOnDisk } = await import(`${REVIEW_ROOT}/packages/pet/src/disclosure/catalog`);
const { NO_REPO_KEY } = await import(`${REVIEW_ROOT}/packages/desktop/src/renderer/transcripts`);
function writeSession(id: string, content: string, mtime: number){
 const dir=join(fixtureRoot,id); mkdirSync(dir);
 writeFileSync(join(dir,"state.json"),JSON.stringify({sessionId:id,kind:"work",origin:"desktop",parentSessionId:null,title:id,cwd:""}));
 const transcript=join(dir,"transcript.jsonl"); writeFileSync(transcript,JSON.stringify({type:"message",turnNumber:1,data:{role:"user",content}})+"\n"); utimesSync(transcript,mtime,mtime);
}
test("CONFIRMED candidate cap hides an older real content match and UI reports an unqualified empty result",async()=>{
 fixtureRoot=realpathSync(mkdtempSync(join(tmpdir(),"codeshell-search-cap-")));
 for(let i=0;i<500;i++)writeSession(`recent-${String(i).padStart(3,"0")}`,"ordinary recent content",1700000000+i);
 writeSession("older-target","distinctive_old_needle",1600000000);
 const all=await listWorkSessionsOnDisk(fixtureRoot,{limit:501});
 expect(all).toHaveLength(501); expect(all[500].sessionId).toBe("older-target");
 const result=await searchSessionTranscripts(fixtureRoot,"distinctive_old_needle",{budgetMs:5000});
 expect(result.scannedSessions).toBe(500); expect(result.matches).toEqual([]); expect(result.truncated).toBe(false);
 const calls: string[]=[];
 Object.defineProperty(window,"codeshell",{configurable:true,value:{searchSessionContent:async(q)=>{calls.push(q);return result;}}});
 const container=document.createElement("div");root=createRoot(container);
 await act(async()=>{root.render(<SessionSearchModal open onClose={()=>{}} projects={[]} sessions={{[NO_REPO_KEY]:{sessions:[{id:"older-target",title:"older-target",createdAt:1,updatedAt:1}],activeSessionId:null}}} activeProjectId={null} onPick={()=>{}}/>);await flushMicrotasks();});
 const contentButton=nodes(container).find(n=>n.tagName==="BUTTON"&&/对话内容|Content/.test(textOf(props(n).children)));
 expect(contentButton).toBeDefined();
 await act(async()=>{props(contentButton).onClick();await flushMicrotasks();});
 const input=nodes(container).find(n=>n.tagName==="INPUT");
 await act(async()=>{props(input).onChange({target:{value:"distinctive_old_needle"}});await flushMicrotasks();});
 await until(()=>calls.length===1&&!/正在搜索会话内容|Searching/.test(visibleText(container)));
 expect(calls).toEqual(["distinctive_old_needle"]);
 expect(visibleText(container)).toMatch(/未找到匹配内容|No matching content/);
 expect(visibleText(container)).not.toMatch(/结果不完整|Results are incomplete/);
 // A same-catalog normal control: bringing the exact transcript into the
 // selected candidate band makes the same query return it without editing text.
 utimesSync(join(fixtureRoot,"older-target","transcript.jsonl"),1800000000,1800000000);
 const recovered=await searchSessionTranscripts(fixtureRoot,"distinctive_old_needle",{budgetMs:5000});
 expect(recovered.matches.map(m=>m.sessionId)).toEqual(["older-target"]);
 console.log(JSON.stringify({catalogSize:all.length,oldestId:all[500].sessionId,result,afterCandidateBandChange:recovered.matches.map(m=>m.sessionId)}));
});
test("CONTROL small catalog searches old transcripts and advertises explicit deadline truncation",async()=>{
 fixtureRoot=realpathSync(mkdtempSync(join(tmpdir(),"codeshell-search-normal-")));
 writeSession("older-target","distinctive_old_needle",1600000000);writeSession("recent","ordinary content",1700000000);
 const found=await searchSessionTranscripts(fixtureRoot,"distinctive_old_needle",{budgetMs:5000});
 expect(found.matches.map(m=>m.sessionId)).toEqual(["older-target"]);expect(found.truncated).toBe(false);
 const bounded=await searchSessionTranscripts(fixtureRoot,"distinctive_old_needle",{budgetMs:-1});
 expect(bounded.truncated).toBe(true);
 Object.defineProperty(window,"codeshell",{configurable:true,value:{searchSessionContent:async()=>bounded}});
 const container=document.createElement("div");root=createRoot(container);
 await act(async()=>{root.render(<SessionSearchModal open onClose={()=>{}} projects={[]} sessions={{}} activeProjectId={null} onPick={()=>{}}/>);await flushMicrotasks();});
 const contentButton=nodes(container).find(n=>n.tagName==="BUTTON"&&/对话内容|Content/.test(textOf(props(n).children)));
 await act(async()=>{props(contentButton).onClick();await flushMicrotasks();});
 const input=nodes(container).find(n=>n.tagName==="INPUT");
 await act(async()=>{props(input).onChange({target:{value:"distinctive_old_needle"}});await flushMicrotasks();});
 await until(()=>/结果不完整|Results are incomplete/.test(visibleText(container)));
 expect(visibleText(container)).toMatch(/结果不完整|Results are incomplete/);
 console.log(JSON.stringify({smallCatalogMatch:found.matches.map(m=>m.sessionId),deadlineReply:bounded,uiTruncationWarning:true}));
});
