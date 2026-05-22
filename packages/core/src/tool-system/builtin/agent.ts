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
import { createTranscriptTranslator } from "./agent-transcript-translator.js";
import { notificationQueue } from "./agent-notifications.js";
import { nanoid } from "nanoid";

export const agentToolDef: ToolDefinition = {
  name: "Agent",
  description:
    "Launch a sub-agent to handle a complex task autonomously. " +
    "The sub-agent has access to the same tools and runs independently. " +
    "Use this for tasks that can be delegated, parallelized, or require deep exploration. " +
    "Provide a clear, complete description of what the agent should do.\n\n" +
    "When you launch multiple agents for independent work, send them in a single " +
    "message with multiple tool uses so they run concurrently.\n\n" +
    "You can optionally run agents in the background using the run_in_background " +
    "parameter. When an agent runs in the background, you will be automatically " +
    "notified when it completes — do NOT sleep, poll, or proactively check on its " +
    "progress. Continue with other work or respond to the user instead.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Short label for the agent kind (e.g. 'Explore', 'Plan', 'Research'). " +
          "Shown in the agent dock to identify what kind of work this sub-agent is doing. " +
          "Keep it 1-2 words. Defaults to 'Agent' if omitted.",
      },
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
          "Set to true to run this agent in the background. " +
          "You will be notified automatically when it completes — do NOT sleep, poll, " +
          "or proactively check on its progress. Use AgentCancel(agent_id) to stop it. " +
          "The agent runs in this process; restarting loses its state. " +
          "Default: false (synchronous wait).",
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
    name?: string;
    description: string;
    prompt: string;
    maxTurns: number;
    signal: AbortSignal;
  },
  /**
   * Optional sink for the user-visible `agent_start` / `agent_end` markers.
   * Background path passes the parent's real onStream here; sync calls leave
   * it undefined and we fall back to `spawner.parentStream`.
   */
  uiStream?: StreamCallback,
  /**
   * Optional override for the spawned child Engine's per-event stream.
   * Background path passes a transcriptSink here so per-event detail is
   * captured into the agent's transcript rather than the main feed. Sync
   * calls leave undefined; engine.ts falls back to `spawner.parentStream`
   * (the parent UI), preserving the inline rendering of synchronous
   * sub-agents.
   */
  streamOverride?: StreamCallback,
): Promise<string> {
  const { agentId, name, description } = opts;
  const startEndSink = uiStream ?? spawner.parentStream;

  startEndSink?.({ type: "agent_start", agentId, name, description });

  const parentWasInPlanMode = isInPlanMode();
  if (parentWasInPlanMode) resetPlanMode();

  try {
    const text = await spawner.spawn({ ...opts, streamOverride });
    const finalText = text || `Agent completed but produced no text output.`;
    startEndSink?.({ type: "agent_end", agentId, name, description, text: finalText });
    return finalText;
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
  const rawName = (args.name as string | undefined)?.trim();
  const name = rawName && rawName.length > 0 ? rawName : undefined;
  if (!prompt) return "Error: prompt is required";

  if (!ctx?.subAgentSpawner) {
    return "Error: Agent tool is not configured (no subAgentSpawner in ctx).";
  }
  // Belt-and-suspenders: the spawner already strips Agent / AgentStatus /
  // AgentCancel from a child Engine's tool pool (see engine.ts spawn()), so
  // a sub-agent's LLM should never see this tool. If it does call it anyway
  // (registry regression, custom-tools injection, future refactor), refuse
  // here — no grandchildren. Matches Claude Code's flat-hierarchy rule.
  if (ctx.isSubAgent === true) {
    return "Error: nested agents are not supported. Sub-agents cannot spawn their own sub-agents. Complete the task directly using your available tools.";
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
      name,
      description,
      status: "running",
      startedAt: Date.now(),
      abort: () => controller.abort(),
    });

    // Translate this background agent's per-event stream into ChatEntry-
    // shaped rows inside its own transcript. The dock detail view reuses
    // App.renderEntry which only understands ChatEntry types — storing
    // raw StreamEvents would render as blanks. The translator mirrors
    // App.tsx#handleStreamEvent's reduction but is scoped to one agent
    // (per-instance closure state), so it doesn't interleave with other
    // agents.
    //
    // Sub-agent runs detached from the parent turn — the parent feed only
    // sees the agent_start / agent_end markers via `parentStream` (the
    // 4th arg to runSubAgent); per-event detail goes through the
    // `streamOverride` (5th arg → SubAgentSpawnRequest.streamOverride →
    // engine.ts spawn closure routes to it instead of the main UI).
    const transcriptSink: StreamCallback = createTranscriptTranslator(agentId);

    void runSubAgent(
      spawner,
      {
        agentId,
        name,
        description,
        prompt,
        maxTurns,
        signal: controller.signal,
      },
      parentStream,    // uiStream: agent_start/end → main feed
      transcriptSink,  // streamOverride: per-event detail → transcript
    )
      .then((text) => {
        asyncAgentRegistry.markCompleted(agentId);
        notificationQueue.enqueue({
          agentId,
          name,
          description,
          status: "completed",
          finalText: text,
          enqueuedAt: Date.now(),
        });
        // notification hook: fire-and-forget. ctx.hooks may be absent in
        // legacy callers; treat as opt-in observability rather than a
        // required publish step. We deliberately do not await — bg-agent
        // bookkeeping should never block on a slow handler.
        void ctx?.hooks?.emit("notification", {
          kind: "agent_completed",
          agentId,
          name,
          description,
          finalText: text,
        });
      })
      .catch((err: Error) => {
        if (controller.signal.aborted) {
          // User-initiated cancel: mark status but do NOT enqueue —
          // the main agent doesn't need a follow-up turn. Dock still
          // shows the "cancelled" badge for the fade window.
          asyncAgentRegistry.markCancelled(agentId);
          void ctx?.hooks?.emit("notification", {
            kind: "agent_cancelled",
            agentId,
            name,
            description,
          });
          return;
        }
        asyncAgentRegistry.markFailed(agentId);
        notificationQueue.enqueue({
          agentId,
          name,
          description,
          status: "failed",
          error: err.message,
          enqueuedAt: Date.now(),
        });
        void ctx?.hooks?.emit("notification", {
          kind: "agent_failed",
          agentId,
          name,
          description,
          error: err.message,
        });
      });

    return [
      `Async agent launched successfully.`,
      `agent_id: ${agentId} (internal — do not show to user)`,
      `description: ${description}`,
      ``,
      `The agent is working in the background. You will be notified automatically when it completes.`,
      `Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.`,
      `If you need to stop it: AgentCancel(agent_id="${agentId}").`,
    ].join("\n");
  }

  // ─── Synchronous path ──────────────────────────────────────────
  try {
    return await runSubAgent(spawner, {
      agentId,
      name,
      description,
      prompt,
      maxTurns,
      signal: parentSignal ?? new AbortController().signal,
    });
  } catch (err) {
    parentStream?.({ type: "agent_end", agentId, name, description, error: (err as Error).message });
    if (parentSignal?.aborted) return "Agent was aborted.";
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
  if (e.status === "completed") {
    lines.push("", "(completed — result was delivered to the conversation when the agent finished)");
  } else if (e.status === "failed") {
    lines.push("", "(failed — error was delivered to the conversation when the agent finished)");
  } else if (e.status === "cancelled") {
    lines.push("", "(cancelled — no result delivered)");
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
