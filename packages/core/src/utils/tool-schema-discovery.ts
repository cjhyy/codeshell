/** Portable tool discovery text shared by discovery and protocol projections. */
import { createHash } from "node:crypto";
import type { ContentBlock, ToolDefinition } from "../types.js";

/** Redundant native usage guidance; providers may omit this exact fixed text beside references. */
export const NATIVE_TOOL_DISCOVERY_USAGE =
  "Call tools loaded through native references by their exact names. " +
  "For schemas shown as text, including late or changed tools, use CallTool: " +
  "name is the exact tool name and args must match inputSchema.";

function schemaJson(tool: ToolDefinition): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}

export function toolDiscoverySchemaText(tool: ToolDefinition): string {
  return `### ${tool.name}\nschemaRef: select:${tool.name}\n${schemaJson(tool)}`;
}

export function toolDiscoverySchemaDigest(tool: ToolDefinition): string {
  return createHash("sha256")
    .update("codeshell-tool-discovery-v1\0")
    .update(schemaJson(tool))
    .digest("hex");
}

export function toolDiscoverySchemaBlock(tool: ToolDefinition): ContentBlock {
  return {
    type: "text",
    text: toolDiscoverySchemaText(tool),
    discoveredTool: { version: 1, name: tool.name, schemaDigest: toolDiscoverySchemaDigest(tool) },
  };
}

export function matchesToolDiscoverySchema(block: ContentBlock, tool: ToolDefinition): boolean {
  return (
    block.type === "text" &&
    block.discoveredTool?.version === 1 &&
    block.discoveredTool.name === tool.name &&
    block.discoveredTool.schemaDigest === toolDiscoverySchemaDigest(tool) &&
    block.text === toolDiscoverySchemaText(tool)
  );
}

/** Discovery results store their separators explicitly; legacy image/text results do not. */
export function joinToolResultText(
  blocks: readonly ContentBlock[],
  legacySeparator: string,
): string {
  const discovery = blocks.some((block) => block.discoveredTool !== undefined);
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join(discovery ? "" : legacySeparator);
}
