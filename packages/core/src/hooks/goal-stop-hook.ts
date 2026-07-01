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
import { listRunningBackgroundWork } from "../tool-system/builtin/background-work.js";

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
   * Re-check whether the session STILL has a live persisted goal, evaluated
   * fresh each time the hook fires. The hook's `goal` above is frozen at
   * creation, so a goal cleared mid-run (user hit 清除 while a long-lived
   * run kept going) would otherwise be judged forever off the stale copy —
   * the unregister path in Engine.clearGoal only fires for the one in-flight
   * hook it tracks, which misses automation / resumed runs. When this returns
   * false the hook allows the stop immediately without calling the judge.
   * Injectable (reads SessionManager on the engine); omit to disable the
   * re-check (tests / non-persistent callers).
   */
  isGoalActive?: (sessionId: string) => boolean;
  /**
   * Called once when the judge first returns met:true, before this handler
   * returns. The engine uses it to clear the session's persisted activeGoal so
   * a later bare send doesn't re-inherit a satisfied goal. Optional so tests /
   * non-persistent callers can omit it.
   */
  onMet?: () => void;
  /**
   * Clock source for the current time fed to the judge. Injectable so tests
   * pin a fixed instant (the judge prompt is a fresh sub-call, not part of the
   * cached prefix, so a live clock here has no cache cost). Defaults to
   * `() => new Date()`.
   */
  now?: () => Date;
}

/**
 * Render the current instant for the judge: a human-readable local time plus
 * the numeric UTC offset and IANA zone, so the judge can reason about a
 * wall-clock deadline written into the objective (e.g. "until 12:00"). An LLM
 * has no clock — without this line it can never tell whether a time cutoff has
 * passed. Falls back gracefully if Intl is unavailable.
 */
function renderNow(now: Date): string {
  const iso = now.toISOString(); // unambiguous UTC anchor
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // e.g. "2026-07-01 12:11:32 GMT+8"
    const local = now.toLocaleString("sv-SE", {
      timeZoneName: "short",
    });
    return `${local} (时区 ${zone}；UTC 基准 ${iso})`;
  } catch {
    return iso;
  }
}

const JUDGE_SYSTEM =
  "你是一个目标完成度裁判。给定一个目标、agent 最近的输出,以及当前在后台运行的任务清单," +
  "判断目标状态。只返回一个 JSON 对象,形如 " +
  '{"met": true|false, "waiting": true|false, "gaps": "若未达成,简述还差什么;达成则空串"}。' +
  "三态语义:" +
  "(1) met:true —— 目标已完全达成。" +
  "(2) waiting:true —— 目标尚未达成,但剩下唯一要做的事就是等一个【会结束的】后台任务完成" +
  "(如下载、视频渲染、会退出的脚本),它完成后系统会自动唤醒你继续。此时应允许停下来等。" +
  "(3) 两者皆 false —— 目标未达成,且还有你能【主动去做】的事。" +
  "关键:【常驻服务】(如 dev server、watch、`npm run dev`/`bun run dev` 这类永不退出的进程)" +
  "不算‘在等的任务’——它永远在跑,目标若不依赖它就照常判断达成与否,绝不要因为它而返回 waiting。" +
  "时间截止:若目标里写了明确的时间截止(如“到 12:00 停”“until 15:00”“干到今晚 22 点”)," +
  "你会拿到【当前时间】(含时区),据此自行判断截止时刻是否已到、目标是否应当结束;解读截止以【当前时间】所在时区为准。" +
  "目标没有时间截止时,忽略当前时间,照常按内容判断。" +
  "不要输出任何额外文字。宁可严格:只有确信目标已完全完成时才返回 met:true。";

interface JudgeVerdict {
  met: boolean;
  waiting: boolean;
  gaps: string;
}

/** Pull the first balanced JSON object out of possibly-prose text. */
function extractJson(text: string): JudgeVerdict | null {
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
    const waiting = typeof p.waiting === "boolean" ? p.waiting : false;
    return { met: p.met, waiting, gaps };
  } catch {
    return null;
  }
}

/** Render the running background tasks for the judge prompt. */
function renderBackgroundTasks(
  items: { kind: string; description: string; detectedPort?: number }[],
): string {
  if (items.length === 0) return "(无)";
  const kindLabel: Record<string, string> = {
    subagent: "后台子代理",
    job: "后台任务",
    shell: "后台命令",
  };
  return items
    .map((i) => {
      // A listening port strongly implies a long-lived service (dev server) —
      // tell the judge so it doesn't classify it as a finite task to wait on.
      const portNote =
        i.detectedPort != null
          ? `(在 :${i.detectedPort} 监听端口,疑似常驻服务)`
          : "";
      return `- [${kindLabel[i.kind] ?? i.kind}] ${i.description}${portNote}`;
    })
    .join("\n");
}

