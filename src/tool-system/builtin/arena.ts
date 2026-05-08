/**
 * Built-in Arena tool — multi-model collaborative analysis.
 *
 * Launches an arena session where multiple LLM participants independently
 * research a topic, cross-review each other's findings, and build consensus.
 *
 * The LLM config (baseUrl, apiKey) is injected at runtime by the Engine via
 * setArenaLLMConfig(), following the same pattern as setAskUserFn() and
 * setSubAgentConfig().
 */

import type { ToolDefinition, LLMConfig } from "../../types.js";
import { Arena, MODEL_PRESETS, getMaxOutputTokens } from "../../arena/index.js";
import { createProgressRenderer } from "../../arena/render/terminal.js";
import { formatArenaResultForSession } from "../../arena/render/session.js";
import type { ArenaMode, ArenaParticipant } from "../../arena/types.js";
import type { ModelPool, ModelEntry } from "../../llm/model-pool.js";
import type { ToolContext } from "../context.js";

export const arenaToolDef: ToolDefinition = {
  name: "Arena",
  description:
    "Launch a multi-model collaborative analysis session. " +
    "Arena automatically detects the mode, analysis perspective (lens), and evidence sources from the user's natural language request. " +
    "Supports: code review, PRD/document review, architecture planning, product discussions, open-ended debates, and more. " +
    "Multiple LLM participants independently research the topic, cross-review findings, and produce structured consensus. " +
    "Use model preset names (e.g. 'claude', 'gpt', 'gemini', 'deepseek') or full model paths.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description:
          "The topic or question to analyze in natural language. Arena auto-detects mode/lens/sources. " +
          "Examples: 'review my latest changes', 'review 这个 PRD 是否完整', '讨论 arena 的产品定位', " +
          "'规划通用化重构方案', 'discuss whether we should productize arena'",
      },
      mode: {
        type: "string",
        enum: ["review", "discussion", "planning"],
        description: "Arena mode override. Usually auto-detected from topic. 'review' for structured review, 'discussion' for open analysis, 'planning' for roadmaps.",
      },
      participants: {
        type: "array",
        items: { type: "string" },
        description:
          "Model preset names or full model paths for participants (min 2). " +
          "Preset names: " + Object.keys(MODEL_PRESETS).join(", ") + ". " +
          "Default: ['claude', 'gpt'] if omitted.",
      },
      concluder: {
        type: "string",
        description: "Which participant builds the final consensus (by name). Default: first participant.",
      },
    },
    required: ["topic"],
  },
};

// ─── Runtime LLM config — read from ctx, not module singletons ──

/**
 * Snapshot of last-known Arena config, kept for the protocol-level
 * /arena-status query. The query is not tied to an in-flight tool
 * invocation, so it can't read ctx; instead, ctx-bearing tool calls
 * publish their config here for the status endpoint to read back.
 *
 * This is a read-only cache used purely for diagnostics — Arena's
 * actual execution path always reads from the per-call ctx.
 */
let _lastSeenLLMConfig: LLMConfig | undefined;
let _lastSeenModelPool: ModelPool | undefined;

/**
 * Snapshot of what Arena would do right now if invoked. Used by the
 * `/arena` REPL command (via the protocol `arena_status` query) so
 * users can see participants/endpoint before launching a run.
 */
export interface ArenaStatus {
  endpoint?: string;
  defaultParticipants: Array<{
    name: string;
    model: string;
    source: "pool" | "preset" | "raw";
    compatible: boolean;
    reason?: string;
  }>;
  poolSize: number;
}

export function getArenaStatus(): ArenaStatus {
  const baseUrl = _lastSeenLLMConfig?.baseUrl;
  const entries = _lastSeenModelPool?.list() ?? [];
  const defaults = resolveDefaultParticipantNames(entries);

  const probed = defaults.map((name) => {
    const r = probeParticipant(name, entries, _lastSeenLLMConfig);
    return {
      name,
      model: r.modelPath,
      source: r.source,
      compatible: r.compatible,
      ...(r.reason ? { reason: r.reason } : {}),
    };
  });

  return {
    endpoint: baseUrl,
    defaultParticipants: probed,
    poolSize: entries.length,
  };
}

