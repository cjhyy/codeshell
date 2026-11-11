import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Message, ToolDefinition } from "../../types.js";
import { matchesToolDiscoverySchema } from "../../utils/tool-schema-discovery.js";
import {
  uniquePromptCacheBreakpointIndexes,
  type PromptCachePolicy,
  type PromptCacheRequestContext,
} from "../prompt-cache.js";

// SDK 0.39 passes JSON bodies through but predates these Messages fields. Keep
// the wire extension local instead of widening engine/provider-neutral types.
type NativeTool = Anthropic.Tool & { defer_loading?: true };
type Reference = { type: "tool_reference"; tool_name: string };
type ResultPart = Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Reference;

export function anthropicSystem(
  systemPrompt: string,
  policy: PromptCachePolicy,
): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: systemPrompt,
      ...(policy.breakpoints.includes("system")
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    },
  ];
}

export function anthropicTools(
  tools: readonly ToolDefinition[],
  policy: PromptCachePolicy,
): Anthropic.Tool[] {
  const converted: NativeTool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    ...(policy.toolDiscovery === "tool-reference" && tool.deferLoading
      ? { defer_loading: true as const }
      : {}),
  }));
  // Deferred schemas may not carry cache_control. Eager tools keep their exact
  // position; discovery never moves the marker or edits the frozen tool array.
  const lastEager = [...converted].reverse().find((tool) => !tool.defer_loading);
  if (lastEager && policy.breakpoints.includes("tools"))
    lastEager.cache_control = { type: "ephemeral" };
  return converted;
}

function imagePart(block: ContentBlock): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: block.source!.media_type as Anthropic.Base64ImageSource["media_type"],
      data: block.source!.data,
    },
  };
}

function toolResult(
  block: ContentBlock,
  deferred: ReadonlyMap<string, ToolDefinition>,
): Anthropic.ToolResultBlockParam {
  let content: string | ResultPart[] = "";
  if (typeof block.content === "string") content = block.content;
  else if (Array.isArray(block.content)) {
    content = [];
    for (const part of block.content) {
      const definition = part.discoveredTool ? deferred.get(part.discoveredTool.name) : undefined;
      if (!block.is_error && definition && matchesToolDiscoverySchema(part, definition)) {
        content.push({ type: "tool_reference", tool_name: definition.name });
      } else if (part.type === "text" && part.text) content.push({ type: "text", text: part.text });
      else if (part.type === "image" && part.source) content.push(imagePart(part));
    }
  }
  return {
    type: "tool_result",
    tool_use_id: block.tool_use_id!,
    // Native reference blocks are accepted by Messages; this is the only SDK
    // compatibility cast, and exact schema matching above owns their creation.
    content: content as Anthropic.ToolResultBlockParam["content"],
    ...(block.is_error ? { is_error: true } : {}),
  };
}

export function anthropicMessages(
  messages: readonly Message[],
  promptCache: PromptCacheRequestContext | undefined,
  policy: PromptCachePolicy,
  tools: readonly ToolDefinition[] = [],
): Anthropic.MessageParam[] {
  const deferred = new Map(
    tools
      .filter((tool) => policy.toolDiscovery === "tool-reference" && tool.deferLoading)
      .map((tool) => [tool.name, tool]),
  );
  const result: Anthropic.MessageParam[] = [];
  const stablePrefixMessageCount = Math.max(
    0,
    Math.min(messages.length, promptCache?.stablePrefixMessageCount ?? messages.length),
  );
  let stablePrefixEndMessage: Anthropic.MessageParam | undefined;
  for (const [sourceIndex, message] of messages.entries()) {
    if (sourceIndex === stablePrefixMessageCount)
      stablePrefixEndMessage = result[result.length - 1];
    if (message.role === "system") continue;
    const role = message.role === "tool" ? "user" : message.role;
    if (typeof message.content === "string") {
      result.push({ role, content: message.content });
      continue;
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
      else if (block.type === "tool_use" && block.id && block.name && block.input)
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      else if (block.type === "tool_result" && block.tool_use_id)
        blocks.push(toolResult(block, deferred));
      else if (block.type === "image" && block.source) blocks.push(imagePart(block));
    }
    if (blocks.length) result.push({ role, content: blocks });
  }
  stablePrefixEndMessage ??= result[result.length - 1];
  const stablePrefixEndIndex = stablePrefixEndMessage
    ? result.indexOf(stablePrefixEndMessage)
    : undefined;
  for (const index of uniquePromptCacheBreakpointIndexes([
    policy.breakpoints.includes("stable-history") ? stablePrefixEndIndex : undefined,
    policy.breakpoints.includes("rolling-history") ? result.length - 1 : undefined,
  ]))
    markBreakpoint(result[index]);
  return result;
}

function markBreakpoint(message: Anthropic.MessageParam | undefined): void {
  if (!message) return;
  if (typeof message.content === "string") {
    message.content = [
      { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
    ];
    return;
  }
  for (let index = message.content.length - 1; index >= 0; index--) {
    const block = message.content[index]!;
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;
    block.cache_control = { type: "ephemeral" };
    return;
  }
}
