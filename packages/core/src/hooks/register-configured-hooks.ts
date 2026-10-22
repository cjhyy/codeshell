/**
 * Register a session's configured hooks — installed-plugin hooks and
 * `settings.hooks` shell commands — onto a live {@link HookRegistry}.
 *
 * The Native Engine and the external-runtime `SessionToolHost` both register
 * through here, so the two paths cannot drift on which hooks load, at what
 * priority, or how disable switches and trust apply.
 *
 * Trust is the SettingsManager's job, not this module's: one built with
 * `projectTrusted: false` has already stripped the project layers' `hooks`
 * (a DANGEROUS_PROJECT_FIELD), so an untrusted repository cannot register a
 * command here. Plugin hooks come from the user's installed-plugin registry and
 * keep their own fail-closed approval gate (see loadPluginHooks).
 */
import type { HookEventName } from "./events.js";
import type { HookHandler, HookRegistry } from "./registry.js";
import { runShellHook, shellHookMatches } from "./shell-runner.js";
import { loadPluginHooks } from "../plugins/loadPluginHooks.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import type { SettingsManager } from "../settings/manager.js";
import type { SettingsHookConfig } from "../types.js";
import type { LifetimeScope } from "../composition/lifetime.js";

/** Chain order: plugin (80) → settings shell (50) → capability (20) → SDK (0). */
export const SETTINGS_SHELL_HOOK_PRIORITY = 50;

type HookOwner = Pick<LifetimeScope, "own">;

/** A `settings.hooks` entry; the settings schema adds the UI's soft off-switch. */
type SettingsHookEntry = SettingsHookConfig & { disabled?: boolean };

/** One shell-runner wrapper per enabled `settings.hooks` entry. */
export function registerSettingsShellHooks(
  registry: HookRegistry,
  entries: readonly SettingsHookEntry[],
  owner?: HookOwner,
): void {
  for (const entry of entries) {
    // Soft off-switch (settings hooks UI): the entry stays in the file but
    // doesn't register.
    if (entry.disabled === true) continue;
    const handler: HookHandler = async (ctx) => {
      if (!shellHookMatches(entry, ctx)) return {};
      return runShellHook(entry, ctx);
    };
    const dispose = registry.register(
      entry.event as HookEventName,
      handler,
      SETTINGS_SHELL_HOOK_PRIORITY,
      `shell:${entry.event}:${entry.command.slice(0, 32)}`,
    );
    owner?.own(dispose);
  }
}

/**
 * Register the plugin and settings hooks `settings` resolves for `cwd`, exactly
 * as a top-level Native Engine does at construction. Read failures register
 * nothing rather than throwing, matching the Engine's best-effort contract.
 */
export function registerConfiguredHooks(
  registry: HookRegistry,
  settings: SettingsManager,
  cwd: string,
  owner?: HookOwner,
): void {
  try {
    const { disabledPlugins, disabledPluginHooks } = computeEffectiveDisabledLists(settings, cwd);
    loadPluginHooks(registry, disabledPlugins, disabledPluginHooks, owner);
  } catch {
    // A plugin-registry failure must not also drop the user's settings hooks.
  }
  let entries: readonly SettingsHookEntry[];
  try {
    entries = settings.get().hooks ?? [];
  } catch {
    return;
  }
  registerSettingsShellHooks(registry, entries, owner);
}
