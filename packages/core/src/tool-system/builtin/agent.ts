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
import type { AgentDefinitionRegistry } from "../../agent/agent-definition-registry.js";
import type { HookRegistry } from "../../hooks/registry.js";
import { asyncAgentRegistry, MAX_BACKGROUND_AGENTS } from "./agent-registry.js";
import { createTranscriptTranslator } from "./agent-transcript-translator.js";
import { notificationQueue } from "./agent-notifications.js";
import { nanoid } from "nanoid";
import { logger } from "../../logging/logger.js";

/**
 * Invoke a stream callback that came from outside the engine's own
 * TurnLoop wrap (e.g. `subAgentSpawner.parentStream`, which is the
 * parent Engine.run's caller-supplied onStream forwarded straight
 * through). A throw here would otherwise bubble out of the Agent tool
 * and abort the parent turn, even though the underlying emit is a UI
 * marker the parent doesn't need to succeed.
 */
function safeEmit(sink: StreamCallback | undefined, event: Parameters<StreamCallback>[0]): void {
  if (!sink) return;
  try {
    sink(event);
  } catch (err) {
    logger.warn("agent.stream_handler_threw", {
      eventType: (event as { type?: string }).type,
      error: (err as Error).message,
    });
  }
}

export interface AgentTypeOverrides {
  model?: string;
  maxTurns?: number;
  toolAllowlist?: string[];
  appendSystemPrompt?: string;
}

/**
 * Resolve an `agent_type` against the role registry into spawn overrides.
 * Registry non-empty + omitted type → throw (ephemeral sub-agents are
 * disabled; the caller must pick a configured role). Registry empty +
 * omitted type → empty overrides. Unknown type → throw, so the LLM gets a
 * clear correction instead of silently running a generic agent.
 */
export function resolveAgentTypeOverrides(
  agentType: string | undefined,
  registry: AgentDefinitionRegistry | undefined,
): AgentTypeOverrides {
  const available = registry?.list().map((d) => d.name) ?? [];
  if (!agentType) {
    if (available.length > 0) {
      throw new Error(
        `agent_type is required — ephemeral sub-agents are disabled. ` +
          `Pass one of: ${available.join(", ")}`,
      );
    }
    return {};
  }
  const def = registry?.get(agentType);
  if (!def) {
    const list = available.join(", ") || "(none defined)";
    throw new Error(`unknown agent_type '${agentType}'. Available: ${list}`);
  }
  return {
    model: def.model,
    maxTurns: def.maxTurns,
    toolAllowlist: def.tools,
    appendSystemPrompt: def.systemPrompt,
  };
}

/**
 * Render the "Available agent types" block injected into the Agent tool's
 * description, listing the roles defined in .code-shell/agents/*.md so the
 * model knows it can pass `agent_type` instead of hand-rolling an ad-hoc
 * agent. Without this the model never sees the registry (it lives per-engine,
 * not in the static tool def) and falls back to nameless ephemeral agents —
 * see the Core A/B/C incident. Returns "" when no roles are defined, so the
 * base description is left untouched.
 */
export function buildAgentTypesBlock(
  registry: AgentDefinitionRegistry | undefined,
): string {
  const defs = registry?.list() ?? [];
  if (defs.length === 0) return "";
  const lines = defs.map((d) => {
    const tools = d.tools && d.tools.length > 0 ? d.tools.join(", ") : "all parent tools";
    return `- ${d.name}: ${d.description} (tools: ${tools})`;
  });
  return [
    "",
    "Available agent types (pass one as `agent_type` to reuse its role, tool allowlist, and turn cap):",
    ...lines,
    "Prefer a matching agent_type over an ad-hoc agent: e.g. read-only investigation → researcher/explorer, planning → planner, full multi-step work → general-purpose. Omit agent_type only when no role fits.",
  ].join("\n");
}

/**
 * Produce an Agent tool definition whose description ends with the live
 * available-agent-types listing. Pure: takes the registry, returns a new def
 * (the base `agentToolDef` const is never mutated). When no roles exist the
 * base def is returned unchanged.
 */
export function agentToolDefWithTypes(
  registry: AgentDefinitionRegistry | undefined,
): ToolDefinition {
  const block = buildAgentTypesBlock(registry);
  if (!block) return agentToolDef;
  return { ...agentToolDef, description: agentToolDef.description + "\n" + block };
}

type SubAgentLifecycle = "subagent_start" | "subagent_finish" | "subagent_error";

/**
 * Emit a sub-agent lifecycle event via the existing `notification` hook,
 * tagged with a `kind`. No-op when hooks are absent. Fire-and-forget: emit is
 * async, we deliberately `void` it so bookkeeping never blocks on a handler
 * (mirrors the background-completion notification below).
 */
export function emitSubAgentHook(
  hooks: HookRegistry | undefined,
  kind: SubAgentLifecycle,
  payload: { agentId: string; description: string; text?: string; error?: string },
): void {
  void hooks?.emit("notification", { kind, ...payload });
}

/** Default per-sub-agent wall-clock timeout (5 minutes). */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 5 * 60_000;

/**
 * Run `work()` with a timeout. On expiry, calls `onTimeout` (to abort the
 * child) and rejects with a timeout error. The child's own abort handling
 * unwinds its resources.
 */
