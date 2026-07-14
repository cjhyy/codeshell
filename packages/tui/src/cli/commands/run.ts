/**
 * `run` command — headless single-prompt execution.
 *
 * Uses the same Engine → AgentServer → AgentClient pipeline,
 * but with a headless renderer instead of Ink UI.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Engine } from "@cjhyy/code-shell-core";
import { mergePluginMcpServers } from "@cjhyy/code-shell-core";
import { EngineRuntime } from "@cjhyy/code-shell-core";
import { ChatSessionManager } from "@cjhyy/code-shell-core";
import { AgentServer } from "@cjhyy/code-shell-core";
import { AgentClient } from "@cjhyy/code-shell-core";
import { createInProcessTransport } from "@cjhyy/code-shell-core";
import { MCPManager } from "@cjhyy/code-shell-core";
import { CostTracker } from "@cjhyy/code-shell-core";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { personalizationFrom } from "@cjhyy/code-shell-core";
import { resolveLLMConfigForTag } from "@cjhyy/code-shell-core";
import { costTracker } from "@cjhyy/code-shell-core";
import { createRenderer, type OutputFormat } from "../output/renderer.js";
import type { LLMConfig, PermissionMode } from "@cjhyy/code-shell-core";
import type { AgentPresetName } from "@cjhyy/code-shell-core";
import { defaultSandboxConfig, type SandboxConfig } from "@cjhyy/code-shell-core";
import {
  asyncAgentRegistry,
  buildNotificationMessage,
  buildNotificationSummary,
} from "@cjhyy/code-shell-core";
import { drainBackgroundNotifications } from "./drain-notifications.js";
import { resolveMaxContextTokens } from "./max-context-tokens.js";

export interface RunOptions {
  task: string;
  model?: string;
  provider?: string;
  preset?: AgentPresetName;
  baseUrl?: string;
  output?: OutputFormat;
  permissionMode?: string;
  resume?: string;
  apiKey?: string;
  maxTurns?: number;
  /** Write the final assistant message to this file (codex `-o`). */
  outputLastMessage?: string;
  /**
   * Wait for in-flight background agents to finish before draining their
   * completion notifications into the output. Default true.
   */
  waitBackgroundAgents?: boolean;
  /** Max ms to wait for background agents (see waitBackgroundAgents). Default 5000. */
  backgroundWaitMs?: number;
}

/**
 * Write the final assistant message to a file (codex `-o`). Best-effort:
 * a write failure is logged but never throws, so it can't change the run's
 * exit code. Exported for testing.
 */
export function writeLastMessage(file: string, text: string): void {
  try {
    writeFileSync(file, text, "utf-8");
  } catch (err) {
    console.error(`Warning: failed to write --output-last-message file: ${(err as Error).message}`);
  }
}

