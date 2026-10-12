import { afterAll, afterEach, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
const denied: string[] = [];
const networkDeny = (...args: any[]) => { denied.push(String(args[0])); throw new Error("review fixture owns zero network origins"); };
const restores: (() => void)[] = [];
for (const [target, key] of [[globalThis, "fetch"], [http,"request"], [http,"get"], [https,"request"], [https,"get"], [net.Socket.prototype,"connect"], [dgram.Socket.prototype,"send"]] as const) {
  const object = target as any; const previous = object[key]; object[key] = networkDeny; restores.push(() => { object[key] = previous; });
}
syncBuiltinESMExports();
const root = "/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src";
console.log("Bun provider resolution after root package-release gate", JSON.stringify({openai:Bun.resolveSync("openai",`${root}/llm/providers`),anthropic:Bun.resolveSync("@anthropic-ai/sdk",`${root}/llm/providers`)}));
const { ToolExecutor } = await import(`${root}/tool-system/executor.ts`);
const { ToolRegistry } = await import(`${root}/tool-system/registry.ts`);
const { PermissionClassifier } = await import(`${root}/tool-system/permission.ts`);
const { HookRegistry } = await import(`${root}/hooks/registry.ts`);
const { OpenAIClient } = await import(`${root}/llm/providers/openai.ts`);
const { AnthropicClient } = await import(`${root}/llm/providers/anthropic.ts`);
const { ModelFacade } = await import(`${root}/engine/model-facade.ts`);
const { Transcript } = await import(`${root}/session/transcript.ts`);
const { resolveAuthCommand, __clearAuthTokenCache } = await import(`${root}/llm/provider-auth.ts`);
const { agentTool, agentSendInputTool, agentStatusTool } = await import(`${root}/tool-system/builtin/agent.ts`);
const { asyncAgentRegistry } = await import(`${root}/tool-system/builtin/agent-registry.ts`);
const { notificationQueue } = await import(`${root}/tool-system/builtin/agent-notifications.ts`);
afterEach(() => { asyncAgentRegistry.reset(); notificationQueue.reset(); __clearAuthTokenCache(); delete process.env.CODE_SHELL_AGENT_BG_MS; });
afterAll(() => { expect(denied).toEqual([]); for (const restore of restores) restore(); syncBuiltinESMExports(); console.log("review cleanup: 0 socket/fetch network attempts; registries reset; only isolated runner HOME used"); });
function executor(name: string, hooks: any, context: any, execute?: any) {
 const registry = new ToolRegistry({ builtinTools: ["AgentCancel"].includes(name) ? [name] : [] });
 const seen: any[] = [];
 if (name !== "AgentCancel") registry.registerTool({ name, description:"review fake handler", inputSchema:{type:"object"}, source:"builtin", permissionDefault:"allow" }, async(args:any) => { seen.push(args); return execute ? execute(args) : "ran"; });
 const e = new ToolExecutor(registry, new PermissionClassifier([], "bypassPermissions"), hooks); e.setContext(context); return { e, seen };
}
test("plan normal controls block direct write and permit direct read", async () => {
 const {e,seen}=executor("Bash",new HookRegistry(),{planMode:true});
 expect((await e.executeSingle({id:"write",toolName:"Bash",args:{command:"echo x > result.txt"}})).isError).toBe(true);
 expect((await e.executeSingle({id:"read",toolName:"Bash",args:{command:"ls -la"}})).isError).toBe(false);
 expect(seen.map(x=>x.command)).toEqual(["ls -la"]);
});
test("candidate: pre_tool_use rewrite passes a write into read-only plan handler", async () => {
 const hooks=new HookRegistry(); hooks.register("pre_tool_use",()=>({updatedInput:{command:"echo x > result.txt"}}));
 const {e,seen}=executor("Bash",hooks,{planMode:true}); const r=await e.executeSingle({id:"rewrite",toolName:"Bash",args:{command:"ls -la"}});
 expect(r.isError).toBe(false); expect(seen[0].command).toBe("echo x > result.txt"); console.log("plan rewrite evidence",JSON.stringify({result:r,handlerArgs:seen.map(x=>({command:x.command}))}));
});
test("MCP policy normal control rejects forbidden target before handler", async () => {
 const ctx={allowedMcpServers:new Set(["fixture"]),mcpToolPolicies:new Map([["fixture",{disabledTools:new Set(["delete_all"])}]])};
 const {e,seen}=executor("MCPTool",new HookRegistry(),ctx); const r=await e.executeSingle({id:"direct",toolName:"MCPTool",args:{server:"fixture",tool:"delete_all"}});
 expect(r.isError).toBe(true); expect(seen).toHaveLength(0);
});
test("candidate: rewritten MCPTool target bypasses disabledTools", async () => {
 const hooks=new HookRegistry(); hooks.register("pre_tool_use",()=>({updatedInput:{server:"fixture",tool:"delete_all"}}));
 const ctx={allowedMcpServers:new Set(["fixture"]),mcpToolPolicies:new Map([["fixture",{disabledTools:new Set(["delete_all"])}]])};
 const {e,seen}=executor("MCPTool",hooks,ctx); const r=await e.executeSingle({id:"rewritten",toolName:"MCPTool",args:{server:"fixture",tool:"list"}});
 expect(r.isError).toBe(false); expect(seen[0].tool).toBe("delete_all"); console.log("MCP rewrite evidence",JSON.stringify({result:r,target:seen.map(x=>({server:x.server,tool:x.tool}))}));
});
test("candidate: session A can cancel B's child through production executor/builtin", async () => {
 let aborts=0; asyncAgentRegistry.register({agentId:"b-child",description:"B owned",sessionId:"session-b",childSessionId:"b-child",status:"running",startedAt:Date.now(),abort:()=>{aborts++}});
 expect(await agentStatusTool({agent_id:"b-child"},{sessionId:"session-a"} as any)).toContain("not in this session");
 expect(await agentStatusTool({all:true},{sessionId:"session-a"} as any)).toContain("b-child");
 const {e}=executor("AgentCancel",new HookRegistry(),{sessionId:"session-a"}); const r=await e.executeSingle({id:"cancel-other",toolName:"AgentCancel",args:{agent_id:"b-child"}});
 expect(r.isError).toBe(false); expect(aborts).toBe(1); expect(asyncAgentRegistry.get("b-child")?.status).toBe("cancelled"); console.log("cross-session cancel evidence",JSON.stringify({caller:"session-a",owner:"session-b",result:r,aborts}));
});
test("normal: session B can cancel its own child", async () => {
 let aborts=0; asyncAgentRegistry.register({agentId:"b-own",description:"B owned",sessionId:"session-b",childSessionId:"b-own",status:"running",startedAt:Date.now(),abort:()=>{aborts++}});
 const {e}=executor("AgentCancel",new HookRegistry(),{sessionId:"session-b"}); const r=await e.executeSingle({id:"cancel-own",toolName:"AgentCancel",args:{agent_id:"b-own"}});
 expect(r.isError).toBe(false); expect(aborts).toBe(1);
});
test("candidate: cold child continuation replaces restricted role with default unrestricted role", async () => {
 process.env.CODE_SHELL_AGENT_BG_MS="0"; const requests:any[]=[]; const existing=new Set();
 const defs=[{name:"general-purpose",description:"general",systemPrompt:"general"},{name:"reviewer",description:"read only",systemPrompt:"read only",tools:["Read"],skills:[],mcp:[],sandbox:"seatbelt",model:"safe-model"}];
 const registry={list:()=>defs,get:(name:string)=>defs.find(d=>d.name===name)};
 const spawner={spawn:async(req:any)=>{requests.push(req);existing.add(req.agentId);return {text:"ok",sessionId:req.agentId};},sessionExists:(id:string)=>existing.has(id),getSessionParentId:(id:string)=>existing.has(id)?"parent-a":undefined,parentStream:()=>{},describe:()=>({cwd:"/tmp",permissionMode:"default"})};
 const ctx={sessionId:"parent-a",subAgentSpawner:spawner,agentDefinitions:registry};
 await agentTool({description:"review",prompt:"review only",agent_type:"reviewer"},ctx as any); const id=requests[0].agentId;
 await agentSendInputTool({agent_id:id,prompt:"continue warm"},ctx as any); expect(requests[1].toolAllowlist).toEqual(["Read"]); expect(requests[1].skillAllowlist).toEqual([]);
 asyncAgentRegistry.reset(); await agentSendInputTool({agent_id:id,prompt:"continue cold"},ctx as any);
 expect(requests[2].resumeSessionId).toBe(id); expect(requests[2].agentType).toBe("general-purpose"); expect(requests[2].toolAllowlist).toBeUndefined(); expect(requests[2].skillAllowlist).toBeUndefined(); expect(requests[2].mcpAllowlist).toBeUndefined(); expect(requests[2].sandboxMode).toBeUndefined();
 console.log("cold continuation evidence",JSON.stringify(requests.map(({agentId,resumeSessionId,agentType,toolAllowlist,skillAllowlist,mcpAllowlist,sandboxMode,model})=>({agentId,resumeSessionId,agentType,toolAllowlist,skillAllowlist,mcpAllowlist,sandboxMode,model}))));
});
function sse(events:any[]) {return events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");}
function anthropicEvents(text:string,fail=false) {return [
 {type:"message_start",message:{id:"msg-fixture",type:"message",role:"assistant",model:"claude-sonnet-4-6",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:2,output_tokens:0}}},
 {type:"content_block_start",index:0,content_block:{type:"text",text:""}}, {type:"content_block_delta",index:0,delta:{type:"text_delta",text}},
 ...(fail?[{type:"error",error:{type:"overloaded_error",message:"fixture interrupted after visible text"}}]:[{type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:2}},{type:"message_stop"}])];}
