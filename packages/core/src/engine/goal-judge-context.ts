import { createHash } from "node:crypto";
import { estimateTokens, groupMessagesByApiRound } from "../context/compaction.js";
import { sanitizeMessages } from "../logging/sanitize-messages.js";
import type { GoalJudgeRuntimeContext } from "../hooks/goal-stop-hook.js";
import type { ContentBlock, Message } from "../types.js";

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_ESTIMATED_TOKENS = 3_000;
const DEFAULT_MAX_CHARS = 12_000;

export interface BuildGoalJudgeContextOptions {
  maxRounds?: number;
  maxEstimatedTokens?: number;
  maxChars?: number;
  sensitiveToolResultRedactions?: ReadonlyMap<string, string>;
}

type GoalJudgeImageBlock = ContentBlock & {
  source: ContentBlock["source"] & { bytes?: number; omitted?: true };
};

function sanitizeNestedBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "reasoning") {
      return { type: "reasoning", text: "[reasoning omitted]" };
    }
    if (block.type === "image" && block.source?.type === "base64") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.source.media_type,
          bytes: block.source.data?.length ?? 0,
          omitted: true,
        },
      } as GoalJudgeImageBlock;
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return { ...block, content: sanitizeNestedBlocks(block.content) };
    }
    return { ...block };
  });
}

function sanitizeConversation(
  messages: readonly Message[],
  sensitiveToolResultRedactions?: ReadonlyMap<string, string>,
): Message[] {
  return sanitizeMessages(messages, { sensitiveToolResultRedactions }).map((message) => ({
    ...message,
    content:
      typeof message.content === "string"
        ? message.content
        : sanitizeNestedBlocks(message.content as ContentBlock[]),
  }));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function renderBlock(block: ContentBlock, role: Message["role"]): string {
  const roleLabel = role.toUpperCase();
  if (block.type === "text") return `${roleLabel}:\n${block.text ?? ""}`;
  if (block.type === "reasoning") return `${roleLabel}:\n[reasoning omitted]`;
  if (block.type === "tool_use") {
    return `${roleLabel} TOOL_USE id=${block.id ?? "(missing)"} name=${block.name ?? "(missing)"} input=${stableJson(block.input ?? {})}`;
  }
  if (block.type === "tool_result") {
    const content = Array.isArray(block.content)
      ? block.content.map((entry) => renderBlock(entry, role)).join("\n")
      : (block.content ?? "");
    return `TOOL_RESULT tool_use_id=${block.tool_use_id ?? "(missing)"} error=${block.is_error === true}:\n${content}`;
  }
  if (block.type === "image") {
    const source = block.source as GoalJudgeImageBlock["source"] | undefined;
    return `${roleLabel} IMAGE media_type=${source?.media_type ?? "unknown"} bytes=${source?.bytes ?? 0} omitted=true`;
  }
  return `${roleLabel}:\n[unsupported content omitted]`;
}

function renderConversation(rounds: Message[][]): string {
  if (rounds.length === 0) return "(无最近对话)";
  return rounds
    .map((round, index) => {
      const renderedMessages = round.map((message) => {
        if (typeof message.content === "string") {
          return `${message.role.toUpperCase()}:\n${message.content}`;
        }
        return message.content.map((block) => renderBlock(block, message.role)).join("\n");
      });
      return `[round ${index + 1}]\n${renderedMessages.join("\n")}`;
    })
    .join("\n\n");
}

function truncationMarker(originalChars: number): string {
  return `[truncated for goal judge; originalChars=${originalChars}]`;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = truncationMarker(value.length);
  if (maxChars <= marker.length) return marker;
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function truncateUnknown(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") return truncateString(value, maxChars);
  if (Array.isArray(value)) return value.map((entry) => truncateUnknown(entry, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        truncateUnknown(entry, maxChars),
      ]),
    );
  }
  return value;
}

function truncateBlock(block: ContentBlock, maxChars: number): ContentBlock {
  if (block.type === "text") return { ...block, text: truncateString(block.text ?? "", maxChars) };
  if (block.type === "tool_use") {
    return {
      ...block,
      input: truncateUnknown(block.input ?? {}, maxChars) as Record<string, unknown>,
    };
  }
  if (block.type === "tool_result") {
    return {
      ...block,
      content: Array.isArray(block.content)
        ? block.content.map((entry) => truncateBlock(entry, maxChars))
        : truncateString(block.content ?? "", maxChars),
    };
  }
  return { ...block };
}

function emergencyTruncate(round: Message[], maxChars: number, maxTokens: number): Message[] {
  let fieldBudget = Math.max(48, Math.floor(maxChars / 3));
  let candidate = round;
  for (let attempt = 0; attempt < 16; attempt++) {
    candidate = round.map((message) => ({
      ...message,
      content:
        typeof message.content === "string"
          ? truncateString(message.content, fieldBudget)
          : message.content.map((block) => truncateBlock(block, fieldBudget)),
    }));
    if (
      renderConversation([candidate]).length <= maxChars &&
      estimateTokens(candidate) <= maxTokens
    ) {
      return candidate;
    }
    fieldBudget = Math.max(0, Math.floor(fieldBudget / 2));
  }
  return candidate;
}

export function buildGoalJudgeRuntimeContext(
  messages: readonly Message[],
  options: BuildGoalJudgeContextOptions = {},
): GoalJudgeRuntimeContext {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const maxEstimatedTokens = Math.max(
    1,
    options.maxEstimatedTokens ?? DEFAULT_MAX_ESTIMATED_TOKENS,
  );
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const sanitized = sanitizeConversation(messages, options.sensitiveToolResultRedactions);
  const allRounds = groupMessagesByApiRound(sanitized);
  let selected = allRounds.slice(-maxRounds);
  let truncated = selected.length !== allRounds.length;

  while (selected.length > 1) {
    const conversation = selected.flat();
    if (
      estimateTokens(conversation) <= maxEstimatedTokens &&
      renderConversation(selected).length <= maxChars
    ) {
      break;
    }
    selected = selected.slice(1);
    truncated = true;
  }

  if (selected.length === 1) {
    const conversation = selected[0]!;
    if (
      estimateTokens(conversation) > maxEstimatedTokens ||
      renderConversation(selected).length > maxChars
    ) {
      selected = [emergencyTruncate(conversation, maxChars, maxEstimatedTokens)];
      truncated = true;
    }
  }

  const conversation = selected.flat();
  const renderedConversation = renderConversation(selected);
  return {
    conversation,
    renderedConversation,
    digest: createHash("sha256").update(renderedConversation).digest("hex").slice(0, 16),
    selectedRoundCount: selected.length,
    sourceRoundCount: allRounds.length,
    estimatedTokens: estimateTokens(conversation),
    chars: renderedConversation.length,
    truncated,
  };
}
