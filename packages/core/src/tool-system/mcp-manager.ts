/**
 * MCP Server Manager — connects to external MCP servers and registers their tools.
 *
 * Supports stdio and streamable-http transports.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MCPServerConfig, RegisteredTool } from "../types.js";
import { ToolRegistry } from "./registry.js";
import { logger } from "../logging/logger.js";

interface MCPConnection {
  client: Client;
  serverName: string;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
}

export class MCPManager {
  private static instance: MCPManager | null = null;
  private connections = new Map<string, MCPConnection>();

  constructor(private readonly toolRegistry: ToolRegistry) {
    MCPManager.instance = this;
  }

  static getInstance(): MCPManager {
    if (!MCPManager.instance) {
      throw new Error("MCPManager not initialized. Connect to servers first.");
    }
    return MCPManager.instance;
  }

  /**
   * Connect to all configured MCP servers and register their tools.
   */
  async connectAll(servers: Record<string, MCPServerConfig>): Promise<void> {
    const entries = Object.entries(servers);
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connect(name, config)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        logger.warn("mcp.connect_failed", {
          server: entries[i][0],
          error: (result.reason as Error).message,
        });
      }
    }
  }

  /**
   * Connect to a single MCP server.
   */
  async connect(name: string, config: MCPServerConfig): Promise<void> {
    if (this.connections.has(name)) {
      logger.info("mcp.already_connected", { server: name });
      return;
    }

    logger.info("mcp.connecting", { server: name, transport: config.transport ?? "stdio" });

    const client = new Client(
      { name: "code-shell", version: "0.1.0" },
      { capabilities: {} },
    );

    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    const transportType = config.transport ?? "stdio";

    if (transportType === "stdio") {
      if (!config.command) {
        throw new Error(`MCP server "${name}": command is required for stdio transport`);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
      });
    } else if (transportType === "streamable-http" || transportType === "sse") {
      if (!config.url) {
        throw new Error(`MCP server "${name}": url is required for ${transportType} transport`);
      }
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    } else {
      throw new Error(`MCP server "${name}": unsupported transport "${transportType}"`);
    }

    // Prevent a misbehaving MCP server from hanging `connectAll()` forever.
    // On timeout, best-effort close the transport so we don't leak the stdio
    // child / socket when connect() is still pending in the background.
    const CONNECT_TIMEOUT_MS = 15_000;
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`MCP server "${name}" connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
        }, CONNECT_TIMEOUT_MS);
        client.connect(transport).then(
          () => resolve(),
          (err) => reject(err),
        );
      });
    } catch (err) {
      try {
        await transport.close?.();
      } catch {
        // ignore cleanup errors
      }
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    this.connections.set(name, { client, serverName: name, transport });

    // Discover and register tools
    await this.discoverTools(name, client);

    logger.info("mcp.connected", { server: name });
  }

  /**
   * Discover tools from an MCP server and register them.
   */
  private async discoverTools(serverName: string, client: Client): Promise<void> {
    const result = await client.listTools();

    for (const tool of result.tools) {
      const registered: RegisteredTool = {
        name: `mcp_${serverName}_${tool.name}`,
        description: `[${serverName}] ${tool.description ?? tool.name}`,
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        source: "mcp",
        serverName,
        permissionDefault: "ask",
        isConcurrencySafe: true,
        isReadOnly: false,
      };

      // Register with an executor that calls the MCP server
      this.toolRegistry.registerTool(registered, async (args: Record<string, unknown>) => {
        const callResult = await client.callTool({ name: tool.name, arguments: args });

        // Extract text from content array
        const parts: string[] = [];
        if (Array.isArray(callResult.content)) {
          for (const item of callResult.content) {
            if (typeof item === "object" && item !== null && "text" in item) {
              parts.push(String(item.text));
            } else if (typeof item === "string") {
              parts.push(item);
            }
          }
        }
        return parts.join("\n") || "(no output)";
      });

      logger.info("mcp.tool_registered", { server: serverName, tool: registered.name });
    }
  }

  /**
   * Disconnect all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        await conn.client.close();
        logger.info("mcp.disconnected", { server: name });
      } catch (err) {
        logger.warn("mcp.disconnect_error", { server: name, error: (err as Error).message });
      }
    }
    this.connections.clear();
  }

  /**
   * List connected servers.
   */
  listServers(): string[] {
    return [...this.connections.keys()];
  }

  /**
   * Call a tool on a specific MCP server.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server "${serverName}" is not connected.`);
    }
    const result = await conn.client.callTool({ name: toolName, arguments: args });
    const parts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const item of result.content) {
        if (typeof item === "object" && item !== null && "text" in item) {
          parts.push(String(item.text));
        } else if (typeof item === "string") {
          parts.push(item);
        }
      }
    }
    return parts.join("\n") || "(no output)";
  }

  /**
   * List resources from MCP servers.
   */
  async listResources(serverName?: string): Promise<Array<{ uri: string; name: string; description?: string }>> {
    const results: Array<{ uri: string; name: string; description?: string }> = [];
    const servers = serverName ? [serverName] : [...this.connections.keys()];

    for (const name of servers) {
      const conn = this.connections.get(name);
      if (!conn) continue;
      try {
        const res = await conn.client.listResources();
        for (const r of res.resources) {
          results.push({
            uri: r.uri,
            name: r.name ?? r.uri,
            description: r.description,
          });
        }
      } catch {
        // Server may not support resources
      }
    }
    return results;
  }

  /**
   * Read a resource from an MCP server.
   */
  async readResource(serverName: string, uri: string): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server "${serverName}" is not connected.`);
    }
    const result = await conn.client.readResource({ uri });
    const parts: string[] = [];
    if (Array.isArray(result.contents)) {
      for (const item of result.contents) {
        if (typeof item === "object" && item !== null && "text" in item) {
          parts.push(String(item.text));
        }
      }
    }
    return parts.join("\n") || "(no content)";
  }
}
