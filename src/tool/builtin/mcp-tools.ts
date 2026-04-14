/**
 * MCP (Model Context Protocol) tools — list, read, and auth for MCP resources.
 */

import type { ToolDefinition } from "../../types.js";

// ─── MCPTool — invoke an MCP tool on a connected server ─────────

export const mcpToolDef: ToolDefinition = {
  name: "MCPTool",
  description:
    "Call a tool provided by a connected MCP server. The tool name should include the server prefix.",
  inputSchema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "The MCP server name to call the tool on",
      },
      tool: {
        type: "string",
        description: "The tool name to invoke",
      },
      arguments: {
        type: "object",
        description: "Arguments to pass to the tool",
      },
    },
    required: ["server", "tool"],
  },
};

export async function mcpToolExecute(args: Record<string, unknown>): Promise<string> {
  const server = args.server as string;
  const tool = args.tool as string;
  const toolArgs = (args.arguments as Record<string, unknown>) ?? {};

  try {
    const { MCPManager } = await import("../mcp-manager.js");
    const manager = MCPManager.getInstance();
    const result = await manager.callTool(server, tool, toolArgs);
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    return `MCP tool error: ${(err as Error).message}`;
  }
}

// ─── ListMcpResources — list available MCP resources ────────────

export const listMcpResourcesToolDef: ToolDefinition = {
  name: "ListMcpResources",
  description: "List available resources from connected MCP servers.",
  inputSchema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "Optional: filter by MCP server name. If omitted, lists all.",
      },
    },
  },
};

export async function listMcpResourcesTool(args: Record<string, unknown>): Promise<string> {
  const server = (args.server as string) ?? "";

  try {
    const { MCPManager } = await import("../mcp-manager.js");
    const manager = MCPManager.getInstance();
    const resources = await manager.listResources(server || undefined);

    if (!resources || resources.length === 0) {
      return "No MCP resources available.";
    }

    const lines = resources.map((r: any) => `  ${r.uri ?? r.name} — ${r.description ?? ""}`);
    return `MCP Resources (${resources.length}):\n${lines.join("\n")}`;
  } catch (err) {
    return `Error listing MCP resources: ${(err as Error).message}`;
  }
}

// ─── ReadMcpResource — read a specific MCP resource ─────────────

export const readMcpResourceToolDef: ToolDefinition = {
  name: "ReadMcpResource",
  description: "Read the content of an MCP resource by its URI.",
  inputSchema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "The MCP server name providing the resource",
      },
      uri: {
        type: "string",
        description: "The URI of the resource to read",
      },
    },
    required: ["server", "uri"],
  },
};

export async function readMcpResourceTool(args: Record<string, unknown>): Promise<string> {
  const server = args.server as string;
  const uri = args.uri as string;

  try {
    const { MCPManager } = await import("../mcp-manager.js");
    const manager = MCPManager.getInstance();
    const content = await manager.readResource(server, uri);
    return typeof content === "string" ? content : JSON.stringify(content, null, 2);
  } catch (err) {
    return `Error reading MCP resource: ${(err as Error).message}`;
  }
}
