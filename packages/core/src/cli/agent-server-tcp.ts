/**
 * agent-server-tcp — headless server entry point over TCP (Phase 6).
 *
 * Mirrors agent-server-stdio.ts (same EngineRuntime + ChatSessionManager +
 * AgentServer bootstrap), but listens on a TCP socket instead of stdio and
 * also starts the in-process automation scheduler so a deployed server runs
 * scheduled jobs 7x24 with no Electron/GUI.
 *
 * The automation module is the SAME zero-env-dependency module the desktop
 * loads (startAutomation) — this is the "thin server host" the plan's D2
 * describes: one module, two hosts.
 *
 * Usage:
 *   AGENT_TCP_PORT=4321 node dist/cli/agent-server-tcp.js
 *
 * v1 SECURITY: binds 127.0.0.1 by default and has NO authentication. Do not
 * expose to a public interface without adding auth (token/TLS). Use SSH
 * tunneling for remote access in v1.
 */

import { Engine } from "../engine/engine.js";
import { EngineRuntime } from "../engine/runtime.js";
import { ChatSessionManager } from "../protocol/chat-session-manager.js";
import { AgentServer } from "../protocol/server.js";
import { listenTcp } from "../protocol/tcp-transport.js";
import { SettingsManager } from "../settings/manager.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { personalizationFrom } from "../settings/personalization.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { mergePluginMcpServers } from "../plugins/installer/loadPluginMcp.js";
import { CostTracker } from "../cost-tracker.js";
import { HeadlessApprovalBackend } from "../tool-system/permission.js";
import { createRunManager } from "../run/factory.js";
import { startAutomation } from "../automation/index.js";
import { CronStore, defaultCronStorePath } from "../automation/store.js";
import { resolveLLMConfigForTag } from "../engine/resolve-llm-config.js";

const cwd = process.env.AGENT_CWD ?? process.cwd();
const port = Number(process.env.AGENT_TCP_PORT ?? "4321");
const host = process.env.AGENT_TCP_HOST ?? "127.0.0.1";

const settingsManager = new SettingsManager(cwd, "full");
const settings = settingsManager.get();

const seedLlm = resolveLLMConfigForTag(
  settings,
  "text",
  (settings as { defaults?: { text?: string } }).defaults?.text,
);
if (!seedLlm) {
  console.error(
    `[agent-server] 没有可用的文本模型连接(defaults.text=${
      (settings as { defaults?: { text?: string } }).defaults?.text ?? "未设置"
    })。` +
    `请在「连接」页添加并填写凭证。`,
  );
  process.exit(1);
}
const llmConfig = seedLlm;

// ── Shared runtime (same bootstrap as stdio) ─────────────────────
const seedEngine = new Engine({ llm: llmConfig, cwd, settingsScope: "full" });
const modelPool = seedEngine.getModelPool();
const toolRegistry = seedEngine.getToolRegistry();
const resolvedLlmConfig = seedEngine.getConfig().llm;
const resolvedClientDefaults = seedEngine.getConfig().clientDefaults;
const mcpPool = new MCPManager(toolRegistry);
const costTracker = new CostTracker();

const runtime = new EngineRuntime({
  modelPool,
  toolRegistry,
  settings: settingsManager,
  mcpPool,
  costTracker,
});

const chatManager = new ChatSessionManager({
  runtime,
  engineFactory: (slice) => {
    // Fold project capabilityOverrides over the global disabledPlugins for
    // the MCP merge (能力总览 project "on" must override global off) — same
    // contract as the stdio host's factory.
    const sessionCwd = slice.cwd ?? cwd;
    const { disabledPlugins } = computeEffectiveDisabledLists(
      new SettingsManager(sessionCwd, "full"),
      sessionCwd,
    );
    return new Engine({
      llm: runtime.modelPool.resolveLLMConfig() ?? resolvedLlmConfig,
      clientDefaults: resolvedClientDefaults,
      cwd,
      runtime,
      settingsScope: "full",
      mcpServers: mergePluginMcpServers(
        settings.mcpServers ?? {},
        disabledPlugins,
        settings.mcpServerOverrides ?? {},
      ),
      permissionMode: slice.permissionMode,
      preset: slice.preset,
      customSystemPrompt: slice.customSystemPrompt,
      appendSystemPrompt: slice.appendSystemPrompt,
      // Personalization + instruction compat come from disk settings only
      // (not per-request slice overrides) — same disk-only contract as the
      // stdio host. Shared helper keeps the three fields wired identically.
      ...personalizationFrom(settings.agent),
      maxTurns: slice.maxTurns,
      maxContextTokens: slice.maxContextTokens,
      ...(slice.cwd ? { cwd: slice.cwd } : {}),
    });
  },
  maxSessions: 16,
  idleTtlMs: 30 * 60 * 1000,
});
chatManager.startIdleSweeper();

// ── Automation (same module the desktop loads) ──────────────────
// Read-only by default until write tiers are configured per job. Runs land in
// the RunStore so history is queryable.
const automationRunManager = createRunManager({
  llm: resolvedLlmConfig,
  cwd,
  permissionMode: "default",
  approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
});
const automation = startAutomation({
  store: new CronStore(defaultCronStorePath()),
  runManager: automationRunManager,
});

// ── Serve over TCP ──────────────────────────────────────────────
// One AgentServer per accepted connection, all sharing the same chatManager.
const servers = new Set<AgentServer>();

listenTcp({ port, host }, (transport) => {
  const server = new AgentServer({ chatManager, transport });
  servers.add(server);
})
  .then((listener) => {
    process.stderr.write(`[code-shell] automation server listening on ${host}:${listener.port}\n`);

    const shutdown = () => {
      automation.stop();
      for (const s of servers) s.close();
      void listener.close().then(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  })
  .catch((err) => {
    process.stderr.write(`[code-shell] failed to start automation server: ${String(err)}\n`);
    process.exit(1);
  });
