/**
 * /goal — set, inspect, or control a persistent goal (CC `/goal` style).
 *
 *   /goal <condition>   set a persistent goal and start working toward it.
 *                       It survives across sends and interrupts until the
 *                       judge says it's met or you clear it.
 *   /goal               show the current active goal (if any).
 *   /goal edit <text>   edit it without creating a second run.
 *   /goal pause|resume  pause/resume it at the next safe turn boundary.
 *   /goal delete        permanently delete it (`clear` and old aliases work too).
 *
 * The heavy lifting (persist on session, judge each turn, clear on met) lives
 * in core; this command just wires the objective onto the next run and offers
 * a clear/status affordance, mirroring the desktop UI.
 */

import type { SlashCommand } from "../registry.js";

const DELETE_ALIASES = new Set(["delete", "clear", "off", "stop", "none", "reset", "cancel"]);

export type ParsedGoalCommand =
  | { kind: "status" }
  | { kind: "set"; objective: string }
  | { kind: "edit"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "delete" }
  | { kind: "usage"; message: string };

/**
 * Parse `/goal` arguments once for both dispatch and running-command safety.
 * Reserved control words never fall through to a new objective when their
 * arguments are malformed.
 */
export function parseGoalCommand(arg: string): ParsedGoalCommand {
  const trimmed = arg.trim();
  if (!trimmed) return { kind: "status" };

  const [rawAction = "", ...rest] = trimmed.split(/\s+/);
  const action = rawAction.toLowerCase();

  if (action === "edit") {
    const objective = rest.join(" ").trim();
    return objective
      ? { kind: "edit", objective }
      : { kind: "usage", message: "用法：/goal edit <新目标>" };
  }

  if (action === "pause" || action === "resume") {
    return rest.length === 0
      ? { kind: action }
      : { kind: "usage", message: `用法：/goal ${action}` };
  }

  if (DELETE_ALIASES.has(action)) {
    return rest.length === 0
      ? { kind: "delete" }
      : { kind: "usage", message: `用法：/goal ${action}` };
  }

  return { kind: "set", objective: trimmed };
}

/** `/goal` forms that cannot start a second model run. */
export function canExecuteGoalCommandWhileRunning(arg: string): boolean {
  return parseGoalCommand(arg).kind !== "set";
}

async function updateGoal(
  ctx: Parameters<SlashCommand["execute"]>[1],
  patch: { objective?: string; paused?: boolean },
  success: string,
): Promise<void> {
  if (!ctx.activeGoal) {
    ctx.addStatus("当前没有活跃目标。");
    return;
  }
  if (!ctx.updateGoal) {
    ctx.addStatus("此环境不支持运行中修改目标。");
    return;
  }
  if (ctx.activeGoalLegacy) {
    ctx.addStatus("当前 Core 版本不支持安全编辑/暂停，请升级后重试。");
    return;
  }
  if (ctx.activeGoalVersionReady === false) {
    ctx.addStatus("目标版本尚未同步，请稍后重试。");
    return;
  }
  const updated = await ctx.updateGoal(patch);
  ctx.addStatus(updated ? success : "目标已被其他控制操作更新，请重试。");
}

export const goalCommand: SlashCommand = {
  name: "/goal",
  description: "设定/查看/编辑/暂停/恢复/删除持久目标",
  usage: "/goal <目标> | edit <目标> | pause | resume | delete",
  group: "core",
  execute: async (arg, ctx) => {
    const parsed = parseGoalCommand(arg);

    // Bare `/goal` → status.
    if (parsed.kind === "status") {
      if (ctx.activeGoal) {
        const state = ctx.activeGoalPaused ? "已暂停" : "已激活";
        ctx.addStatus(
          `◎ 当前目标（${state}）:${ctx.activeGoal}\n` +
            (ctx.activeGoalPaused
              ? "用 /goal resume 恢复，或 /goal delete 删除。"
              : "达成、暂停或删除前一直生效；若运行已中断，用 /goal resume 继续。"),
        );
      } else {
        ctx.addStatus("当前没有活跃目标。用 /goal <目标> 设定一个。");
      }
      return;
    }

    if (parsed.kind === "usage") {
      ctx.addStatus(parsed.message);
      return;
    }

    if (parsed.kind === "edit") {
      await updateGoal(ctx, { objective: parsed.objective }, `✓ 目标已编辑:${parsed.objective}`);
      return;
    }

    if (parsed.kind === "pause") {
      if (ctx.activeGoalPaused) {
        ctx.addStatus("目标已经暂停。");
        return;
      }
      await updateGoal(ctx, { paused: true }, "⏸ 已暂停目标；当前模型/工具调用结束后生效。");
      return;
    }

    if (parsed.kind === "resume") {
      await updateGoal(ctx, { paused: false }, "▶ 已请求继续目标；将在下一个安全边界继续。");
      return;
    }

    // `/goal delete` and legacy clear aliases all use revision-fenced delete
    // when available. `goalClear` remains a compatibility fallback for older
    // protocol servers.
    if (parsed.kind === "delete") {
      if (ctx.activeGoal && ctx.activeGoalVersionReady === false && ctx.activeGoalLegacy !== true) {
        ctx.addStatus("目标版本尚未同步，请稍后重试。");
        return;
      }
      const remove = ctx.deleteGoal ?? ctx.clearGoal;
      if (!remove) {
        ctx.addStatus("此环境不支持删除目标。");
        return;
      }
      const deleted = await remove();
      ctx.addStatus(deleted ? "✓ 已删除目标。" : "当前没有活跃目标，或目标已被更新。");
      return;
    }

    // `/goal <condition>` → set + run.
    if (!ctx.submitGoal) {
      ctx.addStatus("此环境不支持设定目标。");
      return;
    }
    ctx.addStatus(`◎ 目标已设定:${parsed.objective}\n开始执行，达成、暂停或删除前一直生效。`);
    ctx.submitGoal(parsed.objective);
  },
};
