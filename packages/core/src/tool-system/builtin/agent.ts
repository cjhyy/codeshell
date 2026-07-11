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
import type { AgentDefinition } from "../../agent/agent-definition.js";
import type { HookRegistry } from "../../hooks/registry.js";
import { asyncAgentRegistry, MAX_BACKGROUND_AGENTS } from "./agent-registry.js";
import { ensureAgentHeartbeat } from "./agent-heartbeat.js";
import { writeAgentOutputFile } from "./agent-output-file.js";
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
  resolvedType?: string;
  model?: string;
  maxTurns?: number;
  toolAllowlist?: string[];
  skillAllowlist?: string[];
  appendSystemPrompt?: string;
}

/** Preferred default role when the caller omits agent_type but roles exist. */
const DEFAULT_AGENT_TYPE = "general-purpose";

/**
 * Resolve an `agent_type` against the role registry into spawn overrides.
 *
 * - Omitted type + non-empty registry → fall back to a configured role
 *   ("general-purpose" if present, else the first available) instead of
 *   running a nameless ephemeral agent. Relaxed from the earlier "throw when
 *   agent_type omitted": the model habitually omits it, and a hard error just
 *   turned every spawn into a failure. Falling back to a real role keeps the
 *   tool-allowlist / system-prompt benefits without breaking the call.
 * - Omitted type + empty registry → empty overrides (true ephemeral; nothing
 *   to fall back to).
 * - Unknown explicit type → throw, so the LLM gets a clear correction rather
 *   than silently running a generic agent.
 */
export function resolveAgentTypeOverrides(
  agentType: string | undefined,
  registry: AgentDefinitionRegistry | undefined,
): AgentTypeOverrides {
  const available = registry?.list().map((d) => d.name) ?? [];
  let resolvedType = agentType;
  if (!resolvedType) {
    if (available.length === 0) return {};
    resolvedType = available.includes(DEFAULT_AGENT_TYPE) ? DEFAULT_AGENT_TYPE : available[0]!;
  }
  const def = registry?.get(resolvedType);
  if (!def) {
    const list = available.join(", ") || "(none defined)";
    throw new Error(`unknown agent_type '${resolvedType}'. Available: ${list}`);
  }
  return {
    resolvedType,
    model: def.model,
    maxTurns: def.maxTurns,
    toolAllowlist: def.tools,
    skillAllowlist: namespacePluginSkills(def.skills, def.source, def.pluginName),
    appendSystemPrompt: def.systemPrompt,
  };
}

/**
 * A plugin-bundled agent's frontmatter lists its own skills by BARE name
 * (`skills: director-skill`), matching Claude Code's convention where a
 * plugin agent references same-plugin skills unqualified. But the skill
 * scanner registers plugin skills under their NAMESPACED name
 * (`mimi-video:director-skill`), and the allowlist filter is an exact match —
 * so a bare entry never matches and the sub-agent reports the skill "not
 * found", forcing it to fall back to reading SKILL.md by hand.
 *
 * Bridge the two conventions: for a plugin-source agent, rewrite each bare
 * skill name to `<pluginName>:<skill>`. Names that already carry a namespace
 * (contain ":") are left untouched, so an agent may still reference another
 * plugin's skill explicitly. undefined (inherit full pool) and [] (no skills)
 * pass through unchanged. Non-plugin agents are never rewritten.
 */
