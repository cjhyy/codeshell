/**
 * RemoteTriggerTool — trigger remote agents/workflows.
 */

import type { ToolDefinition } from "../../types.js";

export const remoteTriggerToolDef: ToolDefinition = {
  name: "RemoteTrigger",
  description:
    "Trigger a remote agent or workflow to execute a task. " +
    "The agent runs asynchronously and results can be checked later.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name/identifier of the remote trigger to execute",
      },
      prompt: {
        type: "string",
        description: "The task prompt to send to the remote agent",
      },
      config: {
        type: "object",
        description: "Optional configuration for the remote execution",
      },
    },
    required: ["name", "prompt"],
  },
};

export async function remoteTriggerTool(args: Record<string, unknown>): Promise<string> {
  const name = args.name as string;
  const prompt = args.prompt as string;
  const config = args.config as Record<string, unknown> | undefined;

  // Remote triggers are dispatched via the cron scheduler or external API
  try {
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    // Store trigger request for pickup by external scheduler
    const triggerDir = join(homedir(), ".code-shell", "triggers");
    mkdirSync(triggerDir, { recursive: true });

    const trigger = {
      id: `trigger_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      prompt,
      config,
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    const triggerFile = join(triggerDir, `${trigger.id}.json`);
    writeFileSync(triggerFile, JSON.stringify(trigger, null, 2), "utf-8");

    return `Remote trigger "${name}" dispatched (ID: ${trigger.id}).\nStored at: ${triggerFile}`;
  } catch (err) {
    return `Remote trigger error: ${(err as Error).message}`;
  }
}
