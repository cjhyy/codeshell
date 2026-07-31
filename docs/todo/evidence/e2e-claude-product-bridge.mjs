/**
 * End-to-end: real Claude Code → the SAME product MCP bridge → real
 * SessionToolHost → real ToolExecutor → real Panel builtin.
 *
 * The design (§10.2) assumed Claude Code would need an in-process MCP server via
 * `@anthropic-ai/claude-agent-sdk`, i.e. a second transport and a new dependency.
 * It does not: `claude --mcp-config <inline json>` accepts an HTTP MCP server
 * with an `Authorization` header, so BOTH runtimes share one loopback bridge and
 * one code path. This script is what establishes that.
 *
 * Real: Claude Code process → product MCP bridge → product thread store → real
 * SessionToolHost → real ToolExecutor → real Panel builtin. The only stand-in is
 * the Desktop renderer (no Electron window in a CLI run).
 *
 * Usage: node docs/todo/evidence/e2e-claude-product-bridge.mjs
 * Requires: claude CLI logged in; core and coding built.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSessionToolHost, FIRST_PHASE_EXPOSURE } = await import(
  require.resolve("../../../packages/core/dist/index.extension.js")
);
const { ToolRegistry } = await import(
  require.resolve("../../../packages/core/dist/tool-system/registry.js")
);
const { BUILTIN_AGENT_PRESETS } = await import(
  require.resolve("../../../packages/core/dist/preset/index.js")
);
const { startLoopbackMcpBridge, SessionContextStore, buildRuntimeSpawnEnv, claudeBridgeArgs } =
  await import(require.resolve("../../../packages/coding/dist/external-runtimes/index.js"));

const panelBridgeCalls = [];
const panels = {
  list: async () => {
    panelBridgeCalls.push("list");
    return {
      items: [
        { id: "quickChat", title: "Quick chat", source: "builtin-panel-app" },
        { id: "panel-app:design-studio", title: "Design Studio", source: "panel-app" },
      ],
    };
  },
  open: async (panelId) => {
    panelBridgeCalls.push(`open:${panelId}`);
    return { ok: true, panelId };
  },
  tools: async (panelId) => {
    panelBridgeCalls.push(`tools:${panelId}`);
    return {
      items: [
        {
          name: "get_design_context",
          description: "Read the current design context.",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
        },
      ],
    };
  },
  invoke: async (panelId, toolName) => {
    panelBridgeCalls.push(`INVOKE-REACHED:${panelId}:${toolName}`);
    return { ok: true, panelId, toolName, result: { reached: true } };
  },
};

const approvalsAsked = [];
const host = createSessionToolHost({
  businessSessionId: "business-claude-e2e",
  cwd: process.cwd(),
  registry: new ToolRegistry({ builtinTools: ["Panel"] }),
  permissionMode: "default",
  presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
  projectTrusted: true,
  planMode: false,
  exposure: FIRST_PHASE_EXPOSURE,
  visibility: {
    cwd: process.cwd(),
    hasGoal: false,
    host: "desktop",
    isSubAgent: false,
    sessionId: "business-claude-e2e",
  },
  approvalBackend: {
    requestApproval: async (request) => {
      approvalsAsked.push(request.toolName);
      return { approved: true };
    },
  },
  contextOverrides: { panels },
});

const logs = [];
const store = new SessionContextStore();
const CLAUDE_THREAD = "claude-single-session";
const bridge = await startLoopbackMcpBridge({
  store,
  // Claude Code sends no per-call thread identity, so the PORT is the binding:
  // one bridge, one session. Nothing is inferred — see McpBridgeOptions.
  singleSessionThreadId: CLAUDE_THREAD,
  log: (event, data) => logs.push({ event, ...data }),
});
console.log("product bridge:", bridge.url);

store.register(CLAUDE_THREAD, host);

// The PRODUCT helper: 0600 config file (token out of argv), --strict-mcp-config
// (the bridge is the only tool channel), and validated --allowed-tools names.
const wiring = claudeBridgeArgs({
  bridge,
  exposedToolNames: host.listTools().map((definition) => definition.name),
});

const PROMPT = `Use the codeshell_tools MCP server's Panel tool. Do these three steps in order and report each raw result verbatim, including any error text:
1. Panel with {"action":"list"}
2. Panel with {"action":"tools","panel_id":"panel-app:design-studio"}
3. Panel with {"action":"invoke","panel_id":"panel-app:design-studio","tool_name":"get_design_context","arguments":{}}
If a step fails, say so and continue to the next one.`;

const child = spawn(
  "claude",
  [
    "-p",
    "--dangerously-skip-permissions",
    ...wiring.args,
  ],
  {
    env: buildRuntimeSpawnEnv({ bridgeToken: { name: bridge.tokenEnvVar, value: bridge.token } }),
    // The prompt goes on stdin: `--mcp-config` is variadic, so a positional
    // prompt after it is swallowed as another config value.
    stdio: ["pipe", "pipe", "pipe"],
  },
);
child.stdin.end(PROMPT);

let out = "";
child.stdout.on("data", (c) => (out += c.toString()));
child.stderr.on("data", (c) => (out += c.toString()));

await new Promise((resolve) => {
  child.on("close", resolve);
  setTimeout(() => child.kill("SIGTERM"), 220_000);
});

console.log("\n--- claude output (tail) ---");
console.log(out.slice(-1800));

console.log("\n================ BRIDGE LOG ================");
for (const entry of logs) console.log(" ", JSON.stringify(entry));

console.log("\n================ PANEL BRIDGE CALLS ================");
console.log(" ", panelBridgeCalls.length ? panelBridgeCalls.join("\n  ") : "(none)");

const executed = logs.filter((l) => l.event === "bridge.call");
const invokeLeaked = panelBridgeCalls.some((c) => c.startsWith("INVOKE-REACHED"));
const tokenLeaked = JSON.stringify(logs).includes(bridge.token);

console.log("\n================ VERDICT ================");
console.log("host executions via bridge:   ", executed.length);
console.log("panel bridge saw list:        ", panelBridgeCalls.includes("list"));
console.log(
  "panel bridge saw tools:       ",
  panelBridgeCalls.some((c) => c.startsWith("tools:")),
);
console.log(
  "invoke refused by policy:     ",
  executed.some((l) => l.resultStatus === "error"),
);
console.log("invoke LEAKED (must be false):", invokeLeaked);
console.log("approvals asked (expect 0):   ", approvalsAsked.length);
console.log("token in logs (must be false):", tokenLeaked);
console.log("token in argv (must be false): ", wiring.args.join(" ").includes(bridge.token));
console.log("--strict-mcp-config passed:   ", wiring.args.includes("--strict-mcp-config"));

wiring.cleanup();
await bridge.close();
process.exit(invokeLeaked || tokenLeaked ? 1 : 0);