export function namespacePluginSkills(
  skills: string[] | undefined,
  source: AgentDefinition["source"],
  pluginName: string | undefined,
): string[] | undefined {
  if (skills === undefined) return undefined;
  if (source !== "plugin" || !pluginName) return skills;
  return skills.map((s) => (s.includes(":") ? s : `${pluginName}:${s}`));
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
    // Only surface skills when the role restricts them — most roles inherit
    // the full pool and listing "all skills" everywhere is noise.
    const skillsNote =
      d.skills !== undefined
        ? `; skills: ${d.skills.length > 0 ? d.skills.join(", ") : "none"}`
        : "";
    return `- ${d.name}: ${d.description} (tools: ${tools}${skillsNote})`;
  });
  return [
    "",
    "Available agent types (pass one as `agent_type` to reuse its role, tool allowlist, and turn cap):",
    ...lines,
    "Pass the closest matching agent_type (e.g. read-only investigation → researcher/explorer, planning → planner, full multi-step work → general-purpose). If you omit agent_type it defaults to general-purpose (or the first available role) — passing an explicit one is preferred.",
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
  const names = registry?.list().map((d) => d.name) ?? [];
  if (!block && names.length === 0) return agentToolDef;

  // Constrain agent_type to the loaded kind names so the model can't invent a
  // role that doesn't exist (resolveAgentTypeOverrides would throw, wasting a
  // turn). A free string still slipped through before; an enum surfaces the
  // valid set directly in the schema the model sees. We rebuild the property
  // (not mutate the shared const) so each engine's registry stays isolated.
  const baseProps =
    (agentToolDef.inputSchema.properties as Record<string, Record<string, unknown>>) ?? {};
  const baseAgentType = baseProps.agent_type ?? {};
  const inputSchema: Record<string, unknown> = {
    ...agentToolDef.inputSchema,
    properties: {
      ...baseProps,
      agent_type:
        names.length > 0 ? { ...baseAgentType, enum: names } : baseAgentType,
    },
  };
  return {
    ...agentToolDef,
    description: block ? agentToolDef.description + "\n" + block : agentToolDef.description,
    inputSchema,
  };
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

export const agentToolDef: ToolDefinition = {
  name: "Agent",
  description:
    "Launch a sub-agent to handle a task in its own clean, isolated context. " +
    "The sub-agent runs independently with access to the same tools, and its final " +
    "report is the ONLY thing returned to you — it is stateless, so you cannot send " +
    "follow-up messages. Write a complete, self-contained task description.\n\n" +
    "PRIMARY USE — context isolation: when a task needs to read many files or run a " +
    "broad investigation but you only need the conclusion, delegate it. The sub-agent " +
    "absorbs the noisy intermediate output in its own context; you keep the answer, not " +
    "the file dumps. This protects your main context from being flooded.\n\n" +
    "DON'T use this for a quick lookup where you know the file/symbol and expect a few " +
    "matches — use Read/Grep/Glob directly instead; spawning an agent wastes a turn.\n\n" +
    "Parallel fan-out is the EXCEPTION: only launch several agents in one message when " +
    "the work truly splits into independent pieces with no shared state. Prefer one " +
    "well-scoped delegation over a swarm.\n\n" +
    "You can optionally run an agent in the background using the run_in_background " +
    "parameter. When it runs in the background, you will be automatically notified when " +
    "it completes — do NOT sleep, poll, or proactively check on its progress. Continue " +
    "with other work or respond to the user instead. " +
    "Even a synchronous agent that runs longer than ~2 minutes is automatically moved to " +
    "the background and notifies you on completion the same way — so a long delegation never " +
    "stalls you; just continue or end your turn when told it has moved to the background.",
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
          "If omitted, defaults to a configured role (general-purpose or the first available); " +
          "with no roles configured it runs an ephemeral agent. Passing an explicit role is preferred.",
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
 * Auto-background threshold (ms): a synchronous agent still running after this
 * long is detached into the background (not killed) so the main turn isn't
 * blocked for up to the 30min tool cap (TODO 4.1). Default 120s, matching
 * Claude Code; overridable via CODE_SHELL_AGENT_BG_MS for tests. The agent
 * keeps running on the same signal — we just stop awaiting it inline and let it
 * notify on finish. Shared by the first-spawn (agentTool) and continuation
 * (agentSendInputTool) paths.
 */
function resolveAutoBgMs(): number {
  const raw = process.env.CODE_SHELL_AGENT_BG_MS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

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
    /** Resolved role name (e.g. "general-purpose", "explorer"); surfaced in
     *  the agent_start / agent_end markers so the UI can show the dispatched
     *  type. Undefined for a true ephemeral agent (empty registry). */
    agentType?: string;
    prompt: string;
    maxTurns: number;
    signal: AbortSignal;
    /** Role overrides resolved from agent_type; forwarded to spawner.spawn. */
    model?: string;
    toolAllowlist?: string[];
    skillAllowlist?: string[];
    appendSystemPrompt?: string;
    readOnlySession?: boolean;
    /** Resume an existing child session (transcript replay) instead of cold
     *  start. Set by AgentSendInput; undefined for a first spawn. */
    resumeSessionId?: string;
    /** Engine HookRegistry for lifecycle events. Undefined → no hooks. */
    hooks?: HookRegistry;
    /** Parent session/Goal accounting sink for the completed child run. */
    recordBilledUsage?: (usage: import("../../types.js").TokenUsage) => void;
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
  const { agentId, name, description, agentType } = opts;
  const startEndSink = uiStream ?? spawner.parentStream;

  safeEmit(startEndSink, { type: "agent_start", agentId, name, description, agentType });
  emitSubAgentHook(opts.hooks, "subagent_start", { agentId, description });

  // `resetPlanMode` / `restorePlanMode` operated on a module-level singleton
  // that no longer exists. The child Engine is a fresh instance; plan-mode
  // isolation between parent and child is enforced via separate Engine
  // instances (finalized in T6).
  const { text, usage } = await spawner.spawn({ ...opts, streamOverride });
  if (usage) opts.recordBilledUsage?.(usage);
  const finalText = text || `Agent completed but produced no text output.`;
  safeEmit(startEndSink, { type: "agent_end", agentId, name, description, text: finalText, agentType });
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
  // Resolved below: when the model omits `name`, fall back to the resolved
  // kind name so the dock shows a meaningful label instead of bare "Agent".
  let name = rawName && rawName.length > 0 ? rawName : undefined;
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

  // Dock label fallback: an omitted `name` defaults to the resolved kind
  // (e.g. "explorer") so background agents are identifiable in the dock even
  // when the model didn't pass an explicit label. True ephemeral agents
  // (empty registry, no resolvedType) keep name undefined → dock shows "Agent".
  if (name === undefined && overrides.resolvedType) {
    name = overrides.resolvedType;
  }

  const maxTurns = (args.max_turns as number) || overrides.maxTurns || 15;
  const runInBackground = args.run_in_background === true;
  const agentId = nanoid(8);
  const parentStream = spawner.parentStream;

  const autoBgMs = resolveAutoBgMs();

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
      agentType: overrides.resolvedType,
      description,
      // Tag with the spawning session so the parent Engine.run waits only on
      // its own background agents (hasRunningForSession).
      sessionId: ctx?.sessionId,
      status: "running",
      startedAt: Date.now(),
      abort: () => controller.abort(),
    });

    // B: liveness heartbeat for this explicit background agent too.
    ensureAgentHeartbeat();

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
        agentType: overrides.resolvedType,
        prompt,
        maxTurns,
        model: overrides.model,
        toolAllowlist: overrides.toolAllowlist,
        skillAllowlist: overrides.skillAllowlist,
        appendSystemPrompt: overrides.appendSystemPrompt,
        readOnlySession: overrides.resolvedType === "researcher" || overrides.resolvedType === "explorer",
        hooks: ctx?.hooks,
        recordBilledUsage: ctx?.recordBilledUsage,
        signal: controller.signal,
      },
      parentStream,    // uiStream: agent_start/end → main feed
      transcriptSink,  // streamOverride: per-event detail → transcript
    )
      .then((text) => {
        asyncAgentRegistry.markCompleted(agentId);
        // External-readable copy of the result (tail / cross-session history).
        // Best-effort; never blocks the completion path.
        void writeAgentOutputFile(agentId, {
          status: "completed",
          body: text,
          description,
          name,
          onError: (m, meta) => logger.warn(m, meta),
        });
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
        // runSubAgent emits its terminal agent_end only on the RESOLVE path
        // (line ~344). On fail/cancel it threw before that, so the main-feed
        // card started by agent_start is still 'working' — seal it here or the
        // TUI spins forever. Emit once for BOTH branches (mirrors the sync→bg
        // detach path ~885), then branch on abort for the notification only.
        safeEmit(parentStream, {
          type: "agent_end",
          agentId,
          name,
          description,
          error: err.message,
          agentType: overrides.resolvedType,
        });
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
        void writeAgentOutputFile(agentId, {
          status: "failed",
          body: err.message,
          description,
          name,
          onError: (m, meta) => logger.warn(m, meta),
        });
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

  // ─── Synchronous path (with auto-background handoff) ────────────
  return runSyncSubAgent({
    spawner,
    agentId,
    name,
    description,
    prompt,
    maxTurns,
    overrides,
    autoBgMs,
    parentSignal,
    parentStream,
    ctx,
  });
}

/**
 * Record a finished SYNCHRONOUS sub-agent in the registry so AgentSendInput's
 * fast path can later find it — its agentType (for role-scope re-resolution on
 * resume) and dock label. Background agents already register on spawn; sync
 * agents historically didn't (they returned text and were forgotten), which
 * left continuation unable to recover the role's tool/skill constraints.
 *
 * This is a SILENT entry: status already `completed`, no notification enqueued,
 * so it doesn't flash a dock card or wake the parent. It's pure lookup state.
 * Keyed by agentId === childSid, so it agrees with the on-disk session that the
 * cross-restart disk-probe finds. Skipped when the agent moved to the
 * background (that path registers its own live entry) or was aborted.
 */
function recordCompletedSyncAgent(opts: {
  agentId: string;
  name?: string;
  agentType?: string;
  description: string;
  parentSessionId?: string;
}): void {
  // Don't clobber a live/handed-off entry of the same id.
  if (asyncAgentRegistry.get(opts.agentId)) return;
  const now = Date.now();
  asyncAgentRegistry.register({
    agentId: opts.agentId,
    name: opts.name,
    agentType: opts.agentType,
    description: opts.description,
    sessionId: opts.parentSessionId,
    // agent_id === childSid: the resumable session lives at sessions/<agentId>/.
    childSessionId: opts.agentId,
    status: "completed",
    startedAt: now,
    finishedAt: now,
    // No fade window / no notification: this entry exists only so
    // AgentSendInput can resolve the role on continuation, not to render.
    abort: () => {},
  });
}

/**
 * The synchronous sub-agent run path, shared by `agentTool` (first spawn) and
 * `agentSendInputTool` (resume/continuation). Races the run against the
 * auto-background timer and hands off to the background registry if it runs
 * long. `resumeSessionId`, when set, resumes an existing child session
 * (transcript replay) instead of cold-starting.
 *
 * No wall-clock timeout on the lifecycle — matches Claude Code / Codex, where a
 * sub-agent is bounded by maxTurns + per-tool timeouts + parent/user abort, NOT
 * a global countdown that kills legitimate heavy work mid-task. (The old
 * runWithTimeout(5min) murdered slow agents AND raced the completion path into
 * a double agent_end; dropping it removed the race — fix
 * subagent-timeout-double-agent-end.)
 */
async function runSyncSubAgent(args: {
  spawner: SubAgentSpawner;
  agentId: string;
  name?: string;
  description: string;
  prompt: string;
  maxTurns: number;
  overrides: AgentTypeOverrides;
  autoBgMs: number;
  parentSignal?: AbortSignal;
  parentStream?: StreamCallback;
  ctx?: ToolContext;
  /** Resume an existing child session (continuation) instead of cold start. */
  resumeSessionId?: string;
}): Promise<string> {
  const {
    spawner,
    agentId,
    name,
    description,
    prompt,
    maxTurns,
    overrides,
    autoBgMs,
    parentSignal,
    parentStream,
    ctx,
    resumeSessionId,
  } = args;

  const syncController = new AbortController();
  const onParentAbort = () => syncController.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  // Per-call flag (NOT module-level): true once we've detached the agent into
  // the background, so the finally block leaves the parent-abort listener with
  // the background handlers instead of removing it.
  let handedOff = false;

  // Run the agent, but don't necessarily await it to completion: race the run
  // against the auto-background timer. The run promise is shared between the
  // inline await and (if we hand off) the background completion handlers, so
  // the agent is never started twice and never killed by the handoff.
  const runPromise = runSubAgent(spawner, {
    agentId,
    name,
    description,
    agentType: overrides.resolvedType,
    prompt,
    maxTurns,
    model: overrides.model,
    toolAllowlist: overrides.toolAllowlist,
    skillAllowlist: overrides.skillAllowlist,
    appendSystemPrompt: overrides.appendSystemPrompt,
    readOnlySession: overrides.resolvedType === "researcher" || overrides.resolvedType === "explorer",
    resumeSessionId,
    hooks: ctx?.hooks,
    recordBilledUsage: ctx?.recordBilledUsage,
    signal: syncController.signal,
  });

  // Sentinel that the timer resolves with, so we can tell "agent finished" from
  // "threshold elapsed" without rejecting either side.
  const BG_HANDOFF = Symbol("bg-handoff");
  let bgTimer: ReturnType<typeof setTimeout> | undefined;
  const timerPromise =
    autoBgMs > 0 && autoBgMs !== Infinity
      ? new Promise<typeof BG_HANDOFF>((resolve) => {
          bgTimer = setTimeout(() => resolve(BG_HANDOFF), autoBgMs);
        })
      : null;

  try {
    // If there's no timer (threshold 0/∞ disabled), just await as before.
    const winner = timerPromise
      ? await Promise.race([runPromise.then((t) => ({ ok: true as const, text: t })).catch((e) => ({ ok: false as const, err: e as Error })), timerPromise])
      : { ok: true as const, text: await runPromise };

    if (winner === BG_HANDOFF) {
      // Threshold elapsed while the agent is STILL running. Detach it into the
      // background registry (it keeps executing on syncController.signal — we
      // do NOT abort it) and wire its eventual completion into the
      // notification queue, exactly like an explicit run_in_background agent.
      handedOff = true;
      handoffToBackground(runPromise, syncController, {
        agentId,
        name,
        description,
        agentType: overrides.resolvedType,
        sessionId: ctx?.sessionId,
        hooks: ctx?.hooks,
        parentSignal,
        onParentAbort,
        // The agent_start fired in runSubAgent put the UI card into 'working'.
        // runSubAgent's own agent_end (line ~299) only fires if spawn() RESOLVES;
        // on failure/cancel it throws before that, so the card would hang
        // 'working' forever. Hand the UI sink to the background completion
        // handlers so they emit the terminal agent_end the card needs.
        uiStream: parentStream,
      });
      return [
        `Task is taking a while (>${Math.round(autoBgMs / 1000)}s) — moved it to the background so I'm not blocked.`,
        `agent_id: ${agentId} (internal — do not show to user)`,
        `description: ${description}`,
        ``,
        `It is still running and you will be notified automatically when it completes.`,
        `Briefly tell the user it's running in the background and either continue with other work or end your response. Do not sleep or poll.`,
        `If you need to stop it: AgentCancel(agent_id="${agentId}").`,
      ].join("\n");
    }

    // Agent finished within the threshold. Record a silent completed entry so
    // AgentSendInput can continue this sub-agent (recover its role scope). Both
    // a first spawn and a resume land here; re-registering a resumed id is a
    // no-op (recordCompletedSyncAgent skips when an entry already exists).
    if (winner.ok) {
      recordCompletedSyncAgent({
        agentId,
        name,
        agentType: overrides.resolvedType,
        description,
        parentSessionId: ctx?.sessionId,
      });
      return winner.text;
    }
    throw winner.err;
  } catch (err) {
    emitSubAgentHook(ctx?.hooks, "subagent_error", { agentId, description, error: (err as Error).message });
    safeEmit(parentStream, { type: "agent_end", agentId, name, description, error: (err as Error).message, agentType: overrides.resolvedType });
    if (parentSignal?.aborted) return "Agent was aborted.";
    return `Agent error: ${(err as Error).message}`;
  } finally {
    if (bgTimer) clearTimeout(bgTimer);
    // Only detach the parent-abort listener when we awaited to completion.
    // On handoff, handoffToBackground already detached it (the agent is still
    // running and now follows the background contract, not parent-turn abort).
    if (!handedOff) parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Detach a still-running synchronous sub-agent into the background registry
 * (TODO 4.1). The agent KEEPS running on its existing signal — we attach
 * completion handlers that mirror the explicit run_in_background path so its
 * result/error arrives via the notification queue and the registry shows it as
 * a running (then completed/failed) background agent. Never aborts the agent.
 */
function handoffToBackground(
  runPromise: Promise<string>,
  controller: AbortController,
  meta: {
    agentId: string;
    name?: string;
    description: string;
    agentType?: string;
    sessionId?: string;
    hooks?: HookRegistry;
    parentSignal?: AbortSignal;
    onParentAbort: () => void;
    /**
     * UI sink for the terminal `agent_end` marker. The agent_start was already
     * emitted by runSubAgent before the handoff, so the UI card is 'working';
     * these handlers must close it out. On SUCCESS, runSubAgent's own agent_end
     * (it shares this runPromise and reaches its success emit) already fires —
     * so we only emit agent_end here for the failure/cancel paths, which
     * runSubAgent never reaches (it throws before its success emit).
     */
    uiStream?: StreamCallback;
  },
): void {
  const { agentId, name, description, agentType, sessionId, hooks, uiStream } = meta;

  // The agent outlives the spawning turn now, so parent-turn abort must NOT
  // cascade to it (same contract as an explicit background agent). Detach the
  // parent listener; cancellation from here on goes through AgentCancel.
  meta.parentSignal?.removeEventListener("abort", meta.onParentAbort);

  asyncAgentRegistry.register({
    agentId,
    name,
    agentType,
    description,
    sessionId,
    status: "running",
    startedAt: Date.now(),
    abort: () => controller.abort(),
  });

  // Tell the UI this agent is now running in the BACKGROUND (still working,
  // just detached from the parent turn). Without this the card's only signals
  // are agent_start (looks foreground) and the eventual agent_end — so during
  // the handoff→completion gap turn_complete's done-sweep marks it done and the
  // card collapses / shows no "running". (A: background-agent-visibility)
  safeEmit(uiStream, { type: "agent_backgrounded", agentId, name, description, agentType });

  // B: keep a liveness heartbeat going while this (and any sibling) background
  // agent runs, so the UI shows "alive" even through long LLM-request silence.
  // Idempotent; self-stops when no agent remains.
  ensureAgentHeartbeat();

  runPromise
    .then((text) => {
      asyncAgentRegistry.markCompleted(agentId);
      void writeAgentOutputFile(agentId, {
        status: "completed",
        body: text,
        description,
        name,
        onError: (m, meta) => logger.warn(m, meta),
      });
      if (sessionId) {
        notificationQueue.enqueue(
          { agentId, name, description, status: "completed", finalText: text, enqueuedAt: Date.now() },
          sessionId,
        );
      } else {
        logger.warn("agent_completion_without_session", { agentId, name, status: "completed" });
      }
      void hooks?.emit("notification", { kind: "agent_completed", agentId, name, description, finalText: text });
    })
    .catch((err: Error) => {
      // runSubAgent threw before its success agent_end, so the UI card is still
      // 'working'. Close it out with a terminal agent_end{error} (mirrors the
      // synchronous catch at the agentTool level).
      safeEmit(uiStream, { type: "agent_end", agentId, name, description, error: err.message, agentType });
      if (controller.signal.aborted) {
        asyncAgentRegistry.markCancelled(agentId);
        void hooks?.emit("notification", { kind: "agent_cancelled", agentId, name, description });
        return;
      }
      asyncAgentRegistry.markFailed(agentId);
      void writeAgentOutputFile(agentId, {
        status: "failed",
        body: err.message,
        description,
        name,
        onError: (m, meta) => logger.warn(m, meta),
      });
      if (sessionId) {
        notificationQueue.enqueue(
          { agentId, name, description, status: "failed", error: err.message, enqueuedAt: Date.now() },
          sessionId,
        );
      } else {
        logger.warn("agent_completion_without_session", { agentId, name, status: "failed" });
      }
      void hooks?.emit("notification", { kind: "agent_failed", agentId, name, description, error: err.message });
    });
}

// ─── AgentStatus / AgentCancel — companions to run_in_background ─

export const agentStatusToolDef: ToolDefinition = {
  name: "AgentStatus",
  description:
    "Check the status of a background agent launched with Agent(run_in_background=true). " +
    "Returns running / completed / failed / cancelled, plus the result text once finished. " +
    "Omit agent_id to list this session's background agents (pass all=true for every session in the process). " +
    "Results arrive automatically when an agent finishes — use this for an on-demand check, not to poll.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "The agent_id returned by Agent(run_in_background=true). Omit to list.",
      },
      all: {
        type: "boolean",
        description:
          "When listing (no agent_id): true lists background agents from every session in this process; " +
          "default (false) lists only the current session's.",
      },
    },
  },
};

