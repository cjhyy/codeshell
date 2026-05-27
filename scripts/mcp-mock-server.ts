/**
 * Minimal stdio MCP server fixture for the smoke test. Exposes two tools:
 *
 *   - search_files   readOnlyHint: true   → expected concurrencySafe=true
 *   - write_note     readOnlyHint: false  → expected concurrencySafe=false
 *
 * Pure protocol stub — tool calls return a canned string, no side effects.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "smoke-mock", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_files",
      description: "Search for files (read-only).",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      annotations: { readOnlyHint: true, title: "Search files" },
    },
    {
      name: "write_note",
      description: "Write a note (side-effectful).",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      annotations: { readOnlyHint: false, title: "Write note" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `called ${req.params.name}` }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
