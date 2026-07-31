/**
 * End-to-end against the PRODUCT bridge.
 *
 * `e2e-codex-session-tool-host.mjs` proved the concept with a hand-written MCP
 * server in the probe itself. This one deletes that: the HTTP server, the auth,
 * the SSE framing and the thread routing are all
 * `packages/coding/src/external-runtimes/codex/` — the shipped code. The only
 * stand-in left on the path is the Desktop renderer, replaced by a scripted
 * panel bridge because a CLI run has no Electron window.
 *
 * Real: Codex process → product MCP bridge → product thread store → real
 * SessionToolHost → real ToolExecutor → real Panel builtin.
 *
 * Usage: node docs/todo/evidence/e2e-codex-product-bridge.mjs
 * Requires: codex CLI logged in; core and coding built.
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
// ── the product bridge, not a local reimplementation ──────────────────────
const { startCodexMcpBridge, codexBridgeConfigArgs, CodexThreadContextStore } = await import(
  require.resolve("../../../packages/coding/dist/external-runtimes/codex/index.js")
);

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
function makeHost(businessSessionId) {
  return createSessionToolHost({
    businessSessionId,
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
      sessionId: businessSessionId,
    },
    approvalBackend: {
      requestApproval: async (request) => {
        approvalsAsked.push(request.toolName);
        return { approved: true };
      },
    },
    contextOverrides: { panels },
  });
}

const logs = [];
const store = new CodexThreadContextStore();
const bridge = await startCodexMcpBridge({
  store,
  log: (event, data) => logs.push({ event, ...data }),
});
console.log("product bridge:", bridge.url);

// A real Desktop host registers `threadId -> host` when the thread is created.
// `codex exec` creates its own thread, so learn the id from its header line and
// register before the model gets a chance to call a tool. `tools/list` may land
// first and correctly return [] — that is the fail-closed path, not a bug.
const host = makeHost("business-e2e");
let registered = null;

const PROMPT = `You have a Panel tool from the codeshell_tools MCP server.
Do these three steps in order and report each raw result verbatim, including errors:
1. Panel with {"action":"list"}
2. Panel with {"action":"tools","panel_id":"panel-app:design-studio"}
3. Panel with {"action":"invoke","panel_id":"panel-app:design-studio","tool_name":"get_design_context","arguments":{}}
If a step fails, say so and continue to the next one.`;

const child = spawn(
  "codex",
  [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    ...codexBridgeConfigArgs(bridge),
    PROMPT,
  ],
  {
    env: { ...process.env, [bridge.tokenEnvVar]: bridge.token },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let out = "";
const onChunk = (chunk) => {
  out += chunk.toString();
  const match = /session id:\s*([0-9a-f-]{36})/i.exec(out);
  if (match && registered !== match[1]) {
    registered = match[1];
    store.register(registered, host, store.generation);
    console.log("registered thread →", registered);
  }
};
child.stdout.on("data", onChunk);
child.stderr.on("data", onChunk);

await new Promise((resolve) => {
  child.on("close", resolve);
  setTimeout(() => child.kill("SIGTERM"), 220_000);
});

console.log("\n--- codex output (tail) ---");
console.log(out.slice(-1600));

console.log("\n================ BRIDGE LOG ================");
for (const entry of logs) console.log(" ", JSON.stringify(entry));

console.log("\n================ PANEL BRIDGE CALLS ================");
console.log(" ", panelBridgeCalls.length ? panelBridgeCalls.join("\n  ") : "(none)");

const executed = logs.filter((l) => l.event === "bridge.call");
const invokeLeaked = panelBridgeCalls.some((c) => c.startsWith("INVOKE-REACHED"));
const invokeRefused = executed.some((l) => l.resultStatus === "error");
const tokenLeaked = JSON.stringify(logs).includes(bridge.token);

console.log("\n================ VERDICT ================");
console.log("thread registered:            ", Boolean(registered));
console.log("host executions via bridge:   ", executed.length);
console.log("panel bridge saw list:        ", panelBridgeCalls.includes("list"));
console.log(
  "panel bridge saw tools:       ",
  panelBridgeCalls.some((c) => c.startsWith("tools:")),
);
console.log("invoke refused by policy:     ", invokeRefused);
console.log("invoke LEAKED (must be false):", invokeLeaked);
console.log("approvals asked (expect 0):   ", approvalsAsked.length);
console.log("token in logs (must be false):", tokenLeaked);

await bridge.close();
process.exit(invokeLeaked || tokenLeaked ? 1 : 0);
