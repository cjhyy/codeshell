/**
 * Built-in Agent tool — spawn a sub-agent to handle a task.
 *
 * Creates a new Engine instance with its own transcript,
 * runs the task to completion, and returns the result text.
 * Supports AbortSignal for cascading cancellation.
 * Supports onStream for real-time output passthrough.
 */

import type { ToolDefinition, StreamCallback } from "../../types.js";
import type { AgentPresetName } from "../../preset/index.js";
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

export interface SubAgentConfig {
  llm: import("../../types.js").LLMConfig;
  cwd: string;
  permissionMode: string;
  preset?: AgentPresetName;
  enabledBuiltinTools?: string[];
  disabledBuiltinTools?: string[];
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  maxContextTokens: number;
  sessionStorageDir?: string;
  onStream?: StreamCallback;
  createEngine: (config: Record<string, unknown>) => {
    run(task: string, options?: { signal?: AbortSignal; onStream?: StreamCallback }): Promise<{ text: string; reason: string }>;
  };
}

let _subAgentConfig: SubAgentConfig | undefined;

export function setSubAgentConfig(config: SubAgentConfig | undefined): void {
  _subAgentConfig = config;
}

/**
 * Build and run a sub-agent. Returns the produced text or throws.
 * Used by both the synchronous and background paths.
 */
async function runSubAgent(opts: {
  agentId: string;
  description: string;
  prompt: string;
  maxTurns: number;
  signal: AbortSignal;
  parentStream: StreamCallback | undefined;
}): Promise<string> {
  if (!_subAgentConfig) throw new Error("Agent tool is not configured.");

  const { agentId, description, prompt, maxTurns, signal, parentStream } = opts;

  parentStream?.({ type: "agent_start", agentId, description });

  const childStream: StreamCallback = (event) => {
    if (!parentStream) return;
    const tagged = { ...event, agentId } as any;
    parentStream(tagged);
  };

  const parentWasInPlanMode = isInPlanMode();
  if (parentWasInPlanMode) resetPlanMode();

  try {
    const engine = _subAgentConfig.createEngine({
      llm: {
        ..._subAgentConfig.llm,
        retryMaxAttempts: 2,
      },
      cwd: _subAgentConfig.cwd,
      permissionMode: _subAgentConfig.permissionMode,
      preset: _subAgentConfig.preset,
      enabledBuiltinTools: _subAgentConfig.enabledBuiltinTools,
      disabledBuiltinTools: _subAgentConfig.disabledBuiltinTools,
      customSystemPrompt: _subAgentConfig.customSystemPrompt,
      appendSystemPrompt: _subAgentConfig.appendSystemPrompt,
      maxTurns,
      maxContextTokens: _subAgentConfig.maxContextTokens,
      sessionStorageDir: _subAgentConfig.sessionStorageDir,
    });

    const result = await engine.run(prompt, { signal, onStream: childStream });
    parentStream?.({ type: "agent_end", agentId, description });
    return result.text || `Agent completed (${result.reason}) but produced no text output.`;
  } finally {
    if (parentWasInPlanMode) restorePlanMode();
  }
}

export async function agentTool(args: Record<string, unknown>): Promise<string> {
  const prompt = args.prompt as string;
  const description = (args.description as string) || "sub-agent";
  if (!prompt) return "Error: prompt is required";

  if (!_subAgentConfig) {
    return "Error: Agent tool is not configured.";
  }

  const parentSignal = args.__signal as AbortSignal | undefined;
  if (parentSignal?.aborted) {
    return "Agent aborted before starting.";
  }

  const maxTurns = (args.max_turns as number) || 15;
  const runInBackground = args.run_in_background === true;
  const agentId = nanoid(8);
  const parentStream = _subAgentConfig.onStream;

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
    void runSubAgent({
      agentId,
      description,
      prompt,
      maxTurns,
      signal: controller.signal,
      parentStream,
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
    return await runSubAgent({
      agentId,
      description,
      prompt,
      maxTurns,
      signal: parentSignal ?? new AbortController().signal,
      parentStream,
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
