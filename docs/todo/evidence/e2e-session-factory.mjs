/**
 * The product entry point, exercised with REAL binaries — both runtimes.
 *
 * Earlier probes assembled the pieces by hand. This one calls
 * `startExternalRuntimeSession()`, the composition root a Desktop host would call,
 * and does it for Codex and Claude Code in one run so the two paths are compared
 * under identical inputs.
 *
 * Usage: node docs/todo/evidence/e2e-session-factory.mjs
 * Requires: codex AND claude CLIs logged in; core and coding built.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ToolRegistry } = await import(
  require.resolve("../../../packages/core/dist/tool-system/registry.js")
);
const { BUILTIN_AGENT_PRESETS } = await import(
  require.resolve("../../../packages/core/dist/preset/index.js")
);
const { startExternalRuntimeSession } = await import(
  require.resolve("../../../packages/coding/dist/external-runtimes/index.js")
);

const PROMPT =
  'Call the Panel tool from codeshell_tools with {"action":"list"} and list the ' +
  "panel ids it returns. Use the MCP tool, not a shell command.";

async function run(kind) {
  const panelCalls = [];
  const events = [];
  const session = await startExternalRuntimeSession({
    kind,
    cwd: process.cwd(),
    businessSessionId: `business-factory-${kind}`,
    registry: new ToolRegistry({ builtinTools: ["Panel"] }),
    permissionMode: "default",
    presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
    projectTrusted: true,
    planMode: false,
    visibility: {
      cwd: process.cwd(),
      hasGoal: false,
      host: "desktop",
      isSubAgent: false,
      sessionId: `business-factory-${kind}`,
    },
    approvalBackend: { requestApproval: async () => ({ approved: true }) },
    contextOverrides: {
      panels: {
        list: async () => {
          panelCalls.push("list");
          return {
            items: [
              { id: "quickChat", title: "Quick chat", source: "builtin-panel-app" },
              { id: "panel-app:design-studio", title: "Design Studio", source: "panel-app" },
            ],
          };
        },
        open: async (panelId) => ({ ok: true, panelId }),
        tools: async () => ({ items: [] }),
        invoke: async (panelId, toolName) => {
          panelCalls.push(`INVOKE-REACHED:${panelId}:${toolName}`);
          return { ok: true, panelId, toolName, result: null };
        },
      },
    },
    // Non-interactive: each runtime's OWN permission layer is bypassed, which is
    // the §12.1.1 point — CodeShell's ToolExecutor still authorizes every Host
    // Tool call regardless of what the runtime decides for its own tools.
    ...(kind === "codex"
      ? { sandbox: "read-only", approvalPolicy: "never" }
      : { claudeExtraArgs: ["--dangerously-skip-permissions"] }),
    hooks: { onEvent: (event) => events.push(event) },
  });

  console.log(`\n### ${kind} ###`);
  console.log(
    "exposed tools:",
    session
      .listTools()
      .map((tool) => tool.name)
      .join(", "),
  );

  const turn = await session.send(PROMPT);
  await turn.done;

  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  const terminal = events.filter((event) => event.type === "turn_complete");

  const verdict = {
    runtimeSessionId: Boolean(session.runtimeSessionId),
    sawText: events.some((event) => event.type === "text_delta"),
    exactlyOneTerminal: terminal.length === 1,
    terminalReason: terminal[0]?.reason,
    reachedPanelBridge: panelCalls.includes("list"),
    invokeLeaked: panelCalls.some((call) => call.startsWith("INVOKE-REACHED")),
  };
  console.log("events:", JSON.stringify(counts));
  console.log("verdict:", JSON.stringify(verdict, null, 2));

  await session.close();
  return verdict;
}

const codex = await run("codex");
const claude = await run("claude-code");

console.log("\n================ SUMMARY ================");
for (const [kind, verdict] of [
  ["codex", codex],
  ["claude-code", claude],
]) {
  const ok = verdict.exactlyOneTerminal && verdict.reachedPanelBridge && !verdict.invokeLeaked;
  console.log(`${kind.padEnd(12)} ${ok ? "PASS" : "FAIL"}  ${JSON.stringify(verdict)}`);
}

const allOk = [codex, claude].every(
  (verdict) => verdict.exactlyOneTerminal && verdict.reachedPanelBridge && !verdict.invokeLeaked,
);
process.exit(allOk ? 0 : 1);
