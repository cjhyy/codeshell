/**
 * Arena CLI — multi-model collaborative analysis.
 *
 * V2 pipeline: Intent → Scope → Facts → Research → CrossReview → Consensus.
 *
 * Usage:
 *   code-shell arena "review the authentication module"
 *   /arena review my latest changes
 *   /arena --models claude,gpt4o is the error handling correct?
 *   /arena --mode planning how should we redesign the arena
 */

import chalk from "chalk";
import { Arena } from "../../arena/arena.js";
import { SettingsManager } from "../../settings/manager.js";
import {
  formatArenaResult,
  printArenaResult,
  renderProgress,
  createProgressRenderer,
} from "../../arena/render/terminal.js";
import type { OutputSink } from "../../arena/render/terminal.js";
import { formatArenaResultForSession } from "../../arena/render/session.js";
import type { ArenaMode, ArenaParticipant, ArenaResultV2 } from "../../arena/types.js";
import { MODEL_PRESETS, getMaxOutputTokens } from "../../arena/model-presets.js";
import { ModelPool, type ModelEntry } from "../../llm/model-pool.js";
import type { EngineConfig } from "../../engine/engine.js";
import type { LLMConfig } from "../../types.js";

// Re-export for backward compat with core-commands.ts
export { formatArenaResultForSession } from "../../arena/render/session.js";

/** Options for controlling arena output destination. */
export interface ArenaRunOptions {
  /** Output sink for progress/status messages (dim text in REPL). */
  output?: OutputSink;
  /** Output sink for final result (full markdown rendering in REPL). */
  outputMessage?: OutputSink;
}

/**
 * Run arena from CLI `code-shell arena "topic"` or REPL `/arena topic`.
 *
 * When `opts.output` is provided, all output goes through that sink
 * (for REPL integration via ctx.addStatus). Otherwise prints to stdout.
 */
export async function runArenaReview(
  arg: string,
  engineConfig: EngineConfig,
  opts?: ArenaRunOptions,
): Promise<ArenaResultV2 | undefined> {
  const { models: modelsFlag, mode: explicitMode, base, head, topic } = parseFlags(arg);
  const out: OutputSink = opts?.output ?? ((text) => console.log(text));

  if (!topic) {
    out(formatUsage());
    return undefined;
  }

  // Resolve participants
  const participants = resolveParticipants(engineConfig, modelsFlag);
  if (participants.length < 2) {
    out(formatModelHelp(engineConfig));
    return undefined;
  }

  // Header
  const modeLabel = explicitMode
    ? explicitMode.charAt(0).toUpperCase() + explicitMode.slice(1)
    : "Auto";
  out(chalk.bold(`═══ Arena ${modeLabel} ═══`));
  out(chalk.dim(`Topic:  ${topic}`));
  out(chalk.dim(`Models: ${participants.map((p) => p.name).join(" vs ")}`));

  // Run arena with V2 pipeline
  const progressRenderer = opts?.output
    ? createProgressRenderer(opts.output)
    : renderProgress;

  const arena = new Arena({
    participants,
    mode: explicitMode,
    enableContextTools: true,
    onProgress: progressRenderer,
  });

  try {
    const result = await arena.run(topic, {
      mode: explicitMode,
      base,
      head,
    });

    // Output result — use outputMessage (markdown) if available, else formatted text
    const resultSink = opts?.outputMessage ?? opts?.output;
    if (resultSink) {
      resultSink(formatArenaResultForSession(result));
    } else {
      printArenaResult(result);
    }
    return result;
  } catch (err) {
    out(chalk.red(`Arena failed: ${(err as Error).message}`));
    return undefined;
  }
}

// ─── Model Resolution ────────────────────────────────────────────

/**
 * Build a ModelPool from settings.models for arena participant resolution.
 */
function buildModelPool(engineConfig: EngineConfig): ModelPool {
  const pool = new ModelPool();
  try {
    const settings = new SettingsManager(process.cwd()).get();
    if (settings.models?.length) {
      for (const m of settings.models) {
        pool.register({
          key: m.key,
          label: m.label,
          provider: m.provider,
          model: m.model,
          baseUrl: m.baseUrl ?? engineConfig.llm.baseUrl,
          apiKey: m.apiKey ?? engineConfig.llm.apiKey,
          maxOutputTokens: m.maxOutputTokens,
        });
      }
    }
  } catch { /* no settings */ }
  return pool;
}

/**
 * Resolve a single participant entry (string key or full object) to ArenaParticipant.
 */
function resolveOneParticipant(
  entry: string | { name: string; model: string; provider?: string; apiKey?: string; baseUrl?: string },
  pool: ModelPool,
  engineConfig: EngineConfig,
): ArenaParticipant | undefined {
  if (typeof entry === "string") {
    // Pool key
    const m = pool.get(entry);
    if (!m) return undefined;
    return {
      name: m.label ?? modelDisplayName(m.model),
      llm: {
        provider: m.provider,
        model: m.model,
        apiKey: m.apiKey ?? engineConfig.llm.apiKey,
        baseUrl: m.baseUrl ?? engineConfig.llm.baseUrl,
        temperature: 0.3,
        maxTokens: m.maxOutputTokens ?? getMaxOutputTokens(m.model),
        enableStreaming: false,
      },
    };
  }
  // Full object (backward compat)
  return {
    name: entry.name,
    llm: {
      provider: entry.provider ?? engineConfig.llm.provider,
      model: entry.model,
      apiKey: entry.apiKey ?? engineConfig.llm.apiKey,
      baseUrl: entry.baseUrl ?? engineConfig.llm.baseUrl,
      temperature: 0.3,
      maxTokens: getMaxOutputTokens(entry.model),
      enableStreaming: false,
    } satisfies LLMConfig,
  };
}