test("candidate: Anthropic SDK fetch streaming retry concatenates failed and successful text without tombstone", async () => {
 let sends=0; const fetchStub=async(input:any)=>{expect(new URL(String(input)).origin).toBe("http://fixture.invalid"); sends++; return new Response(sse(anthropicEvents(sends===1?"FAILED PREFIX":"SUCCESS",sends===1)),{headers:{"content-type":"text/event-stream"}});};
 const client=new AnthropicClient({provider:"anthropic",model:"claude-sonnet-4-6",apiKey:"synthetic",baseUrl:"http://fixture.invalid"},{fetch:fetchStub as any,retryMaxAttempts:2});
 const facade=new ModelFacade(client,Transcript.inMemory("anthropic-review")); const events:any[]=[]; const r=await facade.call("system",[{role:"user",content:"synthetic"}],[],e=>events.push(e));
 expect(sends).toBe(2); expect(r.text).toBe("SUCCESS"); expect(events.filter(e=>e.type==="text_delta").map(e=>e.text).join("")).toBe("FAILED PREFIXSUCCESS"); expect(events.some(e=>e.type==="tombstone")).toBe(false);
 console.log("Anthropic retry evidence",JSON.stringify({sends,responseText:r.text,streamEvents:events}));
});
test("normal: Anthropic successful stream emits only successful text", async () => {
 let sends=0; const fetchStub=async()=>{sends++;return new Response(sse(anthropicEvents("SUCCESS")),{headers:{"content-type":"text/event-stream"}});};
 const client=new AnthropicClient({provider:"anthropic",model:"claude-sonnet-4-6",apiKey:"synthetic",baseUrl:"http://fixture.invalid"},{fetch:fetchStub as any,retryMaxAttempts:2}); const events:any[]=[]; const r=await new ModelFacade(client,Transcript.inMemory("normal")).call("s",[{role:"user",content:"synthetic"}],[],e=>events.push(e));
 expect(sends).toBe(1);expect(events.filter(e=>e.type==="text_delta").map(e=>e.text).join("")).toBe(r.text);
});
test("candidate: refreshing authCommand cache leaves same SDK client's Authorization frozen", async () => {
 const command="review-fixture-token-command-never-executed"; resolveAuthCommand(command,{runCommand:()=>"token-first"}); const headers:string[]=[];
 const fetchStub=async(_input:any,init:any)=>{headers.push(new Headers(init.headers).get("authorization")??"");return Response.json({id:"fixture",choices:[{message:{role:"assistant",content:"ok"},finish_reason:"stop",index:0}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});};
 const config={provider:"openai",model:"gpt-4o",authCommand:command,baseUrl:"http://fixture.invalid"}; const defaults={fetch:fetchStub as any,retryMaxAttempts:1}; const client=new OpenAIClient(config,defaults); const options={systemPrompt:"s",messages:[{role:"user",content:"synthetic"}],stream:false} as any;
 await client.createMessage(options); __clearAuthTokenCache(); resolveAuthCommand(command,{runCommand:()=>"token-fresh"}); await client.createMessage(options); await new OpenAIClient(config,defaults).createMessage(options);
 expect(headers).toEqual(["Bearer token-first","Bearer token-first","Bearer token-fresh"]);console.log("auth refresh evidence",JSON.stringify({sameClient:headers.slice(0,2),freshClient:headers[2],processesSpawned:0}));
});
