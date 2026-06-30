import type { ValidatedSettings } from "./schema.js";
import type { EngineConfig } from "../engine/types.js";
import { personalizationFrom } from "./personalization.js";
import { mergePluginMcpServers } from "../plugins/installer/loadPluginMcp.js";

/**
 * The subset of EngineConfig the config hot-reload ("layer 2") pushes onto an
 * already-running session's `this.config`. These are the "disk-default" fields:
 * read from settings.json at construction, otherwise frozen for the session's
 * life. Request-override fields (permissionMode / goal / maxTurns /
 * maxContextTokens / cwd) are intentionally excluded — those are per-request
 * and handled by handleConfigure / run() options, not by disk hot-push.
 *
 * Reload semantics per field (see Engine.refreshRuntimeConfig):
 *   - preset: system-prompt / behavior hot-reloads (next-turn PromptComposer
 *     re-resolves it); the builtin TOOL SET it implies needs a session restart
 *     (registry is ctor-frozen, possibly shared via runtime).
 *   - customSystemPrompt / appendSystemPrompt / responseLanguage / userProfile:
 *     hot — re-read by the next-turn PromptComposer.
 *
 * IMPORTANT (#8): every field here is pushed as a PURE DISK value and will
 * OVERRIDE any per-request slice override of the same field on the running
 * session. Safe for the desktop host today (its slice carries only
 * permissionMode+cwd, both excluded above). A future host that sets any of
 * these per-request MUST exclude that field from the reload patch — or track
 * per-request overrides separately — to avoid the reload clobbering it.
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
export function diskDefaultsFrom(
  settings: ValidatedSettings,
  /**
   * EFFECTIVE disabled plugins for the target session — the caller should
   * pass `engine.getEffectiveDisabledLists().disabledPlugins` so the merge
   * honors project capabilityOverrides (能力总览 project "on" overrides the
   * global list). Omitted → falls back to the raw global list (legacy).
   */
  effectiveDisabledPlugins?: string[],
): DiskDefaultPatch {
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
      effectiveDisabledPlugins ??
        (settings as { disabledPlugins?: string[] }).disabledPlugins ??
        [],
      settings.mcpServerOverrides ?? {},
    ),
  };
}
