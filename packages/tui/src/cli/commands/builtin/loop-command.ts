import type { SlashCommand } from "../registry.js";

export function buildLoopCommandPrompt(rawArguments: string): string {
  const command = rawArguments.trim() ? `/loop ${rawArguments.trim()}` : "/loop";
  return [
    "Handle the following CodeShell standalone /loop command.",
    "Use the project skill named loop-mode and follow its command semantics and durable .loop state contract.",
    "This is not Goal mode: do not create, update, resume, pause, delete, or depend on a CodeShell Goal.",
    `Original command: ${command}`,
  ].join("\n");
}

export const loopCommand: SlashCommand = {
  name: "/loop",
  description: "启动或管理独立长时循环（不使用 Goal）",
  usage: "/loop <目标>",
  group: "core",
  execute: async (arg, ctx) => {
    if (!ctx.submitPrompt) {
      ctx.addStatus("此环境不支持 /loop。");
      return;
    }
    const displayText = arg.trim() ? `/loop ${arg.trim()}` : "/loop";
    const accepted = await ctx.submitPrompt(buildLoopCommandPrompt(arg), displayText, {
      disableGoal: true,
    });
    if (accepted === false) ctx.addStatus("当前轮次正在运行，请稍后再试 /loop。");
  },
};