export async function runWithTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Sub-agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
      agent_type: {
        type: "string",
        description:
          "Optional reusable role defined in .code-shell/agents/*.md (e.g. 'researcher'). " +
          "Loads that role's model, tool allowlist, turn cap, and system prompt. " +
          "Disabled roles are not available. If you pass an unknown role you'll get " +
          "an error listing the currently available roles. " +
          "Omit to run an ad-hoc agent described entirely by 'prompt'.",
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
    /** Role overrides resolved from agent_type; forwarded to spawner.spawn. */
    model?: string;
    toolAllowlist?: string[];
    appendSystemPrompt?: string;
    /** Engine HookRegistry for lifecycle events. Undefined → no hooks. */
    hooks?: HookRegistry;
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

  safeEmit(startEndSink, { type: "agent_start", agentId, name, description });
  emitSubAgentHook(opts.hooks, "subagent_start", { agentId, description });

  // `resetPlanMode` / `restorePlanMode` operated on a module-level singleton
  // that no longer exists. The child Engine is a fresh instance; plan-mode
  // isolation between parent and child is enforced via separate Engine
  // instances (finalized in T6).
  const text = await spawner.spawn({ ...opts, streamOverride });
  const finalText = text || `Agent completed but produced no text output.`;
  safeEmit(startEndSink, { type: "agent_end", agentId, name, description, text: finalText });
  emitSubAgentHook(opts.hooks, "subagent_finish", { agentId, description, text: finalText });
  return finalText;
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

  const agentType = (args.agent_type as string | undefined)?.trim() || undefined;
  let overrides: AgentTypeOverrides;
  try {
    overrides = resolveAgentTypeOverrides(agentType, ctx?.agentDefinitions);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }

  const maxTurns = (args.max_turns as number) || overrides.maxTurns || 15;
  const runInBackground = args.run_in_background === true;
  const agentId = nanoid(8);
  const parentStream = spawner.parentStream;

  // ─── Background path ───────────────────────────────────────────
  // Register the agent, kick off execution detached from the current turn,
  // return immediately with the agent_id. Parent abort does NOT cascade
  // (background agents survive the spawning turn). Cancellation goes
  // through AgentCancel(agent_id).
  if (runInBackground) {
    if (asyncAgentRegistry.runningCount() >= MAX_BACKGROUND_AGENTS) {
      return `Error: too many background agents running (limit ${MAX_BACKGROUND_AGENTS}). ` +
        `Wait for some to finish or cancel one with AgentCancel(agent_id) before launching more.`;
    }
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
        model: overrides.model,
        toolAllowlist: overrides.toolAllowlist,
        appendSystemPrompt: overrides.appendSystemPrompt,
        hooks: ctx?.hooks,
        signal: controller.signal,
      },
      parentStream,    // uiStream: agent_start/end → main feed
      transcriptSink,  // streamOverride: per-event detail → transcript
    )
      .then((text) => {
        asyncAgentRegistry.markCompleted(agentId);
        // B2 / Gate 1: attribute completion to the session that spawned
        // this agent so concurrent sessions don't drain each other's
        // notifications. Engine.run() always populates ctx.sessionId; the
        // missing-session branch is only reachable from ad-hoc tool calls
        // outside Engine.run() (notably tests) — we log and drop rather
        // than crash the agent path.
        if (ctx?.sessionId) {
          notificationQueue.enqueue(
            {
              agentId,
              name,
              description,
              status: "completed",
              finalText: text,
              enqueuedAt: Date.now(),
            },
            ctx.sessionId,
          );
        } else {
          logger.warn("agent_completion_without_session", {
            agentId,
            name,
            status: "completed",
          });
        }
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
        if (ctx?.sessionId) {
          notificationQueue.enqueue(
            {
              agentId,
              name,
              description,
              status: "failed",
              error: err.message,
              enqueuedAt: Date.now(),
            },
            ctx.sessionId,
          );
        } else {
          logger.warn("agent_completion_without_session", {
            agentId,
            name,
            status: "failed",
          });
        }
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
  // A timeout-capable controller: the timeout callback aborts the child, and
  // a parent abort is forwarded to it too. Keeping the timeout OUTSIDE
  // runSubAgent (and off the background path) avoids the background path's
  // "abort means user-cancel → drop silently" semantics; here a timeout is a
  // genuine error surfaced to the parent.
  const syncController = new AbortController();
  const onParentAbort = () => syncController.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    return await runWithTimeout(
      () =>
        runSubAgent(spawner, {
          agentId,
          name,
          description,
          prompt,
          maxTurns,
          model: overrides.model,
          toolAllowlist: overrides.toolAllowlist,
          appendSystemPrompt: overrides.appendSystemPrompt,
          hooks: ctx?.hooks,
          signal: syncController.signal,
        }),
      DEFAULT_SUBAGENT_TIMEOUT_MS,
      () => syncController.abort(),
    );
  } catch (err) {
    emitSubAgentHook(ctx?.hooks, "subagent_error", { agentId, description, error: (err as Error).message });
    safeEmit(parentStream, { type: "agent_end", agentId, name, description, error: (err as Error).message });
    if (parentSignal?.aborted) return "Agent was aborted.";
    return `Agent error: ${(err as Error).message}`;
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
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
