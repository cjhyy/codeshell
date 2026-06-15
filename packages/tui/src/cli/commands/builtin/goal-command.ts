/**
 * /goal — set, inspect, or clear a persistent goal (CC `/goal` style).
 *
 *   /goal <condition>   set a persistent goal and start working toward it.
 *                       It survives across sends and interrupts until the
 *                       judge says it's met or you clear it.
 *   /goal               show the current active goal (if any).
 *   /goal clear         clear the active goal (aliases: off, stop, none, reset, cancel).
 *
 * The heavy lifting (persist on session, judge each turn, clear on met) lives
 * in core; this command just wires the objective onto the next run and offers
 * a clear/status affordance, mirroring the desktop UI.
 */

import type { SlashCommand } from "../registry.js";

const CLEAR_ALIASES = new Set(["clear", "off", "stop", "none", "reset", "cancel"]);

export const goalCommand: SlashCommand = {
  name: "/goal",
  description: "设定/查看/清除一个持久目标(达成或手动清除前一直生效)",
  usage: "/goal <目标> | /goal | /goal clear",
  group: "core",
  execute: async (arg, ctx) => {
    const trimmed = arg.trim();

    // Bare `/goal` → status.
    if (!trimmed) {
      if (ctx.activeGoal) {
        ctx.addStatus(`◎ 当前目标:${ctx.activeGoal}\n（达成或 /goal clear 前一直生效）`);
      } else {
        ctx.addStatus("当前没有活跃目标。用 /goal <目标> 设定一个。");
      }
      return;
    }

    // `/goal clear` (and aliases) → clear.
    if (CLEAR_ALIASES.has(trimmed.toLowerCase())) {
      if (!ctx.clearGoal) {
        ctx.addStatus("此环境不支持清除目标。");
        return;
      }
      const cleared = await ctx.clearGoal();
      ctx.addStatus(cleared ? "✓ 已清除目标。" : "当前没有活跃目标。");
      return;
    }

    // `/goal <condition>` → set + run.
    if (!ctx.submitGoal) {
      ctx.addStatus("此环境不支持设定目标。");
      return;
    }
    ctx.addStatus(`◎ 目标已设定:${trimmed}\n开始执行,达成或 /goal clear 前一直生效。`);
    ctx.submitGoal(trimmed);
  },
};
