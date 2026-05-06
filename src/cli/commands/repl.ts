/**
 * Interactive REPL mode — uses Ink (React for CLI) for the terminal UI.
 *
 * Wiring: Engine → AgentServer → [in-process transport] → AgentClient → UI
 */

import chalk from "chalk";
import { Engine } from "../../engine/engine.js";
import { AgentServer } from "../../protocol/server.js";
import { AgentClient } from "../../protocol/client.js";
import { createInProcessTransport } from "../../protocol/transport.js";
import { SettingsManager } from "../../settings/manager.js";
import { costTracker } from "../cost-tracker.js";
import type { LLMConfig, PermissionMode } from "../../types.js";
import { startInkRepl } from "../../ui/index.js";
import type { AgentPresetName } from "../../preset/index.js";
import { getInteractiveApprovalBackend } from "../../tool-system/permission.js";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface ReplOptions {
  model?: string;
  provider?: string;
  preset?: AgentPresetName;
  baseUrl?: string;
  apiKey?: string;
  permissionMode?: string;
  maxTurns?: number;
  output?: string;
  resume?: string;
  effort?: EffortLevel;
  prefill?: string;
}

function getEffortConfig(level: EffortLevel): { temperature: number; maxTokens: number } {
  switch (level) {
    case "low":
      return { temperature: 0.1, maxTokens: 4096 };
    case "medium":
      return { temperature: 0.3, maxTokens: 8192 };
    case "high":
      return { temperature: 0.5, maxTokens: 16384 };
    case "max":
      return { temperature: 0.7, maxTokens: 32768 };
  }
}

export async function replCommand(options: ReplOptions): Promise<void> {
  const cwd = process.cwd();

  // Load settings
  const settingsManager = new SettingsManager(cwd);
  const settings = settingsManager.get();

  // Resolve API key
  const apiKey =
    options.apiKey ??
    settings.model.apiKey ??
    process.env.OPENROUTER_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error(
      chalk.red(
        "Error: No API key. Use --api-key, set OPENROUTER_API_KEY env var, or add to ~/.code-shell/settings.json",
      ),
    );
    process.exit(1);
  }

  const model = options.model ?? settings.model.name ?? "anthropic/claude-opus-4-6";
  const provider = options.provider ?? settings.model.provider ?? "openai";
  const baseUrl = options.baseUrl ?? settings.model.baseUrl ?? "https://openrouter.ai/api/v1";
  const effort: EffortLevel = options.effort ?? "high";
  const effortConfig = getEffortConfig(effort);
  const maxTurns = options.maxTurns ?? 30;

  const llmConfig: LLMConfig = {
    provider,
    model,
    apiKey,
    baseUrl,
    temperature: effortConfig.temperature ?? settings.model.temperature ?? 0.3,
    maxTokens: effortConfig.maxTokens ?? settings.model.maxTokens ?? 8192,
    enableStreaming: true,
  };

  const permissionMode = (options.permissionMode ?? "acceptEdits") as PermissionMode;
  const maxContextTokens = settings.context.maxTokens ?? 200_000;

  // 1. Create the engine (server-side)
  const engine = new Engine({
    llm: llmConfig,
    cwd,
    preset: options.preset ?? settings.agent.preset,
    enabledBuiltinTools: settings.agent.enabledBuiltinTools,
    disabledBuiltinTools: settings.agent.disabledBuiltinTools,
    permissionMode,
    customSystemPrompt: settings.agent.customSystemPrompt,
    appendSystemPrompt: settings.agent.appendSystemPrompt,
    maxTurns,
    maxContextTokens,
    sessionStorageDir: settings.session.storageDir,
    costStore: costTracker,
    mcpServers: settings.mcpServers,
    approvalBackend: getInteractiveApprovalBackend(),
  });

  // 2. Create in-process transport pair
  const [serverTransport, clientTransport] = createInProcessTransport();

  // 3. Wire up AgentServer (wraps engine, handles protocol)
  const _server = new AgentServer({ engine, transport: serverTransport });

  // 4. Create AgentClient (UI-side)
  const client = new AgentClient({ transport: clientTransport });

  // 5. Launch Ink UI with the client
  await startInkRepl({
    client,
    model,
    effort,
    maxTurns,
    cwd,
    maxContextTokens,
    sessionId: options.resume,
    prefill: options.prefill,
  });
}
