/**
 * Interactive REPL mode — uses Ink (React for CLI) for the terminal UI.
 *
 * Wiring: Engine → AgentServer → [in-process transport] → AgentClient → UI
 */

import chalk from "chalk";
import { Engine } from "@cjhyy/code-shell-core";
import { EngineRuntime } from "@cjhyy/code-shell-core";
import { ChatSessionManager } from "@cjhyy/code-shell-core";
import { AgentServer } from "@cjhyy/code-shell-core";
import { AgentClient } from "@cjhyy/code-shell-core";
import { createInProcessTransport } from "@cjhyy/code-shell-core";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { MCPManager } from "@cjhyy/code-shell-core";
import { CostTracker } from "@cjhyy/code-shell-core";
import { resolveApiKey } from "@cjhyy/code-shell-core";
import { costTracker } from "@cjhyy/code-shell-core";
import type { LLMConfig, PermissionMode } from "@cjhyy/code-shell-core";
import { startInkRepl } from "../../ui/index.js";
import { runInkOnboarding } from "../../ui/onboarding-runner.js";
import type { AgentPresetName } from "@cjhyy/code-shell-core";
import { getInteractiveApprovalBackend } from "@cjhyy/code-shell-core";

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

  // Load settings — single SettingsManager instance reused throughout.
  const settingsManager = new SettingsManager(cwd);
  let settings = settingsManager.get();

  // Resolve API key.
  //
  // Onboarding gate: env vars alone are NOT enough to skip onboarding —
  // saved settings (model/models[]/providers[]) must be present. Otherwise
  // `/logout` looks like a no-op whenever the user has a provider env var
  // set (very common: OPENROUTER_API_KEY, ANTHROPIC_API_KEY). The wizard
  // itself surfaces detected env keys (OnboardingPrompt.detectEnvKeys) so
  // the user can opt-in to using them — not have them silently chosen.
  const hasSavedAuth =
    !!options.apiKey ||
    !!settings.model?.apiKey ||
    (Array.isArray(settings.models) && settings.models.some((m) => m?.apiKey)) ||
    (Array.isArray(settings.providers) && settings.providers.some((p) => p?.apiKey));
  let apiKey = hasSavedAuth ? resolveApiKey(options.apiKey, settings.model.apiKey) : undefined;

  let model = options.model ?? settings.model.name;
  let provider = options.provider ?? settings.model.provider;
  let baseUrl = options.baseUrl ?? settings.model.baseUrl;

  if (!apiKey) {
    if (!process.stdin.isTTY) {
      console.error(
        chalk.red(
          "Error: No API key configured and stdin is not a TTY. " +
          "Set --api-key, OPENROUTER_API_KEY, or run interactively to onboard.",
        ),
      );
      process.exit(1);
    }
    const result = await runInkOnboarding();
    if (!result) {
      console.error(chalk.yellow("Onboarding cancelled."));
      process.exit(1);
    }
    apiKey = result.apiKey;
    // Wizard answers override settings/CLI defaults so the new config
    // takes effect immediately without a restart.
    provider = result.provider;
    model = result.model;
    baseUrl = result.baseUrl;
    // Reload settings — the wizard has just persisted the model pool / arena
    // entries, and downstream code (e.g. /model) reads them from settings.
    settings = settingsManager.get();
  }

  model = model ?? "anthropic/claude-opus-4-6";
  provider = provider ?? "openai";
  baseUrl = baseUrl ?? "https://openrouter.ai/api/v1";
  const effort: EffortLevel = options.effort ?? "high";
  const effortConfig = getEffortConfig(effort);
  const maxTurns = options.maxTurns ?? 100;

  const llmConfig: LLMConfig = {
    provider,
    model,
    apiKey,
    baseUrl,
    temperature: effortConfig.temperature ?? settings.model.temperature ?? 0.3,
    // Priority: user-configured settings.model.maxTokens > effort preset > 8192.
    // Previously this was `effortConfig.maxTokens ?? settings.model.maxTokens`,
    // which silently ignored the user's setting because effortConfig is always
    // populated.
    maxTokens: settings.model.maxTokens ?? effortConfig.maxTokens ?? 8192,
    enableStreaming: true,
  };

  const permissionMode = (options.permissionMode ?? "acceptEdits") as PermissionMode;
  const maxContextTokens = settings.context.maxTokens ?? 200_000;

  // ── Shared config passed into every session engine ─────────────
  const sharedCfg = {
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
  };

  // 1. Seed engine — calls populateModelPoolFromSettings() in ctor so the
  //    model pool and tool registry are fully populated. Discarded after
  //    resource extraction (never runs a task).
  const seedEngine = new Engine({ llm: llmConfig, cwd });

  // 2. Extract shared resources from seed engine
  const modelPool = seedEngine.getModelPool();
  const toolRegistry = seedEngine.getToolRegistry();
  const resolvedLlmConfig = seedEngine.getConfig().llm;
  // settingsManager was hoisted to the top of replCommand; reused here.
  // MCPManager: no-op holder satisfying EngineRuntime type; individual
  // session engines connect to mcpServers from their config.
  // TODO(future): aggregate MCP connections across sessions at the runtime level.
  const mcpPool = new MCPManager(toolRegistry);
  // CostTracker: fresh shared instance for this process.
  // TODO(future): thread into Engine cost accounting once Engine reads runtime.costTracker.
  const sessionCostTracker = new CostTracker();

  // 3. Build the shared EngineRuntime
  const runtime = new EngineRuntime({
    modelPool,
    toolRegistry,
    settings: settingsManager,
    mcpPool,
    costTracker: sessionCostTracker,
  });

  // 4. ChatSessionManager — single session "tui-main" (or resumed sid)
  const chatManager = new ChatSessionManager({
    runtime,
    engineFactory: (slice) =>
      new Engine({
        llm: resolvedLlmConfig,
        cwd,
        runtime,
        ...sharedCfg,
        // Per-session overrides from the protocol request take precedence
        ...(slice.permissionMode ? { permissionMode: slice.permissionMode } : {}),
        ...(slice.preset ? { preset: slice.preset } : {}),
        ...(slice.customSystemPrompt !== undefined ? { customSystemPrompt: slice.customSystemPrompt } : {}),
        ...(slice.appendSystemPrompt !== undefined ? { appendSystemPrompt: slice.appendSystemPrompt } : {}),
        ...(slice.maxTurns !== undefined ? { maxTurns: slice.maxTurns } : {}),
        ...(slice.maxContextTokens !== undefined ? { maxContextTokens: slice.maxContextTokens } : {}),
        ...(slice.cwd ? { cwd: slice.cwd } : {}),
      }),
    maxSessions: 4,  // TUI is single-user; 4 accommodates a few sub-sessions without runaway resource use
    idleTtlMs: 30 * 60 * 1000,
  });
  chatManager.startIdleSweeper();

  // 5. Create in-process transport pair
  const [serverTransport, clientTransport] = createInProcessTransport();

  // 6. Wire up AgentServer (wraps chatManager, handles protocol)
  const _server = new AgentServer({ chatManager, transport: serverTransport });

  // 7. Create AgentClient (UI-side)
  const client = new AgentClient({ transport: clientTransport });

  // Fixed sessionId — every user message in this REPL session routes to the
  // same engine. Use the --resume id when provided so conversation history
  // is correctly continued.
  const tuiSessionId = options.resume ?? "tui-main";

  // 8. Launch Ink UI with the client
  await startInkRepl({
    client,
    model,
    effort,
    maxTurns,
    cwd,
    maxContextTokens,
    sessionId: tuiSessionId,
    prefill: options.prefill,
  });
}