/**
 * Resolve a preset name or model path into an ArenaParticipant,
 * inheriting baseUrl/apiKey from the engine's LLM config.
 */
/**
 * Arena uses a lower temperature than the default conversation model
 * to produce more deterministic, evidence-grounded analysis.
 */
const ARENA_TEMPERATURE = 0.3;

/**
 * Resolution priority:
 *   1. ModelPool key (the user's own configured models — uses each
 *      entry's own baseUrl/apiKey, so e.g. a "claude" pool entry
 *      pointing at OpenRouter still works while the active session
 *      runs on DeepSeek direct).
 *   2. MODEL_PRESETS — only if the active endpoint can accept the
 *      preset's model namespace; otherwise we throw rather than
 *      silently miswire credentials.
 *   3. Raw model path against the active endpoint.
 */
function resolveParticipant(
  nameOrPath: string,
  llmConfig: LLMConfig,
  pool: ModelPool | undefined,
): ArenaParticipant {
  const fallbackBaseUrl = llmConfig.baseUrl;
  const fallbackApiKey = llmConfig.apiKey;

  // (1) ModelPool entry — preferred path
  const poolEntry = pool?.get(nameOrPath);
  if (poolEntry) return participantFromPool(poolEntry, llmConfig);

  // (2) Built-in preset
  const preset = MODEL_PRESETS[nameOrPath];
  if (preset) {
    assertEndpointAcceptsModel(fallbackBaseUrl, preset.model, nameOrPath);
    return {
      name: nameOrPath,
      llm: {
        provider: preset.provider,
        model: preset.model,
        maxTokens: preset.maxOutputTokens,
        baseUrl: fallbackBaseUrl,
        apiKey: fallbackApiKey,
        temperature: ARENA_TEMPERATURE,
        enableStreaming: false,
      },
    };
  }

  // (3) Raw model path
  assertEndpointAcceptsModel(fallbackBaseUrl, nameOrPath, nameOrPath);
  return {
    name: nameOrPath.split("/").pop() ?? nameOrPath,
    llm: {
      provider: "openai",
      model: nameOrPath,
      maxTokens: getMaxOutputTokens(nameOrPath),
      baseUrl: fallbackBaseUrl,
      apiKey: fallbackApiKey,
      temperature: ARENA_TEMPERATURE,
      enableStreaming: false,
    },
  };
}

function participantFromPool(entry: ModelEntry, llmConfig: LLMConfig): ArenaParticipant {
  // Pool entries carry their own baseUrl/apiKey — never paper over
  // them with the active session's credentials, which is exactly the
  // bug that caused 401/400s when Arena ran on a DeepSeek-only
  // session but the pool had OpenRouter-keyed entries.
  return {
    name: entry.key,
    llm: {
      provider: entry.provider,
      model: entry.model,
      maxTokens: entry.maxOutputTokens ?? getMaxOutputTokens(entry.model),
      baseUrl: entry.baseUrl ?? llmConfig.baseUrl,
      apiKey: entry.apiKey ?? llmConfig.apiKey,
      temperature: ARENA_TEMPERATURE,
      enableStreaming: false,
    },
  };
}

/**
 * Non-throwing variant of resolveParticipant used by /arena status —
 * we want to *display* what would happen, not bail.
 */
function probeParticipant(
  nameOrPath: string,
  poolEntries: ModelEntry[],
  llmConfig: LLMConfig | undefined,
): { modelPath: string; source: "pool" | "preset" | "raw"; compatible: boolean; reason?: string } {
  const fromPool = poolEntries.find((e) => e.key === nameOrPath);
  if (fromPool) {
    return { modelPath: fromPool.model, source: "pool", compatible: true };
  }
  const preset = MODEL_PRESETS[nameOrPath];
  const modelPath = preset?.model ?? nameOrPath;
  const source: "preset" | "raw" = preset ? "preset" : "raw";

  const baseUrl = llmConfig?.baseUrl;
  const endpointVendor = baseUrl ? inferEndpointVendor(baseUrl) : null;
  const modelVendor = modelPath.includes("/") ? modelPath.split("/")[0].toLowerCase() : null;
  if (endpointVendor && modelVendor && modelVendor !== endpointVendor) {
    return {
      modelPath,
      source,
      compatible: false,
      reason: `endpoint serves "${endpointVendor}" only`,
    };
  }
  return { modelPath, source, compatible: true };
}

