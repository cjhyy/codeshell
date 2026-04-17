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

// ─── Runtime LLM config injection ───────────────────────────────

let _arenaLLMConfig: LLMConfig | undefined;

/**
 * Inject the engine's LLM config so Arena participants inherit baseUrl/apiKey.
 * Called by Engine.run() alongside setAskUserFn(), setSubAgentConfig(), etc.
 */
export function setArenaLLMConfig(config: LLMConfig | undefined): void {
  _arenaLLMConfig = config;
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

function resolveParticipant(nameOrPath: string): ArenaParticipant {
  const baseUrl = _arenaLLMConfig?.baseUrl;
  const apiKey = _arenaLLMConfig?.apiKey;

  const preset = MODEL_PRESETS[nameOrPath];
  if (preset) {
    return {
      name: nameOrPath,
      llm: {
        provider: preset.provider,
        model: preset.model,
        maxTokens: preset.maxOutputTokens,
        baseUrl,
        apiKey,
        temperature: ARENA_TEMPERATURE,
        // Arena uses non-streaming request/response for structured output
        enableStreaming: false,
      },
    };
  }
  // Treat as a full model path (e.g. "openai/gpt-4o")
  return {
    name: nameOrPath.split("/").pop() ?? nameOrPath,
    llm: {
      provider: "openai",
      model: nameOrPath,
      maxTokens: getMaxOutputTokens(nameOrPath),
      baseUrl,
      apiKey,
      temperature: ARENA_TEMPERATURE,
      enableStreaming: false,
    },
  };
}

/** Strip ANSI escape codes from chalk-styled text */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function arenaTool(args: Record<string, unknown>): Promise<string> {
  const topic = args.topic as string;
  if (!topic) return "Error: topic is required";

  const signal = args.__signal as AbortSignal | undefined;
  if (signal?.aborted) return "Arena aborted before starting.";

  const participantNames = (args.participants as string[] | undefined) ?? ["claude", "gpt"];
  if (participantNames.length < 2) {
    return "Error: Arena requires at least 2 participants. Provide 2 or more model names.";
  }

  const mode = args.mode as ArenaMode | undefined;
  const concluder = args.concluder as string | undefined;

  if (!_arenaLLMConfig) {
    return "Error: Arena LLM config not initialized. This is a bug — the engine should inject it via setArenaLLMConfig().";
  }

  const participants = participantNames.map((n) => resolveParticipant(n));

  // Collect progress for inclusion in the final tool result.
  // Strip ANSI codes from progress since tool results are plain text/markdown.
  const progressLog: string[] = [];
  const progressRenderer = createProgressRenderer((text) => {
    progressLog.push(stripAnsi(text));
  });

  try {
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