export async function agentStatusTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const agentId = args.agent_id as string | undefined;

  if (!agentId) {
    const all = args.all === true;
    // Default to the current session's agents so concurrent sessions don't
    // leak into each other's listings; fall back to process-wide only when
    // there's no session context or the caller explicitly asks for `all`.
    const list =
      all || !ctx?.sessionId
        ? asyncAgentRegistry.list()
        : asyncAgentRegistry.listForSession(ctx.sessionId);
    if (list.length === 0) {
      return all || !ctx?.sessionId
        ? "No background agents in this process."
        : "No background agents in this session.";
    }
    return list
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

// ─── AgentSendInput — continue a previously-spawned sub-agent ────

export const agentSendInputToolDef: ToolDefinition = {
  name: "AgentSendInput",
  description:
    "Continue a sub-agent you previously launched with Agent — send it a follow-up " +
    "instruction that it answers WITH FULL MEMORY of its earlier work (its prior " +
    "messages, tool calls, and results). Use this instead of spawning a fresh agent " +
    "with a re-pasted context dump: it resumes the same conversation by replaying the " +
    "agent's saved transcript, so nothing is lost and you don't re-send what it already " +
    "knows.\n\n" +
    "Typical use: you got a partial result or a review verdict from a sub-agent, and now " +
    "you want it to revise / answer a follow-up / act on feedback. Pass only the " +
    "incremental instruction.\n\n" +
    "Pass the agent_id the Agent tool returned. Works for both synchronous and background " +
    "agents, and even after a process restart (the transcript is persisted on disk). " +
    "Returns the agent's new reply, synchronously (a long continuation auto-moves to the " +
    "background and notifies you on completion, like Agent does).",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description: "The agent_id returned by a prior Agent(...) call.",
      },
      prompt: {
        type: "string",
        description:
          "The follow-up instruction. The agent already remembers its earlier work — " +
          "send only what's new (feedback, the next step, a question).",
      },
    },
    required: ["agent_id", "prompt"],
  },
};