export async function runCommand(options: RunOptions): Promise<void> {
  const cwd = process.cwd();

  // Load settings — host terminal entrypoint reads the full hierarchy.
  const settingsManager = new SettingsManager(cwd, "full");
  const settings = settingsManager.get();

  // Resolve the text model from the unified catalog
  // (modelConnections[]/credentials[]/defaults). The seed Engine re-resolves
  // from the same catalog, so this is the bootstrap config + the pre-Engine
  // bail-out gate.
  const resolved = resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
  if (!resolved && !options.apiKey) {
    console.error(
      "Error: 没有可用的文本模型连接。请在「连接」页添加,或用 --api-key/--model 指定。",
    );
    process.exit(1);
  }
  const llmConfig: LLMConfig = resolved ?? {
    provider: options.provider ?? "openai",
    model: options.model ?? "anthropic/claude-opus-4-6",
    apiKey: options.apiKey!,
    baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
    maxTokens: 8192,
  };
  // CLI flag overrides still apply on top of a resolved connection, so
  // `--model X` / `--provider X` / `--base-url X` work even when a catalog
  // connection resolves.
  if (resolved) {
    if (options.provider) llmConfig.provider = options.provider;
    if (options.model) llmConfig.model = options.model;
    if (options.baseUrl) llmConfig.baseUrl = options.baseUrl;
  }
  // temperature is a ClientDefaults knob now; the seed Engine derives it from
  // the unified catalog and session engines inherit it from the seed's
  // resolved config — no explicit pass needed here.

  const sandboxConfig = mergeSandboxConfig(settings.sandbox, "auto");
  const maxContextTokens = resolveMaxContextTokens(llmConfig, settings.context.maxTokens);

  // ── Shared config passed into every session engine ─────────────
  const sharedCfg = {
    preset: options.preset ?? settings.agent.preset,
    enabledBuiltinTools: settings.agent.enabledBuiltinTools,
    disabledBuiltinTools: settings.agent.disabledBuiltinTools,
    permissionMode: (options.permissionMode ?? "acceptEdits") as PermissionMode,
    customSystemPrompt: settings.agent.customSystemPrompt,
    appendSystemPrompt: settings.agent.appendSystemPrompt,
    // Personalization + instruction compat (shared helper → no per-host drift).
    ...personalizationFrom(settings.agent),
    maxTurns: options.maxTurns ?? 30,
    maxContextTokens,
    sessionStorageDir: settings.session.storageDir,
    costStore: costTracker,
    mcpServers: mergePluginMcpServers(
      settings.mcpServers ?? {},
      (settings as { disabledPlugins?: string[] }).disabledPlugins ?? [],
      settings.mcpServerOverrides ?? {},
    ),
    headless: true,
    sandbox: sandboxConfig,
    // Host terminal entrypoint: read the full disk hierarchy (managed + user
    // ~/.code-shell + project + local). The SDK default is 'project', which
    // would skip the user's personal config — not what a CLI invocation wants.
    settingsScope: "full" as const,
  };

  // 1. Seed engine — populates model pool + tool registry via
  //    populateModelPoolFromSettings() in ctor. Discarded after extraction.
  const seedEngine = new Engine({ llm: llmConfig, cwd, headless: true, settingsScope: "full" });

  // 2. Extract shared resources
  const modelPool = seedEngine.getModelPool();
  const toolRegistry = seedEngine.getRuntimeToolRegistry();
  const resolvedLlmConfig = seedEngine.getConfig().llm;
  // Cross-model knobs (temperature/imageDetail) the seed engine derived from
  // settings — inherited by every session engine so they don't each re-read.
  const resolvedClientDefaults = seedEngine.getConfig().clientDefaults;
  // Reuse the SettingsManager already constructed above (settingsManager).
  // MCPManager: no-op holder for EngineRuntime; per-session engines connect
  // via mcpServers in sharedCfg.
  // TODO(future): aggregate MCP connections at the runtime level.
  const mcpPool = new MCPManager(toolRegistry);
  // CostTracker: fresh instance for this invocation.
  // TODO(future): thread into Engine cost accounting via runtime.costTracker.
  const runCostTracker = new CostTracker();

  // 3. Build the shared EngineRuntime (reuse settingsManager from above)
  const runtime = new EngineRuntime({
    modelPool,
    toolRegistry,
    settings: settingsManager,
    mcpPool,
    costTracker: runCostTracker,
  });

  // 4. ChatSessionManager — one session per `run` invocation (UUID)
  const chatManager = new ChatSessionManager({
    runtime,
    engineFactory: (slice) =>
      new Engine({
        llm: resolvedLlmConfig,
        clientDefaults: resolvedClientDefaults,
        cwd,
        runtime,
        origin: "tui",
        ...sharedCfg,
        // Per-session overrides from the protocol request take precedence
        ...(slice.permissionMode ? { permissionMode: slice.permissionMode } : {}),
        ...(slice.preset ? { preset: slice.preset } : {}),
        ...(slice.customSystemPrompt !== undefined
          ? { customSystemPrompt: slice.customSystemPrompt }
          : {}),
        ...(slice.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: slice.appendSystemPrompt }
          : {}),
        ...(slice.maxTurns !== undefined ? { maxTurns: slice.maxTurns } : {}),
        ...(slice.maxContextTokens !== undefined
          ? { maxContextTokens: slice.maxContextTokens }
          : {}),
        ...(slice.cwd ? { cwd: slice.cwd } : {}),
      }),
    maxSessions: 1, // one-shot run; exactly one session per invocation
    idleTtlMs: 30 * 60 * 1000,
  });
  chatManager.startIdleSweeper();

  // 5. Wire up in-process transport + server + client
  const [serverTransport, clientTransport] = createInProcessTransport();
  const server = new AgentServer({ chatManager, transport: serverTransport });
  const client = new AgentClient({ transport: clientTransport });

  // Unique sessionId per run invocation; use --resume if provided.
  const runSessionId = options.resume ?? `run-${randomUUID()}`;

  const outputFormat = options.output ?? (settings.output.format as OutputFormat) ?? "text";
  const renderer = createRenderer(outputFormat);

  // Wire renderer to stream events from client
  client.onStreamEvent((envelope) => renderer.onEvent(envelope.event));

  let exitCode = 1;
  try {
    const result = await client.run(options.task, runSessionId);

    renderer.onComplete(result.text, result.reason, {
      sessionId: result.sessionId,
      turnCount: result.turnCount,
    });

    // ── Background-agent completions (Phase 1, headless tail) ────────
    // Headless has no idle loop to drain the notification queue, so do it
    // here — BEFORE closing the server/client, or a background agent that
    // finishes late loses its result. Default: wait briefly for in-flight
    // agents; --no-wait-background-agents skips the wait.
    const wait = options.waitBackgroundAgents ?? true;
    const notifications = await drainBackgroundNotifications(runSessionId, {
      wait,
      timeoutMs: options.backgroundWaitMs ?? 5000,
    });
    if (notifications.length > 0) {
      // Human-facing summary on stderr (stdout stays the main result / JSON).
      process.stderr.write("\n" + buildNotificationSummary(notifications) + "\n");
    } else if (wait && asyncAgentRegistry.hasRunning()) {
      // Waited out the timeout with agents still running — say so explicitly
      // rather than exiting as if everything completed.
      process.stderr.write(
        "\n⏱  background agents still running at timeout — their results were not captured.\n",
      );
    }

    // codex `-o`: persist the final assistant message to a file so CI scripts
    // can read it without parsing stdout. Fold in any background results so
    // the file is a complete record. Best-effort — a write failure must not
    // change the run's exit code.
    if (options.outputLastMessage) {
      const body =
        notifications.length > 0
          ? `${result.text ?? ""}\n\n${buildNotificationMessage(notifications)}`
          : (result.text ?? "");
      writeLastMessage(options.outputLastMessage, body);
    }

    exitCode = result.reason === "completed" ? 0 : 1;
  } finally {
    // Tear down in correct order: server first (aborts in-flight run, emits
    // shutdown notification through still-open transport), then client.
    server.close();
    client.close();
  }
  process.exit(exitCode);
}

/**
 * Build the sandbox config Engine sees. Users only need to set the parts
 * they care about; missing fields fall back to defaults that include the
 * sensitive-path deny list. `defaultMode` is the headless-vs-REPL default.
 */
function mergeSandboxConfig(
  user:
    | { mode?: string; writableRoots?: string[]; deniedReads?: string[]; network?: string }
    | undefined,
  defaultMode: SandboxConfig["mode"],
): SandboxConfig {
  const base = defaultSandboxConfig(defaultMode);
  if (!user) return base;
  return {
    mode: (user.mode as SandboxConfig["mode"]) ?? base.mode,
    writableRoots: user.writableRoots ?? base.writableRoots,
    deniedReads: user.deniedReads ?? base.deniedReads,
    network: (user.network as SandboxConfig["network"]) ?? base.network,
  };
}
