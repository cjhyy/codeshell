/**
 * Headless agent server over stdio (newline-delimited JSON-RPC).
 *
 * Spawned as a Node subprocess by hosts that want to embed code-shell's
 * Engine without linking against the engine in-process. Reads RPC
 * messages from stdin, writes responses + stream notifications to
 * stdout. All log/console output goes to stderr so stdout stays a clean
 * JSON-RPC channel.
 *
 * Hosts:
 *   - packages/desktop (Electron main spawns this)
 *   - third-party IDE/CLI integrators in the future
 */

import { Engine, type EngineConfig } from "../engine/engine.js";
import { AgentServer } from "../protocol/server.js";
import { StdioTransport } from "../protocol/transport.js";
import { SettingsManager } from "../settings/manager.js";
import type { LLMConfig } from "../types.js";

/**
 * Run the agent server on this process's stdin/stdout. Resolves when
 * stdin closes (parent disconnected) or on SIGTERM/SIGINT.
 */
export async function runAgentServerStdio(config: EngineConfig): Promise<void> {
  // Redirect console.* to stderr so stray plugin/permission warnings
  // can't corrupt the JSON-RPC stdout stream. Engine's own logger
  // already writes to ~/.code-shell/logs/, not stdout.
  console.log = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");
  console.info = console.log;
  console.warn = console.log;
  console.error = console.log;

  const engine = new Engine(config);
  const transport = new StdioTransport(process.stdin, process.stdout);
  // Constructor wires transport.onMessage and sends a "ready" status
  // notification. There is no separate start() — see protocol/server.ts.
  const server = new AgentServer({ engine, transport });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close();
      resolve();
    };
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}

/**
 * Build a minimal EngineConfig from ~/.code-shell/settings.json.
 * Mirrors the field mapping that packages/tui/src/cli/main.ts uses
 * for its REPL launch (settings.model.{provider, name, apiKey, baseUrl}).
 */
export function buildEngineConfigFromSettings(): EngineConfig {
  const settings = new SettingsManager(process.cwd()).get();
  const llm: LLMConfig = {
    provider: settings.model.provider ?? "openai",
    model: settings.model.name ?? "anthropic/claude-opus-4-6",
    apiKey: settings.model.apiKey,
    baseUrl: settings.model.baseUrl ?? "https://openrouter.ai/api/v1",
    enableStreaming: true,
  };
  if (!llm.apiKey) {
    throw new Error(
      "agent-server-stdio: no API key in settings.json. Run `code-shell` once " +
        "in a terminal to configure, or set settings.model.apiKey directly.",
    );
  }
  return { llm, permissionMode: "default" };
}

// Direct-execute entry: `node dist/cli/agent-server-stdio.js`.
// Detect "I'm the main module" the ESM-safe way.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = buildEngineConfigFromSettings();
  runAgentServerStdio(config).catch((err) => {
    process.stderr.write(`agent-server-stdio fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
