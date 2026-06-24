import type { ToolDefinition } from "../../types.js";
import { runAgentOnce } from "../../cc-orchestrator/external-agent-driver.js";
import { claudeAdapter } from "../../cc-orchestrator/agent-adapter.js";
import type { AgentRunResult } from "../../cc-orchestrator/external-agent-driver.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { notificationQueue } from "./agent-notifications.js";
import type { ToolContext } from "../context.js";

export const driveClaudeCodeToolDef: ToolDefinition = {
  name: "DriveClaudeCode",
  description:
    "Delegate a task to the external Claude Code CLI (drives `claude` for one turn). " +
    "Use to hand a coding/research task to Claude Code, or continue an existing CC session. " +
    "Runs in the BACKGROUND by default — CC tasks are typically long (minutes to hours), so this " +
    "returns immediately and CC's result is delivered to you later via a completion notification " +
    "that wakes you. Do NOT sleep-poll for it; just continue or end your turn — you'll be woken " +
    "with the result. For a quick task where you want the answer inline, pass background:false. " +
    "It has NO time concept of its own: for 'in N minutes' / 'every N' / looping, use " +
    "ScheduleRoomTask instead. To make CC's single turn work longer/deeper, write that into " +
    "`prompt` (e.g. 'keep working until done'), or embed '/goal <condition>' to self-loop. " +
    "Pass `resumeSessionId` to continue a prior CC session (keeps context); omit to start fresh.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The task/prompt to give Claude Code." },
      resumeSessionId: { type: "string", description: "Existing CC session id to resume (keeps context). Omit for a fresh session." },
      cwd: { type: "string", description: "Working directory the CC run operates in." },
      permissionMode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"], description: "CC permission mode for this run. Defaults to 'bypassPermissions' (full auto — needed so WebSearch/WebFetch/Write run unattended; headless has no approval loop here). Pass 'default'/'acceptEdits' to gate." },
      background: { type: "boolean", description: "Defaults to TRUE: run in the background and notify you on completion (right for long CC tasks). Pass false to run in the foreground and get the result inline (only for quick tasks)." },
    },
    required: ["prompt", "cwd"],
  },
};

type Runner = (opts: { prompt: string; resumeSessionId?: string; cwd: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" }) => Promise<AgentRunResult>;

const defaultRunner: Runner = (opts) =>
  runAgentOnce(claudeAdapter, { command: "claude", prompt: opts.prompt, resumeSessionId: opts.resumeSessionId, cwd: opts.cwd, permissionMode: opts.permissionMode ?? "default" });

/** Factory so tests can inject a fake runner. */
export function makeDriveClaudeCodeTool(runner: Runner = defaultRunner) {
  return async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    if (!prompt) return "Error: prompt is required";
    const resumeSessionId = typeof args.resumeSessionId === "string" ? args.resumeSessionId : undefined;
    // Default to bypassPermissions: this tool is a fire-one-turn delegation to
    // an external `claude` with nobody watching for approvals, and headless
    // `claude -p` here has no interactive approval loop — so under "default" a
    // tool that needs approval (WebSearch/WebFetch/Write) silently can't run
    // (the "DriveClaudeCode 没有联网能力" report). A caller that wants gating
    // passes an explicit mode, which is honored.
    const permissionMode =
      args.permissionMode === "default" ||
      args.permissionMode === "acceptEdits" ||
      args.permissionMode === "bypassPermissions"
        ? args.permissionMode
        : "bypassPermissions";
    // Background by default (CC tasks are typically long). Only an explicit
    // background:false runs in the foreground and returns the result inline.
    const background = args.background !== false;
    if (background) {
      const sessionId = ctx?.sessionId ?? "";
      const jobId = `cc-${process.hrtime.bigint().toString(36)}`;
      const label = prompt.slice(0, 40);
      backgroundJobRegistry.start(jobId, sessionId, `DriveClaudeCode: ${label}`);
      void runner({ prompt, resumeSessionId, cwd, permissionMode })
        .then((r) => {
          // Deliver CC's result back so the woken agent actually sees the answer
          // (not just "a job finished"). Mirrors the video/sub-agent completion
          // path — enqueue lands in the same notificationQueue the wakeup drains.
          notificationQueue.enqueue(
            r.isError
              ? { agentId: jobId, description: `DriveClaudeCode: ${label}`, status: "failed", workKind: "cc", error: r.finalText || "(no output)", enqueuedAt: Date.now() }
              : { agentId: jobId, description: `DriveClaudeCode: ${label}`, status: "completed", workKind: "cc", finalText: r.finalText, enqueuedAt: Date.now() },
            sessionId,
          );
        })
        .catch((err) => {
          notificationQueue.enqueue(
            { agentId: jobId, description: `DriveClaudeCode: ${label}`, status: "failed", workKind: "cc", error: (err as Error)?.message ?? String(err), enqueuedAt: Date.now() },
            sessionId,
          );
        })
        .finally(() => backgroundJobRegistry.finish(jobId));
      return `已在后台启动 Claude Code（jobId ${jobId}）。完成后会通知你结果，无需轮询。`;
    }
    const r = await runner({ prompt, resumeSessionId, cwd, permissionMode });
    if (r.isError) return `Claude Code 运行出错（session ${r.sessionId}）：\n${r.finalText}`;
    return `Claude Code 完成（session ${r.sessionId}）：\n${r.finalText}`;
  };
}

export const driveClaudeCodeTool = makeDriveClaudeCodeTool();