export async function agentSendInputTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const agentId = (args.agent_id as string | undefined)?.trim();
  const prompt = args.prompt as string | undefined;

  if (!agentId) return "Error: agent_id is required.";
  if (!prompt) return "Error: prompt is required.";

  if (!ctx?.subAgentSpawner) {
    return "Error: Agent tool is not configured (no subAgentSpawner in ctx).";
  }
  // Same flat-hierarchy rule as Agent: a sub-agent cannot continue (or spawn)
  // another sub-agent. Layered with the NESTED_AGENT_TOOLS strip in engine.ts.
  if (ctx.isSubAgent === true) {
    return "Error: nested agents are not supported. Sub-agents cannot send input to other sub-agents. Complete the task directly using your available tools.";
  }
  const spawner = ctx.subAgentSpawner;

  const parentSignal = args.__signal as AbortSignal | undefined;
  if (parentSignal?.aborted) {
    return "Agent aborted before resuming.";
  }

  // Resolve the child session to resume. With the agent_id===childSid
  // convention the child session is stored at sessions/<agent_id>/, so the
  // agent_id IS the resume target. Confirm it's resumable:
  //   1. in-memory registry (fast path, same process) — gives us the recorded
  //      childSessionId (== agentId) and the dock label/agentType;
  //   2. on-disk probe (cross-restart) — the registry is gone but the session
  //      transcript persists.
  // Both miss → the agent never existed or was cleaned up.
  const entry = asyncAgentRegistry.get(agentId);
  const resumeSessionId = entry?.childSessionId ?? agentId;
  const onDisk = spawner.sessionExists?.(resumeSessionId) ?? false;
  if (!entry && !onDisk) {
    return (
      `Error: no resumable sub-agent with agent_id "${agentId}". ` +
      `It may never have run or its session was cleaned up. ` +
      `Re-spawn with Agent(...) and a complete task description.`
    );
  }

  // Concurrency guard: a sub-agent that's still running (e.g. it auto-moved to
  // the background and hasn't finished) owns its child session. Resuming now
  // would build a SECOND child Engine that resumes the SAME session and appends
  // to the SAME transcript concurrently — sub-agents have no per-session
  // `active` lock (the protocol layer's serialization only covers top-level
  // sessions), so the two writers interleave and can corrupt the transcript.
  // Refuse until it finishes (or is cancelled).
  if (entry?.status === "running") {
    return (
      `Error: sub-agent "${agentId}" is still running. ` +
      `Wait for it to finish (poll with AgentStatus), or cancel it with ` +
      `AgentCancel, before sending it more input.`
    );
  }

  const name = entry?.name;
  const description = entry?.description ?? "sub-agent continuation";
  // Reconstruct the role's overrides from the recorded agentType. The child
  // Engine is built FRESH on every spawn (engine.ts spawn closure) — resuming a
  // session replays its transcript but the new Engine's tool/skill SCOPE comes
  // from req.toolAllowlist / req.skillAllowlist, NOT from the persisted session.
  // So if we didn't re-resolve these, a restricted role (e.g. a read-only
  // reviewer) would silently regain the parent's full tool set on continuation.
  // Re-resolving from agentType keeps the resumed turn under the same
  // tool/skill/model constraints as the original spawn. An ephemeral agent
  // (no agentType) resolves to empty overrides → inherits parent scope, same as
  // its first turn did.
  let overrides: AgentTypeOverrides;
  try {
    overrides = resolveAgentTypeOverrides(entry?.agentType, ctx?.agentDefinitions);
  } catch {
    // Role no longer exists (renamed/removed since spawn). Fall back to a bare
    // continuation rather than refusing — the transcript still carries the
    // role's system prompt, and replaying it is more useful than an error.
    overrides = { resolvedType: entry?.agentType };
  }

  const maxTurns = overrides.maxTurns ?? 15;
  const autoBgMs = resolveAutoBgMs();

  return runSyncSubAgent({
    spawner,
    agentId,
    name,
    description,
    prompt,
    maxTurns,
    overrides,
    autoBgMs,
    parentSignal,
    parentStream: spawner.parentStream,
    ctx,
    resumeSessionId,
  });
}
