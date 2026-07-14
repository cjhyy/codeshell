import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cwd = mkdtempSync(join(tmpdir(), "codeshell-core-harness-"));
const home = mkdtempSync(join(tmpdir(), "codeshell-core-home-"));
const previousHome = process.env.HOME;
process.env.HOME = home;

try {
  const core = await import("@cjhyy/code-shell-core");
  const provider = `core-harness-smoke-${process.pid}`;
  const captured = [];

  class SmokeClient extends core.LLMClientBase {
    initClient() {}

    async createMessage(options) {
      captured.push({
        systemPrompt: options.systemPrompt,
        tools: (options.tools ?? []).map((tool) => tool.name),
      });
      return {
        text: "core harness ok",
        toolCalls: [],
        stopReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }
  }

  core.registerProvider(provider, SmokeClient);

  assert.equal(core.DEFAULT_AGENT_PRESET, "harness-min");
  assert.equal(core.resolveAgentPreset().name, "harness-min");
  assert.equal("terminal-coding" in core.BUILTIN_AGENT_PRESETS, false);

  const engine = new core.Engine({
    llm: { provider, model: "smoke", apiKey: "test" },
    cwd,
    sessionStorageDir: join(cwd, "sessions"),
    settingsScope: "isolated",
    permissionMode: "bypassPermissions",
    headless: true,
    maxTurns: 2,
  });
  engine.getHookRegistry().clear();

  const forbiddenTools = [
    "ApplyPatch",
    "NotebookEdit",
    "LSP",
    "Brief",
    "EnterWorktree",
    "ExitWorktree",
    "SwitchSessionWorkspace",
    "DriveAgent",
    "DriveClaudeCode",
    "CheckQuota",
    "Arena",
    "GenerateImage",
    "GenerateVideo",
    "browser_observe",
  ];
  const registryTools = engine.getToolRegistry().listTools();
  for (const name of forbiddenTools) {
    assert.equal(registryTools.includes(name), false, `core-only registry exposed ${name}`);
  }

  const result = await engine.run("Return a short confirmation.", {
    sessionId: "core-harness-smoke",
  });
  assert.equal(result.text, "core harness ok");
  const call = captured.find((entry) => entry.tools.length > 0) ?? captured.at(-1);
  assert.ok(call, "the core-only Engine must complete one real turn");
  for (const name of forbiddenTools) {
    assert.equal(call.tools.includes(name), false, `core-only turn exposed ${name}`);
  }
  assert.doesNotMatch(call.systemPrompt, /\bgit\b|coding/i);

  const promptSources = [
    "packages/core/src/prompt/composer.ts",
    "packages/core/src/prompt/instruction-scanner.ts",
  ].map((path) => readFileSync(resolve(root, path), "utf8"));
  for (const source of promptSources) {
    assert.doesNotMatch(source, /node:child_process|execSync\s*\(/);
  }

  const runtimeBoundarySources = [
    "packages/core/src/tool-system/context.ts",
    "packages/core/src/engine/run-environment.ts",
    "packages/core/src/engine/engine.ts",
  ].map((path) => readFileSync(resolve(root, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
  for (const source of runtimeBoundarySources) {
    assert.doesNotMatch(source, /readWorktreeSetup|readWorktreeBranch|resolveWorktreeSetup/);
  }

  console.log(`core harness smoke passed (${call.tools.length} tools, non-git cwd)`);
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
