import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const prior=process.cwd();
const arenaRoot=mkdtempSync(join(tmpdir(), "codeshell-arena-git-review-"));
process.chdir(arenaRoot);
execFileSync("git",["init","-b","main"],{stdio:"ignore"});
writeFileSync(join(arenaRoot,"example.txt"),"owned arena fixture content\n");
execFileSync("git",["add","example.txt"]);
execFileSync("git",["-c","user.name=Review Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"],{stdio:"ignore"});
const {executeContextTool}=await import("/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/arena/src/context/context-tools.ts");
test("Arena git_show treats object selector as a path while direct git and read_file work",()=>{
 const direct=execFileSync("git",["show","HEAD:example.txt"],{encoding:"utf8"});
 const actual=executeContextTool({id:"git",toolName:"git_show",args:{ref:"HEAD:example.txt"}});
 const read=executeContextTool({id:"read",toolName:"read_file",args:{path:"example.txt"}});
 expect(direct).toContain("owned arena fixture content");
 expect(read).toContain("owned arena fixture content");
 expect(actual).toBe("Could not resolve: HEAD:example.txt");
 console.log(JSON.stringify({case:"arena-git-show",direct:direct.trim(),actual,read}));
});
const roots=[];
afterAll(()=>{process.chdir(prior);for(const root of [arenaRoot,...roots])rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({ownedRootsRemoved:[arenaRoot,...roots].every(root=>!require("node:fs").existsSync(root))}));});
const { OptimizationLabController } = await import("/Users/admin/.codex/worktrees/remaining-modules-review-20261012/codeshell/packages/optimization-lab/src/controller.ts");
function setup(
  options: any = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "lab-engine-"));
  roots.push(cwd);
  const skillDir = join(cwd, ".agents", "skills", "lab-test");
  mkdirSync(skillDir, { recursive: true });
  const skill =
    "---\nname: lab-test\ndescription: Standalone text test\n---\nSummarize the current source.\n";
  writeFileSync(join(skillDir, "SKILL.md"), skill);
  const dataset = {
    schemaVersion: 1,
    title: "Sourcing",
    taskFamily: "sourcing",
    cases: Array.from({ length: 6 }, (_, i) => ({
      id: `${i < 3 ? "dev" : "hold"}-${i}`,
      version: 1,
      sourceGroupId: `source-${i}`,
      provenance: "synthetic",
      caseRole: i === 0 ? "regression" : "target_failure",
      split: i < 3 ? "dev" : "holdout",
      input: `Summarize source ${i}.`,
      hardAssertions: options.semanticRegression
        ? []
        : [{ id: "cites", kind: "contains", value: "[S1]" }],
      rubric: options.human
        ? [{ id: "clear", text: "Answer addresses the current source", requiresHumanGrading: true }]
        : [],
      readiness: "runnable",
    })),
  };
  const settings = {
    credentials: [
      {
        id: "lab-key",
        catalogId: "openai",
        apiKey: "fake-secret",
        baseUrl: "http://localhost:9100/v1",
      },
    ],
    modelConnections: [
      { id: "lab", catalogId: "openai", tag: "text", model: "lab-model", credentialId: "lab-key" },
    ],
    defaults: { text: "lab" },
  };
  const payloads: any[] = [];
  let enabled = true;
  const upstream =
    options.upstream ??
    ((async (request: Request) => {
      const payload = await request.json();
      payloads.push(payload);
      const system = JSON.stringify(payload.messages?.[0]);
      const optimizer = system.includes("reflect_once_v1");
      const text = optimizer
        ? JSON.stringify({
            candidates: [
              {
                body: "Summarize the source and cite [S1].",
                explanation: "Require explicit source citations",
                sourceCaseIds: ["dev-0", "dev-1", "dev-2"],
              },
            ],
          })
        : options.regression && JSON.stringify(payload.messages.at(-1)).includes("source 0")
          ? system.includes("cite [S1]")
            ? "Summary without a citation"
            : "Summary [S1]"
          : system.includes("cite [S1]")
            ? "Summary [S1]"
            : "Summary without a citation";
      return new Response(
        JSON.stringify({
          id: "response",
          object: "chat.completion",
          created: 1,
          model: "lab-model",
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
            cost: 0.001,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);
  const controller = new OptimizationLabController(cwd, {
    root: join(cwd, "lab-store"),
    loadSettings: () => settings,
    enabled: () => enabled,
    upstream,
  });
  const prepared = controller.prepare({
    cwd,
    dataset,
    skillName: "lab-test",
    targetConnectionId: "lab",
    optimizerConnectionId: "lab",
    objective: "quality",
    limits: {
      maxRequests: options.maxRequests ?? 30,
      maxExecutionMs: 60000,
      maxOutputTokens: 1000,
      timeoutMs: 1000,
      maxCandidates: 1,
      repeats: 1,
    },
  });
  const grant = controller.grant(prepared.id, {
    expectedRevision: prepared.state.revision,
    planHash: prepared.plan.planHash,
    operationId: "native-confirm-1",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    limits: { maxRequests: options.maxRequests ?? 30, maxExecutionMs: 60000 },
  });
  return {
    controller,
    prepared,
    grant,
    payloads,
    settings,
    cwd,
    skillPath: join(skillDir, "SKILL.md"),
    skill,
    disable: () => {
      enabled = false;
    },
  };
}

test("Lab cold stop records stop but get recovers active snapshot as interrupted; ordinary stopped idle is cancelled",()=>{
 const s=setup();const id=s.prepared.id;
 const fence=s.controller.lease.acquire(id);
 s.controller.store.mutate(id,{fence},state=>{state.status="baselining";});
 s.controller.lease.release(id,fence);
 const cold=new OptimizationLabController(s.cwd,s.controller.options);
 const before=cold.store.read(id);
 const stopped=cold.stop(id,before.state.revision);
 const reread=cold.get(id);
 expect(stopped.state.stopRequested).toBe(true);
 expect(stopped.state.status).toBe("baselining");
 expect(reread.state.status).toBe("interrupted");
 const ordinary=setup();
 expect(ordinary.controller.stop(ordinary.prepared.id,ordinary.grant.state.revision).state.status).toBe("cancelled");
 console.log(JSON.stringify({case:"lab-cold-stop",stoppedStatus:stopped.state.status,recoveredStatus:reread.state.status,stopRequested:reread.state.stopRequested,requests:s.payloads.length}));
});
