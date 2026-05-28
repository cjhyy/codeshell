/**
 * agent-server-stdio — Electron worker entry point.
 *
 * Bootstraps EngineRuntime + ChatSessionManager and exposes AgentServer
 * over a newline-delimited JSON stdio transport so Electron's main process
 * (or any other parent that spawns this file as a child process) can drive
 * multi-session agent runs through the standard protocol.
 *
 * Bootstrap approach (bootstrap-then-extract / approach a):
 *   1. Construct a single "seed" Engine without a runtime.  Engine's
 *      constructor calls populateModelPoolFromSettings() which reads
 *      settings.json, registers model entries and provider catalog, and
 *      resolves the active model — exactly the initialization work we need.
 *   2. Extract the fully-populated modelPool and toolRegistry from the seed
 *      engine, plus construct SettingsManager, MCPManager, CostTracker.
 *   3. Wrap those shared resources in an EngineRuntime.
 *   4. Pass the runtime to ChatSessionManager's engineFactory so every
 *      session engine shares the pool (same active model, same tool set).
 *   5. Discard the seed engine — it will never run a task.
 *
 * Why this over pure "factor-out-builders" (approach b):
 *   Engine.populateModelPoolFromSettings() is a 60-line private method that
 *   reads settings, resolves the active key, builds the ProviderCatalog, and
 *   reloads cached context windows. Extracting it as a standalone helper
 *   would require making several private fields and imports public. The seed
 *   engine pattern reuses the existing, tested code with zero API changes.
 *
 * Clients (Electron renderer, TUI) must not change. As long as the
 * transport is stdio NDJSON and the protocol surface is unchanged, this
 * bootstrap is invisible to them.
 */

import { Engine } from "../engine/engine.js";
import { EngineRuntime } from "../engine/runtime.js";
import { ChatSessionManager } from "../protocol/chat-session-manager.js";
import { AgentServer } from "../protocol/server.js";
import { StdioTransport } from "../protocol/transport.js";
import { SettingsManager } from "../settings/manager.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { CostTracker } from "../cost-tracker.js";

// ─── Read base config from environment / settings ─────────────────

const cwd = process.env.AGENT_CWD ?? process.cwd();

// Load settings once to derive llm config for the seed engine.
// Desktop is a host application: read the full disk hierarchy (incl. the
// user's ~/.code-shell). The SDK default 'project' would skip user config.
const settingsManager = new SettingsManager(cwd, "full");
const settings = settingsManager.get();

const llmConfig = {
  provider: settings.model.provider,
  model: settings.model.name,
  apiKey: settings.model.apiKey ?? "",
  baseUrl: settings.model.baseUrl,
  temperature: settings.model.temperature,
  maxTokens: settings.model.maxTokens,
};

// ─── Step 1: seed engine — populates model pool from settings ─────

const seedEngine = new Engine({
  llm: llmConfig,
  cwd,
  settingsScope: "full",
  // No runtime — Engine.populateModelPoolFromSettings() runs in ctor.
});

// ─── Step 2: extract shared resources ────────────────────────────

const modelPool = seedEngine.getModelPool();
const toolRegistry = seedEngine.getToolRegistry();

// Capture the seed engine's resolved llmConfig (post-populateModelPoolFromSettings).
// This includes resolved provider/baseUrl/apiKey from settings.providers[].
const resolvedLlmConfig = seedEngine.getConfig().llm;

// Reuse the same SettingsManager instance for the runtime instead of constructing
// a fresh one — avoids duplication and keeps the pattern cleaner.
const sharedSettings = settingsManager;

// MCPManager: not connected to any servers at bootstrap time.
// Individual session engines will connect to mcpServers from their config.
// This instance satisfies the EngineRuntime type requirement; it is a
// no-op holder until an engineFactory caller opts to attach servers.
// TODO(future) — currently a top-level placeholder. Future work: aggregate
// MCP server connections across sessions instead of each session creating
// its own MCPManager via Engine.run lazy init.
const mcpPool = new MCPManager(toolRegistry);

// CostTracker: shared across all sessions for aggregate tracking.
// TODO(future) — shared across all sessions, but Engine doesn't yet read
// runtime.costTracker. Future work: per-session cost accounting through
// the shared runtime.
const costTracker = new CostTracker();

// ─── Step 3: build the shared EngineRuntime ───────────────────────

const runtime = new EngineRuntime({
  modelPool,
  toolRegistry,
  settings: sharedSettings,
  mcpPool,
  costTracker,
});

// ─── Step 4: ChatSessionManager ──────────────────────────────────

const chatManager = new ChatSessionManager({
  runtime,
  engineFactory: (slice) =>
    new Engine({
      llm: resolvedLlmConfig,
      cwd,
      runtime,
      // Inherit full scope so spawned subagents read user config too.
      settingsScope: "full",
      // MCP servers from settings — the worker reads the full disk
      // hierarchy at bootstrap (incl. ~/.code-shell). Without this the
      // factory-built session Engine has config.mcpServers === undefined,
      // so Engine.run()'s connectAll() guard never fires and no MCP server
      // (stdio OR url) is ever connected. The shared runtime.mcpPool means
      // the first session to connect populates connections for the worker.
      mcpServers: settings.mcpServers,
      // Per-session overrides from the protocol request
      permissionMode: slice.permissionMode,
      preset: slice.preset,
      customSystemPrompt: slice.customSystemPrompt,
      appendSystemPrompt: slice.appendSystemPrompt,
      maxTurns: slice.maxTurns,
      maxContextTokens: slice.maxContextTokens,
      ...(slice.cwd ? { cwd: slice.cwd } : {}),
    }),
  maxSessions: 16,
  idleTtlMs: 30 * 60 * 1000,
});
chatManager.startIdleSweeper();

// ─── Step 5: AgentServer over stdio ──────────────────────────────

const stdioTransport = new StdioTransport(process.stdin, process.stdout);

new AgentServer({
  chatManager,
  transport: stdioTransport,
});

// Keep the process alive — readline in StdioTransport holds the event loop.
// On parent close / stdin EOF the process will exit naturally.
