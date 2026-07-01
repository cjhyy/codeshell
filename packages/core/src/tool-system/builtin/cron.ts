/**
 * Cron tools — CronCreate, CronDelete, CronList.
 */

import type { ToolDefinition } from "../../types.js";
import { cronScheduler } from "../../automation/scheduler.js";
import type { CronPermissionLevel } from "../../automation/scheduler.js";
import { getCurrentSid } from "../../logging/logger.js";

export const cronCreateToolDef: ToolDefinition = {
  name: "CronCreate",
  description:
    "Create a scheduled automation job that runs a prompt on a recurring schedule. " +
    "Use this when the user asks to set up a recurring/automated/scheduled task " +
    "(monitoring, daily reports, periodic checks, etc.).\n\n" +
    "Translate the user's natural-language timing into the `schedule` field. Two forms:\n" +
    "  • Interval: '30s', '5m', '1h', '1d' (runs every N from creation).\n" +
    "  • Cron expression (5 fields: minute hour day-of-month month day-of-week) for " +
    "calendar times. Examples: '0 9 * * 1-5' = 9am every weekday; '0 */6 * * *' = every 6 hours; " +
    "'30 8 * * 1' = 8:30am every Monday. Day-of-week: 0=Sunday..6=Saturday.\n\n" +
    "For calendar schedules, set `timezone` to the user's IANA zone (e.g. 'Asia/Shanghai', " +
    "'America/New_York'); ask the user if unknown. Set `cwd` to the project the job operates on. " +
    "Leave `permissionLevel` as 'read-only' unless the user explicitly wants the job to modify code.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short human-readable name for the job (e.g. '工作日晨间简报')" },
      schedule: {
        type: "string",
        description:
          "Interval ('5m','1h','1d') or a 5-field cron expression ('0 9 * * 1-5'). " +
          "Derive this from the user's described timing.",
      },
      prompt: { type: "string", description: "The task prompt the agent runs on each execution" },
      timezone: {
        type: "string",
        description: "IANA timezone for cron-expression schedules (e.g. 'Asia/Shanghai'). Optional; defaults to UTC.",
      },
      cwd: { type: "string", description: "Working directory / project the job runs in. Optional." },
      permissionLevel: {
        type: "string",
        enum: ["read-only", "workspace-write", "full"],
        description:
          "What the job may do: 'read-only' (monitoring; default), 'workspace-write' (edit files), " +
          "'full' (edit + run git/gh to open PRs). Use the least privilege the task needs.",
      },
      once: {
        type: "boolean",
        description:
          "true = one-shot: run once at the scheduled time, then auto-delete (for 'in N minutes / " +
          "at <time>, do X once' reminders or tasks). Default false = recurring per `schedule`. " +
          "A one-shot still uses `schedule` for its time: interval '10m' = 10 minutes from now; " +
          "cron '0 7 25 6 *' = once at 07:00 on June 25.",
      },
      continueInSession: {
        type: "boolean",
        description:
          "true = when the job fires, CONTINUE THE CURRENT conversation: the prompt is appended as " +
          "a new user turn to THIS chat session (restored from disk if needed), carrying its full " +
          "transcript / goal / context. Set this when the user says things like '一小时后接着做 / " +
          "继续 / in this conversation'. Default false = a fresh standalone session per run (right " +
          "for independent recurring tasks like daily reports). The current session id is resolved " +
          "automatically — you do NOT supply it.",
      },
    },
    required: ["name", "schedule", "prompt"],
  },
};

export async function cronCreateTool(args: Record<string, unknown>): Promise<string> {
  const name = args.name as string;
  const schedule = args.schedule as string;
  const prompt = args.prompt as string;
  if (!name || !schedule || !prompt) return "Error: name, schedule, and prompt are required";
  const timezone = typeof args.timezone === "string" ? args.timezone : undefined;
  const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
  const once = args.once === true;
  const permissionLevel =
    args.permissionLevel === "read-only" ||
    args.permissionLevel === "workspace-write" ||
    args.permissionLevel === "full"
      ? (args.permissionLevel as CronPermissionLevel)
      : undefined;
  // Resolve "continue this conversation" to the current session id at create
  // time (the model never supplies it — getCurrentSid() reads the running
  // Engine's ALS context). Empty/unknown sid → treat as standalone.
  const resumeSessionId =
    args.continueInSession === true && getCurrentSid() ? getCurrentSid() : undefined;
  let job;
  try {
    job = cronScheduler.create(name, schedule, prompt, {
      ...(timezone !== undefined ? { timezone } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(permissionLevel !== undefined ? { permissionLevel } : {}),
      ...(once ? { once: true } : {}),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    });
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const tz = job.timezone ? ` (${job.timezone})` : "";
  const next = job.nextRun ? new Date(job.nextRun).toLocaleString() : "n/a";
  const cont = job.resumeSessionId ? "(到点续接当前对话,带上下文)" : "";
  if (job.once) {
    return `一次性任务 #${job.id} "${job.name}" 已创建${cont}。将于 ${next}${tz} 执行一次后自动删除。`;
  }
  return `Cron job #${job.id} "${job.name}" created${cont}. Schedule: ${job.schedule}${tz}. Next run: ${next}.`;
}

export const cronDeleteToolDef: ToolDefinition = {
  name: "CronDelete",
  description: "Delete a scheduled cron job by ID.",
  inputSchema: {
    type: "object",
    properties: {
      jobId: { type: "string", description: "The cron job ID to delete" },
    },
    required: ["jobId"],
  },
};

export async function cronDeleteTool(args: Record<string, unknown>): Promise<string> {
  const id = args.jobId as string;
  if (!id) return "Error: jobId is required";
  const deleted = cronScheduler.delete(id);
  return deleted ? `Cron job #${id} deleted.` : `Cron job #${id} not found.`;
}

export const cronListToolDef: ToolDefinition = {
  name: "CronList",
  description: "List all scheduled cron jobs.",
  inputSchema: { type: "object", properties: {} },
};

export async function cronListTool(_args: Record<string, unknown>): Promise<string> {
  const jobs = cronScheduler.list();
  if (jobs.length === 0) return "No cron jobs scheduled.";
  const lines = jobs.map((j) => {
    const status = j.enabled ? "active" : "paused";
    const lastRun = j.lastRun ? new Date(j.lastRun).toLocaleString() : "never";
    const tz = j.timezone ? ` ${j.timezone}` : "";
    return `  #${j.id} "${j.name}" [${status}] ${j.schedule}${tz} | runs: ${j.runCount} | last: ${lastRun}`;
  });
  return `Cron Jobs (${jobs.length}):\n${lines.join("\n")}`;
}
