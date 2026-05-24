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

import { pathToFileURL } from "node:url";
import { Engine, type EngineConfig } from "../engine/engine.js";
import { AgentServer } from "../protocol/server.js";
import { StdioTransport } from "../protocol/transport.js";
import { SettingsManager } from "../settings/manager.js";
import type { LLMConfig, PermissionMode } from "../types.js";

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

  // Track whether a run has completed at least once. The agent server
  // notifies Status:"ready" both at startup (in its constructor) and at
  // the end of each handleRun() in a `finally` block. We exit cleanly
  // after the second "ready" — i.e. one run completed.
  //
  // Implementation: wrap `transport.send` to peek at outgoing
  // notifications. On the post-run "ready" we close + exit.
  const originalSend = transport.send.bind(transport);
  let runHasStarted = false;
  let shuttingDown = false;
  transport.send = (msg) => {
    originalSend(msg);
    if (shuttingDown) return;
    if ("method" in msg && msg.method === "agent/status") {
      const status = (msg.params as { status?: string })?.status;
      if (status === "running") runHasStarted = true;
      else if (status === "ready" && runHasStarted) {
        shuttingDown = true;
        // Let the response flush, then bail.
        setImmediate(() => {
          server.close();
          process.exit(0);
        });
      }
    }
  };

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
  return { llm, permissionMode: resolvePermissionMode(settings) };
}

function resolvePermissionMode(settings: Record<string, unknown>): PermissionMode {
  const permissions = settings.permissions && typeof settings.permissions === "object"
    ? (settings.permissions as Record<string, unknown>)
    : {};
  const raw = settings.permissionMode ?? permissions.defaultMode;
  switch (raw) {
    case "plan":
    case "default":
    case "acceptEdits":
    case "dontAsk":
    case "bypassPermissions":
    case "auto":
      return raw;
    case "accept_edits":
      return "acceptEdits";
    case "bypass":
      return "bypassPermissions";
    default:
      return "default";
  }
}

// Direct-execute entry: `node dist/cli/agent-server-stdio.js`.
// Use pathToFileURL so paths with non-ASCII characters (e.g. CJK
// install dirs) URL-encode the same way import.meta.url does — naive
// `file://${argv[1]}` string-templating misses that and the guard
// never fires.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = buildEngineConfigFromSettings();
  runAgentServerStdio(config).catch((err) => {
    process.stderr.write(`agent-server-stdio fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
