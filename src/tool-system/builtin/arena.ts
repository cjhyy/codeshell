/**
 * Built-in Arena tool — multi-model collaborative analysis.
 *
 * Launches an arena session where multiple LLM participants independently
 * research a topic, cross-review each other's findings, and build consensus.
 *
 * The tool asks the user for confirmation before starting (via AskUserQuestion)
 * because arena sessions consume significant tokens across multiple models.
 */

import type { ToolDefinition } from "../../types.js";
import { Arena, MODEL_PRESETS, getMaxOutputTokens } from "../../arena/index.js";
import { formatArenaResult } from "../../arena/render/terminal.js";
import type { ArenaMode, ArenaParticipant } from "../../arena/types.js";
import { askUserTool } from "./ask-user.js";

export const arenaToolDef: ToolDefinition = {
  name: "Arena",
  description:
    "Launch a multi-model collaborative analysis session. " +
    "Multiple LLM participants independently research a topic, cross-review each other's findings, " +
    "and produce a structured consensus with strengths, improvements, risks, and action items. " +
    "Modes: 'review' (code review), 'discussion' (open-ended analysis), 'planning' (roadmap/architecture). " +
    "Use model preset names (e.g. 'claude', 'gpt', 'gemini', 'deepseek') or full model paths. " +
    "This tool will ask the user for confirmation before starting because it consumes significant tokens.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "The topic or question to analyze (e.g. 'review the auth middleware changes', 'discuss the migration strategy')",
      },
      mode: {
        type: "string",
        enum: ["review", "discussion", "planning"],
        description: "Arena mode. 'review' for code review, 'discussion' for open analysis, 'planning' for roadmaps. Default: auto-detected from topic.",
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

/**
 * Resolve a preset name or model path into an ArenaParticipant.
 */
function resolveParticipant(nameOrPath: string): ArenaParticipant {
  const preset = MODEL_PRESETS[nameOrPath];
  if (preset) {
    return {
      name: nameOrPath,
      llm: {
        provider: preset.provider,
        model: preset.model,
        maxTokens: preset.maxOutputTokens,
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
    },
  };
}

export async function arenaTool(args: Record<string, unknown>): Promise<string> {
  const topic = args.topic as string;
  if (!topic) return "Error: topic is required";

  const participantNames = (args.participants as string[] | undefined) ?? ["claude", "gpt"];
  if (participantNames.length < 2) {
    return "Error: Arena requires at least 2 participants. Provide 2 or more model names.";
  }

  const mode = args.mode as ArenaMode | undefined;
  const concluder = args.concluder as string | undefined;

  // Ask user for confirmation before starting
  const participantList = participantNames.join(", ");
  const modeLabel = mode ?? "auto-detect";
  const confirmQuestion =
    `Ready to start an Arena session:\n` +
    `  Topic: ${topic}\n` +
    `  Mode: ${modeLabel}\n` +
    `  Participants: ${participantList}\n\n` +
    `This will send requests to multiple models. Proceed? (yes/no)`;

  const answer = await askUserTool({ question: confirmQuestion });
  const normalized = answer.toLowerCase().trim();
  if (normalized !== "yes" && normalized !== "y" && normalized !== "是") {
    return "Arena session cancelled by user.";
  }

  // Resolve participants
  const participants = participantNames.map(resolveParticipant);

  try {
    const arena = new Arena({
      participants,
      mode,
      concluder,
      enableContextTools: true,
    });

    const result = await arena.run(topic);
    return formatArenaResult(result);
  } catch (err) {
    return `Arena error: ${(err as Error).message}`;
  }
}