export function createGoalStopHook(opts: GoalStopHookOptions): HookHandler {
  const { llm, log } = opts;
  const now = opts.now ?? (() => new Date());
  // Per-run cache: if the model emits the same final text with the same set of
  // running background tasks twice in a row (it stalls repeating itself), the
  // verdict can't have changed — reuse it instead of paying for another judge
  // call. Keyed on (finalText + rendered task list); a `met` verdict is never
  // cached (it ends the run anyway and triggers the onMet side-effect).
  let lastKey: string | null = null;
  let lastResult: HookResult | null = null;
  return async (ctx: HookContext): Promise<HookResult> => {
    // Accept string or GoalConfig from either the override or ctx.data.goal.
    const g = normalizeGoal(
      opts.goal ?? (ctx.data.goal as string | GoalConfig | undefined),
    );
    // No goal → not Goal mode → allow stop.
    if (!g) return {};
    const goal = g.objective;

    const sessionId = ctx.data.sessionId;

    // Re-check the LIVE goal each turn. `goal` above is frozen at hook creation,
    // so a goal cleared mid-run (清除) on a long-lived run (automation / resumed)
    // would keep being judged off the stale copy — Engine.clearGoal's unregister
    // only reaches the single in-flight hook it tracks. If the persisted goal is
    // gone, allow the stop now and skip the judge call entirely.
    if (
      opts.isGoalActive &&
      typeof sessionId === "string" &&
      sessionId.length > 0 &&
      !opts.isGoalActive(sessionId)
    ) {
      log.info("goal_stop.cleared_midrun", { cat: "goal" });
      return {};
    }

    // Background work is no longer a mechanical short-circuit. Instead we list
    // what's running and let the judge decide (s-mqe0ox7n-a8d11c26 bug): a
    // boolean "has background work" can't tell a finite download/render (→ wait
    // for the wakeup, allow stop) from a never-ending dev server (→ judge the
    // goal normally). The judge sees each task's kind + command and returns a
    // three-state verdict; `waiting:true` allows the stop without pushing.
    const runningWork =
      typeof sessionId === "string" && sessionId.length > 0
        ? listRunningBackgroundWork(sessionId)
        : [];
    const backgroundTasks = renderBackgroundTasks(runningWork);

    const finalText =
      typeof ctx.data.finalText === "string" ? ctx.data.finalText : "";

    const nowDate = now();
    const nowLabel = renderNow(nowDate);

    // Verdict cache key: same goal + same final text + same running tasks +
    // same MINUTE ⇒ verdict unchanged; skip the LLM call and replay it.
    // The minute bucket is in the key on purpose: if a goal has a wall-clock
    // deadline and the model stalls repeating identical output, a time-blind
    // key would replay a stale "not met" forever and the deadline would never
    // fire. Bucketing to the minute still absorbs same-minute repeats while
    // re-judging once the clock advances past a cutoff.
    const minuteBucket = nowDate.toISOString().slice(0, 16);
    const cacheKey = `${goal} ${finalText} ${backgroundTasks} ${minuteBucket}`;
    if (lastKey === cacheKey && lastResult) {
      log.info("goal_stop.verdict_cache_hit", { cat: "goal" });
      return lastResult;
    }

    const signal = ctx.data.signal as AbortSignal | undefined;

    let verdict: JudgeVerdict | null = null;
    try {
      const resp = await llm.createMessage({
        systemPrompt: JUDGE_SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `目标:\n${goal}\n\n` +
              `当前时间:${nowLabel}\n\n` +
              `agent 最近的输出:\n${finalText || "(无文本输出)"}\n\n` +
              `当前在后台运行的任务:\n${backgroundTasks}\n\n` +
              "判断目标状态,按要求只返回 JSON(met / waiting / gaps)。",
          },
        ],
        stream: false,
        maxTokens: 400,
        // Auxiliary sub-call — keep it out of the session cost/turn stats.
        recordUsage: false,
        // Let a user Stop mid-judge abort this call rather than block on it.
        signal,
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

    // waiting: goal not met, but the only remaining work is a FINITE background
    // task that will wake the session on completion. Allow the stop (no push) —
    // forcing continueSession here is exactly the busy-loop bug. The completion
    // notification wakes the idle session (server maybeWakeIdleSession) and the
    // goal is re-judged on that woken turn.
    //
    // GUARD: only honor `waiting` when real background work is actually running.
    // If the judge hallucinates waiting:true with an empty task list, allowing
    // the stop would silently abandon the goal — NOTHING would ever wake the
    // session (no notification to drain). So a baseless `waiting` falls through
    // to not_met (continueSession), where the model is nudged to keep working.
    if (verdict.waiting && runningWork.length > 0) {
      log.info("goal_stop.waiting_on_background_task", { cat: "goal", sessionId });
      const result: HookResult = {
        data: { goalVerdict: { met: false, gaps: verdict.gaps.trim() } },
      };
      lastKey = cacheKey;
      lastResult = result;
      return result;
    }
    if (verdict.waiting) {
      log.warn("goal_stop.waiting_without_background_work", { cat: "goal", sessionId });
    }

    log.info("goal_stop.not_met", { cat: "goal", gaps: verdict.gaps });
    const gaps = verdict.gaps.trim();
    const result: HookResult = {
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
    lastKey = cacheKey;
    lastResult = result;
    return result;
  };
}
