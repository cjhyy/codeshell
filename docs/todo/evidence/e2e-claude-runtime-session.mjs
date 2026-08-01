/**
 * The whole thing, end to end: **Claude Code driving a CodeShell session.**
 *
 * Every earlier probe drove Codex with `codex exec` and only proved the reverse
 * tool channel. This one uses the product `ClaudeCodeRuntime`: CodeShell spawns the
 * CLI, drives the turn, receives `StreamEvent`s,
 * and the model reaches a CodeShell tool through the loopback bridge mid-turn.
 *
 * That is the difference between "Codex can call our tools" and "Claude Code is usable
 * as an Agent Runtime".
 *
 * Real: ClaudeCodeRuntime → real `claude -p --output-format stream-json` → real
 * StreamEvent translation, and simultaneously the model → real MCP bridge → real
 * SessionToolHost → real ToolExecutor → real Panel builtin. The only stand-in is
 * the Desktop renderer (no Electron window in a CLI run).
 *
 * Usage: node docs/todo/evidence/e2e-claude-runtime-session.mjs
 * Requires: claude CLI logged in; core and coding built.
 */
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
const { startLoopbackMcpBridge, SessionContextStore, ClaudeCodeRuntime } = await import(
  require.resolve("../../../packages/coding/dist/external-runtimes/index.js")
);

const BUSINESS_SESSION = "business-claude-runtime-e2e";
const PINNED = "claude-runtime-session";

const panelCalls = [];
const panels = {
  list: async () => {
    panelCalls.push("list");
    return {
      items: [
        { id: "quickChat", title: "Quick chat", source: "builtin-panel-app" },
        { id: "panel-app:design-studio", title: "Design Studio", source: "panel-app" },
      ],
    };
  },
  open: async (panelId) => {
    panelCalls.push(`open:${panelId}`);
    return { ok: true, panelId };
  },
  tools: async (panelId) => {
    panelCalls.push(`tools:${panelId}`);
    return { items: [] };
  },
  invoke: async (panelId, toolName) => {
    panelCalls.push(`INVOKE-REACHED:${panelId}:${toolName}`);
    return { ok: true, panelId, toolName, result: { reached: true } };
  },
};

const host = createSessionToolHost({
  businessSessionId: BUSINESS_SESSION,
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
    sessionId: BUSINESS_SESSION,
  },
  approvalBackend: { requestApproval: async () => ({ approved: true }) },
  contextOverrides: { panels },
});

const bridgeLog = [];
const store = new SessionContextStore();
const bridge = await startLoopbackMcpBridge({
  store,
  singleSessionThreadId: PINNED,
  log: (event, data) => bridgeLog.push({ event, ...data }),
});
store.register(PINNED, host);
console.log("bridge:", bridge.url);

// ── the runtime under test ────────────────────────────────────────────────
const events = [];
const runtimeLog = [];
const runtime = new ClaudeCodeRuntime(
  {
    cwd: process.cwd(),
    businessSessionId: BUSINESS_SESSION,
    bridge,
    exposedToolNames: host.listTools().map((definition) => definition.name),
    // Non-interactive run: Claude's own permission layer is bypassed, which is
    // exactly the §12.1.1 point — CodeShell's ToolExecutor still authorizes every
    // Host Tool call regardless of what the runtime decides for its own tools.
    extraArgs: ["--dangerously-skip-permissions"],
    log: (event, data) => runtimeLog.push({ event, ...data }),
  },
  {
    onEvent: (event) => {
      events.push(event);
      if (event.type === "text_delta") process.stdout.write(event.text);
    },
  },
);

const PROMPT =
  'Call the Panel tool from codeshell_tools with {"action":"list"} and tell me ' +
  "the panel ids it returns. Use the MCP tool, not a shell command.";

console.log("\n--- turn output ---");
const turn = await runtime.send(PROMPT);
const timeout = setTimeout(() => {
  console.log("\n[timeout — interrupting]");
  void runtime.interrupt().catch(() => {});
}, 180_000);
await turn.done;
clearTimeout(timeout);

console.log("\n\n================ STREAM EVENTS ================");
const counts = {};
for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
console.log(" ", JSON.stringify(counts));
for (const e of events) {
  if (e.type === "tool_use_start") console.log("   tool_use_start:", e.toolCall.toolName);
  if (e.type === "tool_result") console.log("   tool_result:", e.result.toolName);
}

console.log("\n================ RUNTIME LOG ================");
for (const entry of runtimeLog) console.log(" ", JSON.stringify(entry));

console.log("\n================ BRIDGE LOG ================");
for (const entry of bridgeLog) console.log(" ", JSON.stringify(entry));

console.log("\n================ PANEL BRIDGE CALLS ================");
console.log(" ", panelCalls.length ? panelCalls.join("\n  ") : "(none)");

const toolCalls = bridgeLog.filter((entry) => entry.event === "bridge.call");
const sawText = events.some((event) => event.type === "text_delta");
const terminal = events.filter((event) => event.type === "turn_complete");

console.log("\n================ VERDICT ================");
console.log("runtime learned a session id:  ", Boolean(runtime.runtimeSessionId));
console.log("turn produced text_delta:      ", sawText);
console.log("exactly one turn_complete:     ", terminal.length === 1);
console.log("terminal reason:               ", terminal[0]?.reason);
console.log("model called a CodeShell tool: ", toolCalls.length > 0);
console.log("panel bridge reached:          ", panelCalls.includes("list"));
console.log("token in logs (must be false): ", JSON.stringify(bridgeLog).includes(bridge.token));

await runtime.close();
await bridge.close();

const ok =
  Boolean(runtime.runtimeSessionId) &&
  terminal.length === 1 &&
  toolCalls.length > 0 &&
  panelCalls.includes("list");
process.exit(ok ? 0 : 1);
