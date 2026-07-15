/** MCP resource 包装 adapter：MCP 只是 kind 之一，不塞 mcpServers（ADR §1/§4）。 */
import type { ConnectorAdapter } from "../adapter.js";
import { truncateUtf8Text } from "../truncate-utf8.js";
import type { SourceDefinition } from "../types.js";

interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  serverName: string;
}

interface McpLike {
  listResources(server?: string, signal?: AbortSignal): Promise<McpResourceInfo[]>;
  readResource(server: string, uri: string, signal?: AbortSignal): Promise<string>;
}

type McpManagerFactory = () => McpLike | Promise<McpLike>;

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

    async listResources(definition, scopeId) {
      if (scopeId !== "resources") return [];

      const resources = await (await getManager()).listResources(serverOf(definition));
      return resources.map((resource) => ({
        id: resource.uri,
        scopeId: "resources",
        name: resource.name ?? resource.uri,
      }));
    },

    async read(definition, resourceId, options) {
      const text = await (
        await getManager()
      ).readResource(serverOf(definition), resourceId, options.signal);
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
  return createMcpResourceAdapter(async () => {
    const { MCPManager } = await import("../../tool-system/mcp-manager.js");
    return MCPManager.getInstance();
  });
}
