/**
 * Goal mode stop hook.
 *
 * Registered on the `on_stop` event (see events.ts / turn-loop.ts) when a
 * session is started with a goal. When the model tries to stop, this hook
 * makes ONE bounded judgment call against the session model — "is the goal
 * met? if not, what's left?" — and, if the goal isn't met, returns
 * `continueSession: true` with a continuation message so the turn loop
 * keeps working instead of returning "completed".
 *
 * This mirrors Claude Code's Stop-hook mechanism: the core loop stays
 * dumb (no built-in goal judge), and the "are we done?" decision lives in
 * the hook. The consecutive-block cap that prevents infinite looping lives
 * in TurnLoop (maxStopBlocks), not here.
 *
 * Failure is conservative: if the judge call throws or returns text we
 * can't parse, we ALLOW the stop (return {}). A flaky judge must never
 * wedge a session into an unstoppable loop.
 */
import type { HookContext, HookResult } from "./events.js";
import type { HookHandler } from "./registry.js";
import type { LLMResponse } from "../types.js";

/** Narrow LLM surface the judge needs — just a one-shot completion. */
export interface GoalJudgeLLM {
  createMessage(options: {
    systemPrompt: string;
    messages: { role: "user" | "assistant" | "system"; content: string }[];
    stream?: boolean;
    maxTokens?: number;
    recordUsage?: boolean;
    signal?: AbortSignal;
  }): Promise<LLMResponse>;
}

interface GoalLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export interface GoalStopHookOptions {
  llm: GoalJudgeLLM;
  log: GoalLogger;
  /** Override the goal instead of reading ctx.data.goal (mainly for tests). */
  goal?: string;
}

const JUDGE_SYSTEM =
  "你是一个目标完成度裁判。给定一个目标和 agent 最近的输出,判断目标是否已经" +
  "完全达成。只返回一个 JSON 对象,形如 " +
  '{"met": true|false, "gaps": "若未达成,简述还差什么;达成则空串"}。' +
  "不要输出任何额外文字。宁可严格:只有确信目标已完全完成时才返回 met:true。";

/** Pull the first balanced JSON object out of possibly-prose text. */
function extractJson(text: string): { met: boolean; gaps: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.met !== "boolean") return null;
    const gaps = typeof p.gaps === "string" ? p.gaps : "";
    return { met: p.met, gaps };
  } catch {
    return null;
  }
}

export function createGoalStopHook(opts: GoalStopHookOptions): HookHandler {
  const { llm, log } = opts;
  return async (ctx: HookContext): Promise<HookResult> => {
    const rawGoal =
      opts.goal ?? (typeof ctx.data.goal === "string" ? ctx.data.goal : "");
    const goal = rawGoal.trim();
    // No goal → not Goal mode → allow stop.
    if (!goal) return {};

    const finalText =
      typeof ctx.data.finalText === "string" ? ctx.data.finalText : "";

    let verdict: { met: boolean; gaps: string } | null = null;
    try {
      const resp = await llm.createMessage({
        systemPrompt: JUDGE_SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `目标:\n${goal}\n\n` +
              `agent 最近的输出:\n${finalText || "(无文本输出)"}\n\n` +
              "目标完全达成了吗?按要求只返回 JSON。",
          },
        ],
        stream: false,
        maxTokens: 400,
        // Auxiliary sub-call — keep it out of the session cost/turn stats.
        recordUsage: false,
      });
      verdict = extractJson(resp.text ?? "");
    } catch (err) {
      log.warn("goal_stop.judge_failed", {
        cat: "goal",
        error: (err as Error).message,
      });
      return {}; // conservative: allow stop
    }

    if (!verdict) {
      log.warn("goal_stop.unparseable", { cat: "goal" });
      return {}; // conservative: allow stop
    }

    if (verdict.met) {
      log.info("goal_stop.met", { cat: "goal" });
      return {};
    }

    log.info("goal_stop.not_met", { cat: "goal", gaps: verdict.gaps });
    const gaps = verdict.gaps.trim();
    return {
      continueSession: true,
      messages: [
        gaps
          ? `继续 —— 目标尚未达成。还差:${gaps}`
          : "继续 —— 目标尚未达成,请接着完成它。",
      ],
    };
  };
}
