/** MCP resource 包装 adapter：MCP 只是 kind 之一，不塞 mcpServers（ADR §1/§4）。 */
import type { ConnectorAdapter } from "../adapter.js";
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

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.trunc(maxBytes)) : 0;
  let end = Math.min(limit, bytes.length);

  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }

  return bytes.subarray(0, end).toString("utf8");
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
      const maxBytes = Number.isFinite(options.maxBytes)
        ? Math.max(0, Math.trunc(options.maxBytes))
        : 0;
      const truncated = Buffer.byteLength(text, "utf8") > maxBytes;

      return {
        resourceId,
        text: truncated ? truncateUtf8(text, maxBytes) : text,
        truncated,
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
