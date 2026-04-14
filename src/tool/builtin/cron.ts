/**
 * Cron tools — CronCreate, CronDelete, CronList.
 */

import type { ToolDefinition } from "../../types.js";
import { cronScheduler } from "../../cron/scheduler.js";

export const cronCreateToolDef: ToolDefinition = {
  name: "CronCreate",
  description:
    "Create a scheduled recurring task. The task will run automatically at the specified interval. " +
    "Schedule format: '30s', '5m', '1h', '1d'.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name for the cron job" },
      schedule: { type: "string", description: "Interval (e.g. '5m', '1h', '30s')" },
      prompt: { type: "string", description: "The task prompt to run on each execution" },
    },
    required: ["name", "schedule", "prompt"],
  },
};

export async function cronCreateTool(args: Record<string, unknown>): Promise<string> {
  const name = args.name as string;
  const schedule = args.schedule as string;
  const prompt = args.prompt as string;
  if (!name || !schedule || !prompt) return "Error: name, schedule, and prompt are required";
  const job = cronScheduler.create(name, schedule, prompt);
  return `Cron job #${job.id} "${job.name}" created. Schedule: every ${job.schedule}.`;
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
    return `  #${j.id} "${j.name}" [${status}] every ${j.schedule} | runs: ${j.runCount} | last: ${lastRun}`;
  });
  return `Cron Jobs (${jobs.length}):\n${lines.join("\n")}`;
}
