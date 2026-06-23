import type { CronScheduler } from "../automation/scheduler.js";
import type { CCTaskStore, CCTaskMeta } from "./cc-task-store.js";
import type { JudgeDecision, JudgeInput } from "./relevance-judge.js";
import type { AgentRunResult } from "./external-agent-driver.js";

export type CCRunner = (opts: { prompt: string; resumeSessionId?: string; cwd: string; permissionMode?: CCTaskMeta["permissionMode"] }) => Promise<AgentRunResult>;
export type CCJudge = (input: JudgeInput) => Promise<JudgeDecision>;

export interface RunCCTaskDeps {
  jobId: string;
  prompt: string;
  cwd: string;
  store: CCTaskStore;
  runner: CCRunner;
  judge: CCJudge;
  scheduler: CronScheduler;
}

/** Execute ONE scheduled CC task run: pick session by continuation, run, write
 *  back sessionId, then (loop+auto only) judge continue/fresh/stop. */
export async function runCCTask(deps: RunCCTaskDeps): Promise<void> {
  const { jobId, cwd, store, runner, judge, scheduler } = deps;
  const meta = store.get(jobId) ?? ({ kind: "once", continuation: "auto" } as CCTaskMeta);

  // 1. choose session
  const resumeSessionId = meta.continuation === "always-fresh" ? undefined : meta.sessionId;

  // 2. inject handoff summary as prompt prefix if a prior fresh decision left one
  const prompt = meta.handoffSummary ? `${meta.handoffSummary}\n\n${deps.prompt}` : deps.prompt;

  // 3. run one turn
  const result = await runner({ prompt, resumeSessionId, cwd, permissionMode: meta.permissionMode });

  // 4. write back sessionId; clear consumed handoff
  store.patch(jobId, { sessionId: result.sessionId || meta.sessionId, handoffSummary: undefined });

  // 5. once → done
  if (meta.kind === "once") { scheduler.pause(jobId); return; }

  // 6. loop: only "auto" consults the judge
  if (meta.continuation !== "auto") return;
  const decision = await judge({ goal: meta.goal, lastResult: result.finalText, nextPrompt: deps.prompt });
  if (decision.action === "stop") { scheduler.pause(jobId); return; }
  if (decision.action === "continue-fresh") {
    store.patch(jobId, { sessionId: undefined, handoffSummary: decision.handoffSummary });
  }
  // continue-same: keep sessionId as written in step 4
}
