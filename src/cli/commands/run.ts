/**
 * `run` command — headless single-prompt execution.
 *
 * Uses the same Engine → AgentServer → AgentClient pipeline,
 * but with a headless renderer instead of Ink UI.
 */

import { Engine } from "../../engine/engine.js";
import { AgentServer } from "../../protocol/server.js";
import { AgentClient } from "../../protocol/client.js";
import { createInProcessTransport } from "../../protocol/transport.js";
import { SettingsManager } from "../../settings/manager.js";
import { costTracker } from "../cost-tracker.js";
import { createRenderer, type OutputFormat } from "../output/renderer.js";
import type { LLMConfig, PermissionMode } from "../../types.js";
import type { AgentPresetName } from "../../preset/index.js";

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
}

export async function runCommand(options: RunOptions): Promise<void> {
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
      "Error: No API key provided. Use --api-key, set OPENROUTER_API_KEY env var, or add to settings.",
    );
    process.exit(1);
  }

  // Build LLM config
  const llmConfig: LLMConfig = {
    provider: options.provider ?? settings.model.provider ?? "openai",
    model: options.model ?? settings.model.name ?? "anthropic/claude-opus-4-6",
    apiKey,
    baseUrl: options.baseUrl ?? settings.model.baseUrl ?? "https://openrouter.ai/api/v1",
    temperature: settings.model.temperature,
    maxTokens: settings.model.maxTokens ?? 8192,
    enableStreaming: true,
  };

  const engine = new Engine({
    llm: llmConfig,
    cwd,
    preset: options.preset ?? settings.agent.preset,
    enabledBuiltinTools: settings.agent.enabledBuiltinTools,
    disabledBuiltinTools: settings.agent.disabledBuiltinTools,
    permissionMode: (options.permissionMode ?? "acceptEdits") as PermissionMode,
    customSystemPrompt: settings.agent.customSystemPrompt,
    appendSystemPrompt: settings.agent.appendSystemPrompt,
    maxTurns: options.maxTurns ?? 30,
    maxContextTokens: settings.context.maxTokens,
    sessionStorageDir: settings.session.storageDir,
    costStore: costTracker,
    mcpServers: settings.mcpServers,
  });

  // Wire through protocol layer
  const [serverTransport, clientTransport] = createInProcessTransport();
  const _server = new AgentServer({ engine, transport: serverTransport });
  const client = new AgentClient({ transport: clientTransport });

  const outputFormat = options.output ?? (settings.output.format as OutputFormat) ?? "text";
  const renderer = createRenderer(outputFormat);

  // Forward stream events to renderer
  client.onStreamEvent((event) => renderer.onEvent(event));

  const result = await client.run(options.task, options.resume);

  renderer.onComplete(result.text, result.reason, {
    sessionId: result.sessionId,
    turnCount: result.turnCount,
  });

  client.close();

  process.exit(result.reason === "completed" ? 0 : 1);
}
