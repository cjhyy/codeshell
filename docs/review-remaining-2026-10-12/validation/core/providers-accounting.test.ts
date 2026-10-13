import { afterAll, afterEach, expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
const denied: string[] = [];
const restores: (() => void)[] = [];
const deny = (...args: any[]) => { denied.push(String(args[0])); throw new Error("review owns zero network origins"); };
for (const [target,key] of [[globalThis,"fetch"],[http,"request"],[http,"get"],[https,"request"],[https,"get"],[net.Socket.prototype,"connect"],[dgram.Socket.prototype,"send"]] as const) {
 const obj=target as any; const old=obj[key]; obj[key]=deny; restores.push(()=>{obj[key]=old;});
}
syncBuiltinESMExports();
const root="/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/core/src";
const { AnthropicClient }=await import(`${root}/llm/providers/anthropic.ts`);
const { OpenAIClient }=await import(`${root}/llm/providers/openai.ts`);
const { resolveAuthCommand,__clearAuthTokenCache }=await import(`${root}/llm/provider-auth.ts`);
const { ModelFacade }=await import(`${root}/engine/model-facade.ts`);
const { TurnLoop }=await import(`${root}/engine/turn-loop.ts`);
const { Transcript }=await import(`${root}/session/transcript.ts`);
const { UsageLedger }=await import(`${root}/cost-ledger/store.ts`);
const { withUsageOwner }=await import(`${root}/cost-ledger/context.ts`);
afterEach(()=>__clearAuthTokenCache());
afterAll(()=>{expect(denied).toEqual([]);for(const restore of restores)restore();syncBuiltinESMExports();console.log("accounting fixture cleanup: memory ledgers only, 0 network attempts, 0 tool/program execution");});
function sse(events:any[]) {return events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");}
function events(text:string,prompt:number,fail=false){return [
 {type:"message_start",message:{id:"msg-fixture",type:"message",role:"assistant",model:"claude-sonnet-4-6",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:prompt,output_tokens:0}}},
 {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
 {type:"content_block_delta",index:0,delta:{type:"text_delta",text}},
 ...(fail?[{type:"error",error:{type:"overloaded_error",message:"fixture stream failure after reported input usage"}}]:[
 {type:"content_block_stop",index:0},
 {type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:2}},
 {type:"message_stop"}])];}
function loopFor(client:any,recorded:any[],out:any[]){
 const transcript=Transcript.inMemory("budget-review");
 const model=new ModelFacade(client,transcript);
 const deps:any={model,transcript,systemPrompt:"synthetic",tools:[],sessionId:"budget-review",ctxOverheadStore:{get:()=>0,set:()=>{}},
  toolExecutor:{setLogger(){},getInvestigationGuard(){},getTaskGuard(){},isConcurrencySafe(){return false;},executeSingle(){throw new Error("No tool is authorized in this fixture");}},
  contextManager:{manageAsync:async(m:any)=>m,manage:(m:any)=>m,recordActualUsage(){},shouldReactiveCompact(){return false;}},
  hooks:{emit:async(event:string)=>event==="on_stop"?{continueSession:true,messages:["synthetic continuation to test budget"]}:{}},
  recordCumulativeUsage:(u:any)=>{recorded.push(u);return undefined;}};
 return new TurnLoop(deps,{maxTurns:3,maxToolCallsPerTurn:1,goal:{objective:"synthetic incomplete",goalId:"g-budget",tokenBudget:6},onStream:(e:any)=>out.push(e)});
}
test("candidate: Goal launches another turn after failed-stream input tokens already exceed its budget",async()=>{
 const ledger=new UsageLedger({namespace:"review-budget"});const owner=ledger.owner("budget-review","run-budget");
 let sends=0;let knownBeforeThird=0;const recorded:any[]=[];const out:any[]=[];
 const fetchStub=async(input:any)=>{expect(new URL(String(input)).origin).toBe("http://fixture.invalid");sends++;if(sends===3)knownBeforeThird=ledger.summary().totalTokens;return new Response(sse(events(sends===1?"FAILED":"SUCCESS",sends===1?10:2,sends===1)),{headers:{"content-type":"text/event-stream"}});};
 const client=new AnthropicClient({provider:"anthropic",model:"claude-sonnet-4-6",apiKey:"synthetic",baseUrl:"http://fixture.invalid"},{fetch:fetchStub as any,retryMaxAttempts:2});
 const result=await withUsageOwner(owner,()=>loopFor(client,recorded,out).run([{role:"user",content:"synthetic"}]));
 expect(result.reason).toBe("goal_budget_exhausted");expect(sends).toBe(3);expect(knownBeforeThird).toBe(14);expect(recorded.map(u=>u.totalTokens)).toEqual([4,4]);expect(ledger.summary().totalTokens).toBe(18);expect(client.getUsage().totalTokens).toBe(8);
 console.log("Goal retry accounting evidence",JSON.stringify({budget:6,sends,knownBeforeThird,returnedUsage:recorded,ledger:ledger.summary(),resultReason:result.reason}));
});
test("normal: the same Goal stops before another request when over-budget usage is returned by the successful stream",async()=>{
 const ledger=new UsageLedger({namespace:"review-control"});const owner=ledger.owner("budget-review","run-control");let sends=0;const recorded:any[]=[];
 const fetchStub=async()=>{sends++;return new Response(sse(events("SUCCESS",10)),{headers:{"content-type":"text/event-stream"}});};
 const client=new AnthropicClient({provider:"anthropic",model:"claude-sonnet-4-6",apiKey:"synthetic",baseUrl:"http://fixture.invalid"},{fetch:fetchStub as any,retryMaxAttempts:2});
 const result=await withUsageOwner(owner,()=>loopFor(client,recorded,[]).run([{role:"user",content:"synthetic"}]));
 expect(result.reason).toBe("goal_budget_exhausted");expect(sends).toBe(1);expect(recorded[0].totalTokens).toBe(12);expect(ledger.summary().totalTokens).toBe(12);
});
test("candidate: Anthropic client also keeps stale authCommand API key after cache rotation",async()=>{
 const command="synthetic-review-auth-command-never-executed";resolveAuthCommand(command,{runCommand:()=>"token-first"});const headers:string[]=[];
 const fetchStub=async(_input:any,init:any)=>{headers.push(new Headers(init.headers).get("x-api-key")??"");return Response.json({id:"msg-fixture",type:"message",role:"assistant",model:"claude-sonnet-4-6",content:[{type:"text",text:"ok"}],stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:2,output_tokens:2}});};
 const config={provider:"anthropic",model:"claude-sonnet-4-6",authCommand:command,baseUrl:"http://fixture.invalid"};const defaults={fetch:fetchStub as any,retryMaxAttempts:1};const client=new AnthropicClient(config,defaults);const opts={systemPrompt:"s",messages:[{role:"user",content:"synthetic"}],stream:false} as any;
 await client.createMessage(opts);__clearAuthTokenCache();resolveAuthCommand(command,{runCommand:()=>"token-fresh"});await client.createMessage(opts);await new AnthropicClient(config,defaults).createMessage(opts);
 expect(headers).toEqual(["token-first","token-first","token-fresh"]);console.log("Anthropic auth rotation evidence",JSON.stringify(headers));
});
test.each([["openai",OpenAIClient,"gpt-4o"],["anthropic",AnthropicClient,"claude-sonnet-4-6"]] as const)("normal: %s pre-aborted request never reaches SDK fetch",async(provider,Client,model)=>{
 let sends=0;const controller=new AbortController();controller.abort();
 const client=new Client({provider,model,apiKey:"synthetic",baseUrl:"http://fixture.invalid"},{fetch:(async()=>{sends++;throw new Error("must not fetch");}) as any,retryMaxAttempts:2});
 let caught:any;try{await client.createMessage({systemPrompt:"s",messages:[{role:"user",content:"synthetic"}],signal:controller.signal,stream:false});}catch(e){caught=e;}
 expect(caught?.name).toBe("AbortError");expect(sends).toBe(0);
});
