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
 * Failure does NOT allow the stop (Goal mode P0, 2026-06-02): if the judge
 * call throws or returns unparseable text, we return continueSession:true and
 * nudge the model to keep going — silently allowing the stop in an unattended
 * run would make the goal fail without anyone noticing. The backstop against
 * an unsatisfiable goal looping forever is NOT this hook; it's the turn-loop's
 * run-scoped budget guardrail (token/time) plus maxStopBlocks.
 */
import type { HookContext, HookResult } from "./events.js";
import type { HookHandler } from "./registry.js";
import type { LLMResponse } from "../types.js";
import { normalizeGoal, type GoalConfig } from "../engine/goal.js";
import { backgroundJobRegistry } from "../tool-system/builtin/background-jobs.js";

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
  goal?: string | GoalConfig;
  /**
   * Called once when the judge first returns met:true, before this handler
   * returns. The engine uses it to clear the session's persisted activeGoal so
   * a later bare send doesn't re-inherit a satisfied goal. Optional so tests /
   * non-persistent callers can omit it.
   */
  onMet?: () => void;
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
    // Accept string or GoalConfig from either the override or ctx.data.goal.
    const g = normalizeGoal(
      opts.goal ?? (ctx.data.goal as string | GoalConfig | undefined),
    );
    // No goal → not Goal mode → allow stop.
    if (!g) return {};
    const goal = g.objective;

    // Background-work short-circuit (s-mqe0ox7n-a8d11c26 bug): if this session
    // has a background job still running (e.g. a GenerateVideo poll loop), the
    // goal can't possibly be met yet AND the only remaining work is to WAIT.
    // Forcing continueSession here makes the model invent busywork (`sleep 30`,
    // manual API polling) — the exact failure we're fixing. Allow the stop so
    // the turn ends cleanly; Engine.run's wait-for-background loop then parks
    // until the job's completion notification lands and runs one summarize
    // turn, where the goal IS re-judged normally. We don't even call the judge
    // (saves an LLM round-trip on every stop while a video renders).
    const sessionId = ctx.data.sessionId;
    if (typeof sessionId === "string" && backgroundJobRegistry.hasRunningForSession(sessionId)) {
      log.info("goal_stop.waiting_on_background_job", { cat: "goal", sessionId });
      return {};
    }

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
      // P0: do NOT silently allow stop on judge failure — in unattended runs
      // that means the goal silently fails. Nudge to continue instead; the
      // run-scoped budget guardrail (turn-loop) is the real safety backstop
      // that prevents an unsatisfiable goal from looping forever.
      return {
        continueSession: true,
        messages: [
          "继续 —— 目标完成度无法判定,请继续推进直到明确完成(或调用 complete_goal 声明完成)。",
        ],
      };
    }

    if (!verdict) {
      log.warn("goal_stop.unparseable", { cat: "goal" });
      // P0: same as the throw path — unparseable judge output must not be
      // treated as "done". Continue instead of silently allowing the stop.
      return {
        continueSession: true,
        messages: [
          "继续 —— 目标完成度无法判定,请继续推进直到明确完成(或调用 complete_goal 声明完成)。",
        ],
      };
    }

    if (verdict.met) {
      log.info("goal_stop.met", { cat: "goal" });
      // Clear the persisted active goal (engine side-effect) so a later bare
      // send doesn't re-inherit a satisfied goal. Isolated so a throwing
      // callback can't block the stop.
      try {
        opts.onMet?.();
      } catch {
        /* ignore */
      }
      // Surface the verdict so the loop can emit a goal_progress(met) event.
      return { data: { goalVerdict: { met: true, gaps: "" } } };
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
      // Structured verdict for the UI — the loop emits goal_progress(not_met)
      // with this `gaps` instead of re-running the judge.
      data: { goalVerdict: { met: false, gaps } },
    };
  };
}
