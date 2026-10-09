/** MCP resource 包装 adapter：MCP 只是 kind 之一，不塞 mcpServers（ADR §1/§4）。 */
import type { ToolContext } from "../../tool-system/context.js";
import type { ConnectorAdapter, SourceAdapterContext } from "../adapter.js";
import { truncateUtf8Text } from "../truncate-utf8.js";
import type { SourceDefinition } from "../types.js";

interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  serverName: string;
}

interface McpLike {
  listResources(
    server?: string,
    signal?: AbortSignal,
    context?: ToolContext,
  ): Promise<McpResourceInfo[]>;
  readResource(
    server: string,
    uri: string,
    signal?: AbortSignal,
    context?: ToolContext,
  ): Promise<string>;
}

type McpManagerFactory = (context?: SourceAdapterContext) => McpLike | Promise<McpLike>;

function serverOf(definition: SourceDefinition): string {
  const configured = definition.adapterConfig["server"];
  if (typeof configured !== "string" || configured.trim() === "") {
    throw new Error(`mcp-resource source "${definition.id}" requires adapterConfig.server`);
  }
  return configured.trim();
}

export function createMcpResourceAdapter(getManager: McpManagerFactory): ConnectorAdapter {
  return {
    kind: "mcp-resource",

    async listScopes() {
      return [{ id: "resources", label: "Resources" }];
    },

    async listResources(definition, scopeId, context) {
      if (scopeId !== "resources") return [];

      const resources = await (
        await getManager(context)
      ).listResources(serverOf(definition), context?.signal, context?.mcpContext);
      return resources.map((resource) => ({
        id: resource.uri,
        scopeId: "resources",
        name: resource.name ?? resource.uri,
      }));
    },

    async read(definition, resourceId, options) {
      const text = await (
        await getManager(options)
      ).readResource(serverOf(definition), resourceId, options.signal, options.mcpContext);
      const truncated = truncateUtf8Text(text, options.maxBytes);

      return {
        resourceId,
        ...truncated,
      };
    },
  };
}

/** 生产默认：方法首次执行时才加载真 MCPManager，避免静态模块环。 */
export function defaultMcpResourceAdapter(): ConnectorAdapter {
  return createMcpResourceAdapter(async (context) => {
    const ctx = context?.mcpContext;
    if (!ctx?.allowedMcpServers) throw new Error("MCP source requires an owning Run context");
    const { MCPManager } = await import("../../tool-system/mcp-manager.js");
    const manager = MCPManager.forContext(ctx);
    // Reuse the Run's executor allowlist for source-backed MCP access too.
    const assertAllowed = (server: string | undefined) => {
      if (!server || !ctx.allowedMcpServers!.has(server))
        throw new Error(`MCP server "${server}" is not enabled for this Run`);
    };
    return {
      listResources(server, signal) {
        assertAllowed(server);
        return manager.listResources(server, signal, ctx);
      },
      readResource(server, uri, signal) {
        assertAllowed(server);
        return manager.readResource(server, uri, signal, ctx);
      },
    };
  });
}
