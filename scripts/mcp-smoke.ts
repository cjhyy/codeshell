/**
 * MCP smoke: connect to @modelcontextprotocol/server-everything via the
 * real MCPManager, dump every discovered tool's permissionDefault /
 * isConcurrencySafe / isReadOnly so we can eyeball B1.x's readOnlyHint
 * branch on a real server.
 *
 * Run: bun run scripts/mcp-smoke.ts
 */
import { MCPManager } from "../packages/core/src/tool-system/mcp-manager.js";
import { ToolRegistry } from "../packages/core/src/tool-system/registry.js";

async function main() {
  const registry = new ToolRegistry();
  const manager = new MCPManager(registry);

  console.log("Connecting to @modelcontextprotocol/server-everything …");
  console.log("Connecting to local mock (covers readOnlyHint=true branch) …");
  await manager.connectAll({
    everything: {
      name: "everything",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    },
    "smoke-mock": {
      name: "smoke-mock",
      transport: "stdio",
      command: "bun",
      args: ["run", "scripts/mcp-mock-server.ts"],
    },
  });

  const tools = registry
    .listToolsDetailed()
    .filter((t) => t.source === "mcp");

  console.log(`\nRegistered ${tools.length} MCP tools.\n`);
  console.log(
    "name".padEnd(48) +
      "perm".padEnd(7) +
      "concurrencySafe".padEnd(18) +
      "readOnly",
  );
  console.log("-".repeat(85));
  for (const t of tools) {
    console.log(
      t.name.padEnd(48) +
        String(t.permissionDefault).padEnd(7) +
        String(t.isConcurrencySafe).padEnd(18) +
        String(t.isReadOnly),
    );
  }

  const safe = tools.filter((t) => t.isConcurrencySafe).length;
  const unsafe = tools.length - safe;
  console.log(
    `\nSummary: ${safe} concurrency-safe (readOnlyHint=true) / ${unsafe} unsafe (default).`,
  );

  await manager.disconnectAll();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("MCP smoke failed:", err);
    process.exit(1);
  });
