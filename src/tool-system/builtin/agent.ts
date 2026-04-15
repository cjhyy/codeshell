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

export async function agentTool(args: Record<string, unknown>): Promise<string> {
  const prompt = args.prompt as string;
  const description = (args.description as string) || "sub-agent";
  if (!prompt) return "Error: prompt is required";

  if (!_subAgentConfig) {
    return "Error: Agent tool is not configured.";
  }

  const signal = args.__signal as AbortSignal | undefined;
  if (signal?.aborted) {
    return "Agent aborted before starting.";
  }

  const maxTurns = Math.min((args.max_turns as number) || 15, 30);
  const agentId = nanoid(8);
  const parentStream = _subAgentConfig.onStream;

  // Emit agent_start
  parentStream?.({ type: "agent_start", agentId, description });

  // Create a child stream callback that tags events with agentId
  const childStream: StreamCallback = (event) => {
    if (!parentStream) return;
    // Tag the event with this agent's ID for nested rendering
    const tagged = { ...event, agentId } as any;
    parentStream(tagged);
  };

  try {
    const parentWasInPlanMode = isInPlanMode();
    if (parentWasInPlanMode) {
      resetPlanMode();
    }

    const engine = _subAgentConfig.createEngine({
      llm: {
        ..._subAgentConfig.llm,
        timeout: Math.min(_subAgentConfig.llm.timeout ?? 120_000, 60_000),
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

    let result: { text: string; reason: string };
    try {
      result = await engine.run(prompt, { signal, onStream: childStream });
    } finally {
      if (parentWasInPlanMode) {
        restorePlanMode();
      }
    }

    // Emit agent_end
    parentStream?.({ type: "agent_end", agentId, description });

    if (result.text) {
      return result.text;
    }
    return `Agent completed (${result.reason}) but produced no text output.`;
  } catch (err) {
    parentStream?.({ type: "agent_end", agentId, description, error: (err as Error).message });
    if (signal?.aborted) {
      return "Agent was aborted.";
    }
    return `Agent error: ${(err as Error).message}`;
  }
}