function resolveParticipants(
  engineConfig: EngineConfig,
  modelsFlag?: string,
): ArenaParticipant[] {
  const pool = buildModelPool(engineConfig);

  if (modelsFlag) {
    // --models flag: comma-separated pool keys or model paths
    const names = modelsFlag.split(",").map((n) => n.trim().toLowerCase());
    return names.map((name) => {
      // Try pool first
      const fromPool = pool.get(name);
      if (fromPool) {
        return {
          name: fromPool.label ?? modelDisplayName(fromPool.model),
          llm: {
            provider: fromPool.provider,
            model: fromPool.model,
            apiKey: fromPool.apiKey ?? engineConfig.llm.apiKey,
            baseUrl: fromPool.baseUrl ?? engineConfig.llm.baseUrl,
            temperature: 0.3,
            maxTokens: fromPool.maxOutputTokens ?? getMaxOutputTokens(fromPool.model),
            enableStreaming: false,
          },
        };
      }
      // Fallback to MODEL_PRESETS (backward compat)
      const preset = MODEL_PRESETS[name];
      if (preset) {
        return {
          name: modelDisplayName(preset.model),
          llm: {
            provider: preset.provider,
            model: preset.model,
            apiKey: engineConfig.llm.apiKey,
            baseUrl: engineConfig.llm.baseUrl,
            temperature: 0.3,
            maxTokens: preset.maxOutputTokens,
            enableStreaming: false,
          },
        };
      }
      // Raw model path
      return {
        name: modelDisplayName(name),
        llm: { ...engineConfig.llm, model: name, enableStreaming: false },
      };
    });
  }

  // From settings.arena.participants
  const settings = new SettingsManager(process.cwd()).get();
  if (settings.arena?.participants?.length >= 2) {
    const resolved = settings.arena.participants
      .map((p: string | object) => resolveOneParticipant(p as any, pool, engineConfig))
      .filter((p: any): p is ArenaParticipant => p !== undefined);
    if (resolved.length >= 2) return resolved;
  }

  // Auto fallback: current model + one opponent (OpenRouter only)
  const participants: ArenaParticipant[] = [
    {
      name: modelDisplayName(engineConfig.llm.model),
      llm: {
        ...engineConfig.llm,
        maxTokens: getMaxOutputTokens(engineConfig.llm.model),
        enableStreaming: false,
      },
    },
  ];

  if (engineConfig.llm.baseUrl?.includes("openrouter")) {
    const current = engineConfig.llm.model;
    const opponent = current.includes("claude")
      ? "openai/gpt-5.4"
      : "anthropic/claude-opus-4.6";
    participants.push({
      name: modelDisplayName(opponent),
      llm: {
        ...engineConfig.llm,
        model: opponent,
        maxTokens: getMaxOutputTokens(opponent),
        enableStreaming: false,
      },
    });
  }

  return participants;
}

// ─── Arg Parsing ─────────────────────────────────────────────────

const VALID_MODES: ArenaMode[] = ["review", "discussion", "planning"];

function parseFlags(arg: string): {
  models?: string;
  mode?: ArenaMode;
  base?: string;
  head?: string;
  topic: string;
} {
  let models: string | undefined;
  let mode: ArenaMode | undefined;
  let base: string | undefined;
  let head: string | undefined;
  const remaining: string[] = [];

  const tokens = arg.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--models" && tokens[i + 1]) {
      models = tokens[++i];
    } else if (tokens[i] === "--mode" && tokens[i + 1]) {
      const val = tokens[++i].toLowerCase() as ArenaMode;
      if (VALID_MODES.includes(val)) {
        mode = val;
      } else {
        console.log(chalk.yellow(`  Unknown mode "${val}", valid: ${VALID_MODES.join(", ")}`));
      }
    } else if (tokens[i] === "--base" && tokens[i + 1]) {
      base = tokens[++i];
    } else if (tokens[i] === "--head" && tokens[i + 1]) {
      head = tokens[++i];
    } else {
      remaining.push(tokens[i]);
    }
  }

  return { models, mode, base, head, topic: remaining.join(" ").trim() };
}

// ─── Output ──────────────────────────────────────────────────────

function formatUsage(): string {
  return [
    chalk.bold("Arena — Multi-model collaborative analysis"),
    "",
    chalk.dim("Usage:"),
    "  /arena review the authentication module",
    "  /arena --models claude,gpt4o is the error handling correct?",
    "  /arena --mode planning design the new auth system",
    "  /arena --mode discussion should we use REST or GraphQL",
    "  /arena --base main review changes since main",
    '  code-shell arena "review my latest changes"',
    "",
    `${chalk.dim("Modes:")} review (default), discussion, planning`,
    chalk.dim("Mode is auto-detected from the topic if --mode is not specified."),
    "",
    chalk.dim("Flags:"),
    "  --base <ref>   Base branch/ref for comparison",
    "  --head <ref>   Head branch/ref (default: HEAD)",
    "",
    `${chalk.dim("Available model presets:")} ${Object.keys(MODEL_PRESETS).join(", ")}`,
  ].join("\n");
}

function formatModelHelp(engineConfig: EngineConfig): string {
  return [
    chalk.red("Arena needs at least 2 models."),
    "",
    "Use --models to specify:",
    "  /arena --models claude,gpt4o review the code",
    "",
    "Or configure in ~/.code-shell/settings.json:",
    '  "arena": { "participants": [',
    '    { "name": "Claude", "model": "anthropic/claude-sonnet-4-20250514" },',
    '    { "name": "GPT-4o", "model": "openai/gpt-4o" }',
    "  ]}",
  ].join("\n");
}

function modelDisplayName(model: string): string {
  const last = model.split("/").pop() ?? model;
  return last
    .replace(/-\d.*$/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