/**
 * Quick, non-throwing predicate: would `nameOrPath` resolve to a
 * working participant on the current endpoint? Used to decide whether
 * the model's chosen `participants` list is honorable, or whether we
 * should silently swap in the pool defaults (single-vendor endpoint
 * with cross-vendor preset names is the common bad case).
 */
function participantWouldResolve(
  nameOrPath: string,
  poolEntries: ModelEntry[],
  baseUrl: string | undefined,
): boolean {
  return probeParticipant(nameOrPath, poolEntries, baseUrl ? { baseUrl } as LLMConfig : undefined).compatible;
}

/**
 * If the user didn't explicitly pass `participants`, default to every
 * pool entry. With <2 entries, fall back to pre-existing behavior so
 * we don't regress installs that haven't filled out the pool yet.
 */
function resolveDefaultParticipantNames(poolEntries: ModelEntry[]): string[] {
  if (poolEntries.length >= 2) {
    return poolEntries.map((e) => e.key);
  }
  if (poolEntries.length === 1) {
    // Single-model pool: use it twice — Arena requires ≥2. Same model
    // running twice still gives a useful self-review pass.
    const onlyKey = poolEntries[0]!.key;
    return [onlyKey, onlyKey];
  }
  // Empty pool: legacy fallback. The endpoint check downstream will
  // turn an obviously-wrong combo (e.g. claude preset on DeepSeek
  // direct) into a fast, descriptive error.
  return ["claude", "gpt"];
}

/**
 * Arena presets use OpenRouter-style namespaced model paths
 * (`anthropic/claude-opus-4.6`, `openai/gpt-5.4`, etc.). Those only
 * resolve correctly on a multi-provider gateway like OpenRouter — a
 * vendor's direct endpoint will reject any model name that isn't its
 * own and we'd burn tens of seconds on retries before the user sees
 * a useful error. Fail fast instead, naming the conflict.
 */
function assertEndpointAcceptsModel(
  baseUrl: string | undefined,
  modelPath: string,
  participantLabel: string,
): void {
  if (!baseUrl) return;

  const endpointVendor = inferEndpointVendor(baseUrl);
  if (!endpointVendor) return; // unknown gateway — assume permissive (e.g. OpenRouter, custom)

  const modelVendor = modelPath.includes("/") ? modelPath.split("/")[0].toLowerCase() : null;

  // Direct endpoint, no vendor prefix → caller must have used the
  // exact model name the endpoint expects. Trust it.
  if (modelVendor === null) return;

  if (modelVendor !== endpointVendor) {
    throw new Error(
      `Arena participant "${participantLabel}" maps to model "${modelPath}", ` +
        `but the active endpoint (${baseUrl}) only serves "${endpointVendor}" models. ` +
        `Either switch to an aggregator endpoint (e.g. OpenRouter) or pick participants ` +
        `whose models are native to this provider (e.g. "deepseek-v4-pro").`,
    );
  }
}

function inferEndpointVendor(baseUrl: string): string | null {
  const u = baseUrl.toLowerCase();
  if (u.includes("api.deepseek.com")) return "deepseek";
  if (u.includes("api.openai.com")) return "openai";
  if (u.includes("api.anthropic.com")) return "anthropic";
  if (u.includes("generativelanguage.googleapis.com")) return "google";
  // OpenRouter, Together, custom proxies, etc. — assume multi-vendor.
  return null;
}

function formatStartupBanner(
  participants: string[],
  poolEntries: ModelEntry[],
  userProvided: boolean,
  llmConfig: LLMConfig,
  coercedFromExplicit = false,
): string {
  const endpoint = llmConfig.baseUrl ?? "(none)";
  const lines: string[] = [];
  lines.push(`Arena: endpoint=${endpoint}`);
  const sourceTag = coercedFromExplicit
    ? "pool (auto-corrected from incompatible user picks)"
    : userProvided
      ? "user-specified"
      : poolEntries.length >= 2
        ? "pool"
        : poolEntries.length === 1
          ? "pool (singleton — running self-review)"
          : "preset fallback";
  lines.push(`Arena: participants=${participants.join(", ")} (${sourceTag})`);
  return lines.join("\n");
}

