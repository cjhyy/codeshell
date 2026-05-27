/**
 * One-shot live smoke for reusable sub-agent roles.
 * Spawns Agent(agent_type="researcher") and observes:
 *   1. the child runs on deepseek-v4-flash (the role's model),
 *   2. the child's tool pool is the allowlist (no Edit/Write/Bash),
 *   3. it returns a result.
 * Requires a configured deepseek-v4-flash key in settings + network.
 */
import { Engine } from "../packages/core/src/engine/engine.js";

const cwd = process.cwd();

const engine = new Engine({
  // Placeholder llm; the ctor resyncs to settings.activeKey from settings.
  llm: { provider: "openai", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com/v1", apiKey: "x" },
  cwd,
  permissionMode: "bypassPermissions",
  headless: true,
  maxTurns: 6,
});

const toolCalls: { agentId?: string; tool: string }[] = [];
const childModels = new Set<string>();
let agentStarted = false;

const result = await engine.run(
  'Use the Agent tool with agent_type="researcher" to answer this: ' +
    'in this repo, what file defines parseAgentDefinition and what does it do? ' +
    "Give the researcher a clear prompt. Report back its finding in one sentence.",
  {
    onStream: (e: Record<string, unknown>) => {
      const type = e.type as string;
      if (type === "agent_start") agentStarted = true;
      if (type === "tool_use" || type === "tool_call") {
        toolCalls.push({ agentId: e.agentId as string | undefined, tool: (e.name ?? e.tool) as string });
      }
      // child usage_update events are filtered from the parent, but model
      // shows up in session_started for the child if it leaks; capture any model field.
      if (e.model) childModels.add(String(e.model));
    },
  },
);

console.log("\n========== SMOKE RESULT ==========");
console.log("agent_start observed:", agentStarted);
console.log("tool calls seen:", JSON.stringify(toolCalls, null, 1));
console.log("models observed in stream:", [...childModels]);
console.log("forbidden tools used (should be empty):", toolCalls.filter((c) => ["Edit", "Write", "Bash"].includes(c.tool)));
console.log("\nfinal text:\n", result.text);
console.log("==================================");
process.exit(0);
