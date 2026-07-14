/** Scheduling decision for a continued external coding-agent run. */
export interface JudgeDecision {
  action: "continue-same" | "continue-fresh" | "stop";
  handoffSummary?: string;
  reason: string;
}

export interface JudgeInput {
  goal?: string;
  lastResult: string;
  nextPrompt: string;
}

/** Injected aux-model call: takes a prompt, returns raw text. */
export type AuxLlm = (prompt: string) => Promise<string>;

const SYSTEM = `You decide how a scheduled task loop should continue after one run.
Reply with ONLY a JSON object: {"action": "continue-same"|"continue-fresh"|"stop", "handoffSummary"?: string, "reason": string}.
- "stop": the goal is met; no more runs needed.
- "continue-same": next run should resume the SAME session (work is related, keep context).
- "continue-fresh": next run should start a FRESH session because the next step is unrelated to what was just done; put a short context summary in handoffSummary.`;

export function buildJudgePrompt(input: JudgeInput): string {
  return [
    SYSTEM,
    input.goal ? `\nOverall goal: ${input.goal}` : "",
    `\nWhat the last run produced:\n${input.lastResult.slice(0, 4000)}`,
    `\nThe next scheduled prompt:\n${input.nextPrompt}`,
    `\nDecision JSON:`,
  ].join("\n");
}

export function parseJudgeResponse(raw: string): JudgeDecision {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const d = JSON.parse(m ? m[0] : raw);
    if (d.action === "stop" || d.action === "continue-fresh" || d.action === "continue-same") {
      return {
        action: d.action,
        handoffSummary: typeof d.handoffSummary === "string" ? d.handoffSummary : undefined,
        reason: typeof d.reason === "string" ? d.reason : "",
      };
    }
  } catch {
    /* fall through */
  }
  return {
    action: "continue-same",
    reason: "unparseable judge output; defaulting to continue-same",
  };
}

export async function judgeContinuation(input: JudgeInput, llm: AuxLlm): Promise<JudgeDecision> {
  const raw = await llm(buildJudgePrompt(input));
  return parseJudgeResponse(raw);
}
