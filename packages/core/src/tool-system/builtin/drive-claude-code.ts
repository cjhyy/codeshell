import type { ToolDefinition } from "../../types.js";
import { runAgentOnce } from "../../cc-orchestrator/external-agent-driver.js";
import { claudeAdapter } from "../../cc-orchestrator/agent-adapter.js";
import type { AgentRunResult } from "../../cc-orchestrator/external-agent-driver.js";

export const driveClaudeCodeToolDef: ToolDefinition = {
  name: "DriveClaudeCode",
  description:
    "Run the external Claude Code CLI for ONE turn and return its final text + session id. " +
    "Use to delegate a coding task to Claude Code, or to continue an existing CC session. " +
    "This runs ONE turn then exits — it has NO time concept. For 'in N minutes' / 'every N' / " +
    "looping, use ScheduleRoomTask instead (never sleep). " +
    "To make this single turn work longer/deeper, write that into `prompt` (e.g. 'keep working " +
    "until everything is done'); to have the turn self-loop until a condition holds, embed a goal " +
    "directive in `prompt` such as '/goal all tests pass'. Pass `resumeSessionId` to continue a " +
    "prior CC session (keeps its context); omit it to start fresh.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The task/prompt to give Claude Code this turn." },
      resumeSessionId: { type: "string", description: "Existing CC session id to resume (keeps context). Omit for a fresh session." },
      cwd: { type: "string", description: "Working directory the CC run operates in." },
      permissionMode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"], description: "CC permission mode for this run. Default 'default'." },
    },
    required: ["prompt", "cwd"],
  },
};

type Runner = (opts: { prompt: string; resumeSessionId?: string; cwd: string; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" }) => Promise<AgentRunResult>;

const defaultRunner: Runner = (opts) =>
  runAgentOnce(claudeAdapter, { command: "claude", prompt: opts.prompt, resumeSessionId: opts.resumeSessionId, cwd: opts.cwd, permissionMode: opts.permissionMode ?? "default" });

/** Factory so tests can inject a fake runner. */
export function makeDriveClaudeCodeTool(runner: Runner = defaultRunner) {
  return async (args: Record<string, unknown>): Promise<string> => {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    if (!prompt) return "Error: prompt is required";
    const resumeSessionId = typeof args.resumeSessionId === "string" ? args.resumeSessionId : undefined;
    const permissionMode = (args.permissionMode === "acceptEdits" || args.permissionMode === "bypassPermissions") ? args.permissionMode : "default";
    const r = await runner({ prompt, resumeSessionId, cwd, permissionMode });
    if (r.isError) return `Claude Code 运行出错（session ${r.sessionId}）：\n${r.finalText}`;
    return `Claude Code 完成（session ${r.sessionId}）：\n${r.finalText}`;
  };
}

export const driveClaudeCodeTool = makeDriveClaudeCodeTool();
