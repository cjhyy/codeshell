import type { ToolDefinition } from "../../types.js";
import { cronScheduler } from "../../automation/scheduler.js";
import { CCTaskStore } from "../../cc-orchestrator/cc-task-store.js";

export const scheduleRoomTaskToolDef: ToolDefinition = {
  name: "ScheduleRoomTask",
  description:
    "Schedule a task to drive Claude Code later or repeatedly. Use for 'in N minutes/hours', " +
    "'at <time>', 'every N', or a looping goal — the room timer fires it (NEVER sleep in a turn). " +
    "schedule: interval ('10m','2h','1d') or 5-field cron ('0 9 * * 1-5'). kind: 'once' (one-shot) " +
    "or 'loop' (repeats; set `goal` so the relevance judge can stop it when met). continuation: " +
    "'auto' (judge decides resume-same vs fresh-session per run; default), 'always-resume' (keep " +
    "one session), 'always-fresh' (new session each run).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short name for the task." },
      schedule: { type: "string", description: "Interval ('10m','2h') or 5-field cron expression." },
      kind: { type: "string", enum: ["once", "loop"], description: "'once' or 'loop'." },
      prompt: { type: "string", description: "The prompt to give Claude Code each run." },
      cwd: { type: "string", description: "Project working directory." },
      goal: { type: "string", description: "loop only: overall goal; judge stops the loop when met." },
      continuation: { type: "string", enum: ["auto", "always-resume", "always-fresh"], description: "Session strategy. Default 'auto'." },
      permissionMode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"] },
    },
    required: ["name", "schedule", "kind", "prompt", "cwd"],
  },
};

export async function scheduleRoomTaskTool(args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? "");
  const schedule = String(args.schedule ?? "");
  const prompt = String(args.prompt ?? "");
  const cwd = String(args.cwd ?? "");
  const kind = args.kind === "loop" ? "loop" : "once";
  if (!name || !schedule || !prompt || !cwd) return "Error: name, schedule, prompt, cwd are required";
  const continuation = (args.continuation === "always-resume" || args.continuation === "always-fresh") ? args.continuation : "auto";
  const permissionMode = (args.permissionMode === "acceptEdits" || args.permissionMode === "bypassPermissions") ? args.permissionMode : "default";
  const job = cronScheduler.create(name, schedule, prompt, { cwd });
  new CCTaskStore().set(job.id, { kind, continuation, goal: typeof args.goal === "string" ? args.goal : undefined, permissionMode });
  return `已安排任务「${name}」（${kind}，${schedule}，continuation=${continuation}），id=${job.id}`;
}
