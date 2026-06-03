import type { ValidatedSettings } from "./schema.js";
import type { EngineConfig } from "../engine/engine.js";
import { personalizationFrom } from "./personalization.js";
import { mergePluginMcpServers } from "../plugins/installer/loadPluginMcp.js";

/**
 * The subset of EngineConfig the config hot-reload ("layer 2") pushes onto an
 * already-running session's `this.config`. These are the "disk-default" fields:
 * read from settings.json at construction, otherwise frozen for the session's
 * life. Request-override fields (permissionMode / goal / maxTurns /
 * maxContextTokens / cwd) are intentionally excluded — those are per-request
 * and handled by handleConfigure / run() options, not by disk hot-push.
 */
export type DiskDefaultPatch = Pick<
  EngineConfig,
  | "preset"
  | "customSystemPrompt"
  | "appendSystemPrompt"
  | "responseLanguage"
  | "userProfile"
  | "instructions"
  | "mcpServers"
>;

/**
 * Derive the disk-default config patch from freshly-read settings.
 *
 * This MUST mirror how `agent-server-stdio.ts`'s engineFactory builds these
 * same fields from `settings.agent` + `mergePluginMcpServers(...)`, so a
 * reloaded running session and a newly-created session converge on identical
 * config (no divergence). It reuses `personalizationFrom` for the three
 * personalization fields rather than duplicating the mapping.
 */
export function diskDefaultsFrom(settings: ValidatedSettings): DiskDefaultPatch {
  const agent = settings.agent ?? {};
  return {
    preset: agent.preset,
    customSystemPrompt: agent.customSystemPrompt,
    appendSystemPrompt: agent.appendSystemPrompt,
    ...personalizationFrom(agent),
    // Same merge engineFactory uses: user-configured servers + enabled
    // plugins' servers. Plugin servers a disabled plugin would contribute are
    // skipped, matching new-session construction.
    mcpServers: mergePluginMcpServers(
      settings.mcpServers ?? {},
      (settings as { disabledPlugins?: string[] }).disabledPlugins ?? [],
    ),
  };
}