/** Strip ANSI escape codes from chalk-styled text */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function arenaTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const topic = args.topic as string;
  if (!topic) return "Error: topic is required";

  const signal = args.__signal as AbortSignal | undefined;
  if (signal?.aborted) return "Arena aborted before starting.";

  if (!ctx?.llmConfig) {
    return "Error: Arena LLM config not initialized. This is a bug — the engine should inject it via ToolContext.";
  }
  const llmConfig = ctx.llmConfig;
  const pool = ctx.modelPool;

  // Update the diagnostic snapshot used by /arena-status
  _lastSeenLLMConfig = llmConfig;
  _lastSeenModelPool = pool;

  const explicitParticipants = args.participants as string[] | undefined;
  const poolEntries = pool?.list() ?? [];

  // The model is supposed to pick `participants` itself, but its prior
  // doesn't include the user's actual endpoint, so it routinely picks
  // hard-coded preset names like ["claude", "gpt"] that fail
  // immediately on a single-vendor endpoint (e.g. DeepSeek direct).
  // When that happens, override silently with the pool's defaults
  // rather than burning a round-trip on the inevitable error.
  // Honor explicit participants only when *every* one of them
  // resolves on the current endpoint.
  let participantNames: string[];
  let coercedFromExplicit = false;
  if (explicitParticipants && explicitParticipants.length > 0) {
    const allCompatible = explicitParticipants.every((name) =>
      participantWouldResolve(name, poolEntries, llmConfig.baseUrl),
    );
    if (allCompatible) {
      participantNames = explicitParticipants;
    } else {
      coercedFromExplicit = true;
      participantNames = resolveDefaultParticipantNames(poolEntries);
    }
  } else {
    participantNames = resolveDefaultParticipantNames(poolEntries);
  }

  if (participantNames.length < 2) {
    return "Error: Arena requires at least 2 participants. Provide 2 or more model names.";
  }

  const mode = args.mode as ArenaMode | undefined;
  const concluder = args.concluder as string | undefined;

  // Collect progress for inclusion in the final tool result.
  // Strip ANSI codes from progress since tool results are plain text/markdown.
  const progressLog: string[] = [];
  const progressRenderer = createProgressRenderer((text) => {
    progressLog.push(stripAnsi(text));
  });

  // Surface the resolved configuration up front so the user can see
  // exactly which models will be polled and against which endpoint —
  // previously this was invisible until something blew up.
  const configLine = formatStartupBanner(
    participantNames,
    poolEntries,
    explicitParticipants !== undefined,
    llmConfig,
    coercedFromExplicit,
  );
  progressLog.push(configLine);

  try {
    // resolveParticipant() may throw on endpoint/model mismatch — keep
    // it inside the try so the error returns as a tool-result string
    // rather than crashing the engine.
    const participants = participantNames.map((n) => resolveParticipant(n, llmConfig, pool));

    const arena = new Arena({
      participants,
      mode,
      concluder,
      enableContextTools: true,
      onProgress: progressRenderer,
      signal,
    });

    const result = await arena.run(topic);

    // Use session renderer (markdown, no ANSI) for tool results.
    // Terminal renderer (chalk) is only for direct stdout printing.
    const formattedResult = formatArenaResultForSession(result);

    // Prepend a condensed progress summary so the LLM can see what was done
    const progressSummary = progressLog.length > 0
      ? "── Arena Progress ──\n" + progressLog.join("\n") + "\n\n"
      : "";

    // Cap total output to prevent context overflow
    const MAX_TOOL_OUTPUT = 30_000;
    const full = progressSummary + formattedResult;
    if (full.length > MAX_TOOL_OUTPUT) {
      return full.slice(0, MAX_TOOL_OUTPUT) + "\n\n... (truncated, total " + full.length + " chars)";
    }
    return full;
  } catch (err) {
    if (signal?.aborted) return "Arena aborted.";
    return `Arena error: ${(err as Error).message}`;
  }
}
