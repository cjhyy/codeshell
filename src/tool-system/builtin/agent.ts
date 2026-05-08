/**
 * Built-in Agent tool — spawn a sub-agent to handle a task.
 *
 * Creates a new Engine instance with its own transcript,
 * runs the task to completion, and returns the result text.
 * Supports AbortSignal for cascading cancellation.
 * Supports onStream for real-time output passthrough.
 */

import type { ToolDefinition, StreamCallback } from "../../types.js";
import type { ToolContext, SubAgentSpawner } from "../context.js";
import { isInPlanMode, resetPlanMode, restorePlanMode } from "./plan.js";
import { asyncAgentRegistry } from "./agent-registry.js";
import { nanoid } from "nanoid";

export const agentToolDef: ToolDefinition = {
  name: "Agent",
  description:
    "Launch a sub-agent to handle a complex task autonomously. " +
    "The sub-agent has access to the same tools and runs independently. " +
    "Use this for tasks that can be delegated, parallelized, or require deep exploration. " +
    "Provide a clear, complete description of what the agent should do.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short (3-5 word) description of the task",
      },
      prompt: {
        type: "string",
        description: "The detailed task for the agent to perform",
      },
      max_turns: {
        type: "number",
        description: "Maximum turns for the sub-agent (default: 15)",
      },
      run_in_background: {
        type: "boolean",
        description:
          "If true, launch the sub-agent in the background and return an agent_id immediately " +
          "instead of waiting for it to finish. Use AgentStatus(agent_id) to check progress " +
          "and AgentCancel(agent_id) to stop it. The agent runs in this process; restarting " +
          "loses its state. Default: false (synchronous wait).",
      },
    },
    required: ["description", "prompt"],
  },
};

/**
 * Build and run a sub-agent. Returns the produced text or throws.
 * Used by both the synchronous and background paths.
 */
async function runSubAgent(
  spawner: SubAgentSpawner,
  opts: {
    agentId: string;
    description: string;
    prompt: string;
    maxTurns: number;
    signal: AbortSignal;
  },
): Promise<string> {
  const { agentId, description } = opts;
  const parentStream = spawner.parentStream;

  parentStream?.({ type: "agent_start", agentId, description });

  const parentWasInPlanMode = isInPlanMode();
  if (parentWasInPlanMode) resetPlanMode();

  try {
    const text = await spawner.spawn(opts);
    parentStream?.({ type: "agent_end", agentId, description });
    return text || `Agent completed but produced no text output.`;
  } finally {
    if (parentWasInPlanMode) restorePlanMode();
  }
}

export async function agentTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const prompt = args.prompt as string;
  const description = (args.description as string) || "sub-agent";
  if (!prompt) return "Error: prompt is required";

  if (!ctx?.subAgentSpawner) {
    return "Error: Agent tool is not configured (no subAgentSpawner in ctx).";
  }
  const spawner = ctx.subAgentSpawner;

  const parentSignal = args.__signal as AbortSignal | undefined;
  if (parentSignal?.aborted) {
    return "Agent aborted before starting.";
  }

  const maxTurns = (args.max_turns as number) || 15;
  const runInBackground = args.run_in_background === true;
  const agentId = nanoid(8);
  const parentStream = spawner.parentStream;

  // ─── Background path ───────────────────────────────────────────
  // Register the agent, kick off execution detached from the current turn,
  // return immediately with the agent_id. Parent abort does NOT cascade
  // (background agents survive the spawning turn). Cancellation goes
  // through AgentCancel(agent_id).
  if (runInBackground) {
    const controller = new AbortController();
    asyncAgentRegistry.register({
      agentId,
      description,
      status: "running",
      startedAt: Date.now(),
      abort: () => controller.abort(),
    });

    // Run detached. Errors are captured into the registry.
    void runSubAgent(spawner, {
      agentId,
      description,
      prompt,
      maxTurns,
      signal: controller.signal,
    })
      .then((text) => asyncAgentRegistry.markCompleted(agentId, text))
      .catch((err: Error) => {
        if (controller.signal.aborted) {
          // cancellation was already recorded by AgentCancel
          return;
        }
        asyncAgentRegistry.markFailed(agentId, err.message);
      });

    return [
      `Agent launched in background.`,
      `agent_id: ${agentId}`,
      `description: ${description}`,
      ``,
      `Use AgentStatus(agent_id="${agentId}") to check progress or fetch the result.`,
      `Use AgentCancel(agent_id="${agentId}") to stop it.`,
    ].join("\n");
  }

  // ─── Synchronous path ──────────────────────────────────────────
  try {
    return await runSubAgent(spawner, {
      agentId,
      description,
      prompt,
      maxTurns,
      signal: parentSignal ?? new AbortController().signal,
    });
  } catch (err) {
    parentStream?.({ type: "agent_end", agentId, description, error: (err as Error).message });
    if (parentSignal?.aborted) {
      return "Agent was aborted.";
    }
    return `Agent error: ${(err as Error).message}`;
  }
}

// ─── AgentStatus / AgentCancel — companions to run_in_background ─

export const agentStatusToolDef: ToolDefinition = {
  name: "AgentStatus",
  description:
    "Check the status of a background agent launched with Agent(run_in_background=true). " +
    "Returns running / completed / failed / cancelled, plus the result text once finished. " +
    "Omit agent_id to list all background agents in this process.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "The agent_id returned by Agent(run_in_background=true). Omit to list all.",
      },
    },
  },
};

export async function agentStatusTool(args: Record<string, unknown>): Promise<string> {
  const agentId = args.agent_id as string | undefined;

  if (!agentId) {
    const all = asyncAgentRegistry.list();
    if (all.length === 0) return "No background agents in this process.";
    return all
      .map((e) => {
        const dur = ((e.finishedAt ?? Date.now()) - e.startedAt) / 1000;
        return `${e.agentId} [${e.status}] ${e.description} (${dur.toFixed(1)}s)`;
      })
      .join("\n");
  }

  const e = asyncAgentRegistry.get(agentId);
  if (!e) return `Error: agent_id "${agentId}" not found.`;

  const dur = ((e.finishedAt ?? Date.now()) - e.startedAt) / 1000;
  const lines = [
    `agent_id: ${e.agentId}`,
    `status:   ${e.status}`,
    `description: ${e.description}`,
    `duration: ${dur.toFixed(1)}s`,
  ];
  if (e.status === "completed" && e.result) {
    lines.push("", "── result ──", e.result);
  } else if (e.status === "failed" && e.error) {
    lines.push("", "── error ──", e.error);
  } else if (e.status === "running") {
    lines.push("", "(still running — call AgentStatus again later)");
  }
  return lines.join("\n");
}

export const agentCancelToolDef: ToolDefinition = {
  name: "AgentCancel",
  description:
    "Cancel a background agent launched with Agent(run_in_background=true). " +
    "The agent's current LLM call and any in-flight tools will be aborted.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "The agent_id to cancel.",
      },
    },
    required: ["agent_id"],
  },
};

export async function agentCancelTool(args: Record<string, unknown>): Promise<string> {
  const agentId = args.agent_id as string;
  if (!agentId) return "Error: agent_id is required.";

  const e = asyncAgentRegistry.get(agentId);
  if (!e) return `Error: agent_id "${agentId}" not found.`;
  if (e.status !== "running") {
    return `Agent ${agentId} is already ${e.status}; nothing to cancel.`;
  }

  const ok = asyncAgentRegistry.cancel(agentId);
  return ok
    ? `Agent ${agentId} cancelled.`
    : `Failed to cancel agent ${agentId}.`;
}
