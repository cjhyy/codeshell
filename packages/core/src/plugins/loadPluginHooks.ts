/**
 * loadPluginHooks — scan every installed plugin's hooks/hooks.json and
 * register the command-type hooks with the engine's HookRegistry.
 *
 * Plugin hooks.json schema (Claude Code-compatible):
 *
 *   {
 *     "hooks": {
 *       "<EventName>": [
 *         {
 *           "matcher": "<regex>",      // optional; semantics depend on event
 *           "hooks": [
 *             {
 *               "type": "command",
 *               "command": "...",      // ${CODESHELL_PLUGIN_ROOT} placeholder
 *               "async": false,        // currently ignored (always sync await)
 *               "timeout_ms": 60000    // optional override
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * Event-name mapping (CC PascalCase → codeshell snake_case):
 *   SessionStart       → on_session_start
 *   UserPromptSubmit   → user_prompt_submit
 *   PreToolUse         → pre_tool_use
 *   PostToolUse        → post_tool_use
 *   PreCompact         → pre_compact
 *   Notification       → notification
 *   Stop               → on_session_end
 *   SubagentStop       → (skipped — codeshell sub-agents don't surface this event)
 *
 * matcher semantics:
 *   SessionStart    — matches against ctx.data.source ("startup"|"resume"|"clear"|"compact")
 *   PreToolUse /
 *   PostToolUse     — matches against ctx.data.toolName
 *   other events    — matcher is currently ignored (the CC spec doesn't
 *                     define matcher semantics for them either)
 *
 * Errors are swallowed per-plugin: a malformed hooks.json from one plugin
 * must not block other plugins from loading.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookContext, HookEventName, HookResult } from "../hooks/events.js";
import type { HookRegistry } from "../hooks/registry.js";
import { readInstalledPlugins } from "./installedPlugins.js";
import { runPluginCommandHook } from "./pluginCommandHook.js";

/** Priority for plugin hooks — between built-in (100) and settings (50). */
const PLUGIN_HOOK_PRIORITY = 80;

const EVENT_NAME_MAP: Record<string, HookEventName | null> = {
  SessionStart: "on_session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  Notification: "notification",
  Stop: "on_session_end",
  SubagentStop: null,
};

interface RawCommandHook {
  type?: string;
  command?: string;
  async?: boolean;
  timeout_ms?: number;
}

interface RawMatcherGroup {
  matcher?: string;
  hooks?: RawCommandHook[];
}

interface RawHooksJson {
  hooks?: Record<string, RawMatcherGroup[]>;
}

function readHooksJson(installPath: string): RawHooksJson | null {
  const path = join(installPath, "hooks", "hooks.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as RawHooksJson;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[plugin-hooks] failed to parse ${path}:`,
      (err as Error).message,
    );
  }
  return null;
}

/**
 * Per-event matcher logic. Returns true when the hook should fire.
 *
 * We only consult the matcher for events where CC defines its semantics;
 * for others we always fire (matcher is treated as advisory metadata only).
 */
function matcherAccepts(
  event: HookEventName,
  matcher: string | undefined,
  ctx: HookContext,
): boolean {
  if (!matcher) return true;
  let re: RegExp;
  try {
    re = new RegExp(matcher);
  } catch {
    // Bad regex — be permissive (matches CC's "log + drop" behavior).
    return true;
  }

  if (event === "on_session_start") {
    const source = ctx.data.source;
    if (typeof source !== "string") return true;
    return re.test(source);
  }
  if (event === "pre_tool_use" || event === "post_tool_use") {
    const toolName = ctx.data.toolName;
    if (typeof toolName !== "string") return false;
    return re.test(toolName);
  }
  return true;
}

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Stable identity for ONE plugin-provided hook, used as the record key in
 * `capabilityOverrides.pluginHooks` (per-hook project off-switch). Derived
 * from content (`plugin:RawEvent:command`) rather than scan order so it
 * survives plugin reinstalls and hooks.json reordering. Two entries that
 * differ only by matcher collide — acceptable: toggling one toggles both,
 * and identical commands on the same event are in practice the same hook.
 */
export function pluginHookKey(
  hook: { plugin: string; rawEvent: string; command: string },
): string {
  return `${hook.plugin}:${hook.rawEvent}:${hook.command}`;
}

/**
 * Walk installed plugins and register their command hooks. Safe to call
 * multiple times — the caller is responsible for not double-registering
 * (HookRegistry has no de-dup; the engine constructor calls this exactly
 * once after creating the registry).
 *
 * `disabledPlugins` is the coarse "plugin total switch" — bare plugin names
 * (no `@marketplace`, no `:` suffix), matching scanSkills' semantics. A
 * disabled plugin contributes NO hooks, so e.g. disabling "superpowers"
 * also suppresses its SessionStart injection — not just its Skill-tool
 * entries. Without this, `disabledPlugins` only filtered the skill list and
 * the plugin's hooks still fired regardless.
 *
 * `disabledPluginHooks` is the fine-grained per-hook switch — a list of
 * {@link pluginHookKey} keys (folded from the project's
 * `capabilityOverrides.pluginHooks` by readDisabledLists). A matching hook
 * is skipped while the rest of the plugin keeps working.
 */
export function loadPluginHooks(
  registry: HookRegistry,
  disabledPlugins: string[] = [],
  disabledPluginHooks: string[] = [],
): void {
  const data = readInstalledPlugins();
  const disabledSet = new Set(disabledPlugins);
  const disabledHookSet = new Set(disabledPluginHooks);
  for (const [key, entries] of Object.entries(data.plugins)) {
    if (disabledSet.has(pluginNameFromKey(key))) continue;
    for (const entry of entries) {
      const installPath = entry.installPath;
      if (!installPath || !existsSync(installPath)) continue;
      const raw = readHooksJson(installPath);
      if (!raw?.hooks) continue;

      for (const [eventNameRaw, groups] of Object.entries(raw.hooks)) {
        const mapped = EVENT_NAME_MAP[eventNameRaw];
        if (mapped === null || mapped === undefined) {
          // Unmapped event name (e.g. SubagentStop) — silently skip; logging
          // every unknown event for every plugin would be noisy.
          continue;
        }
        if (!Array.isArray(groups)) continue;

        for (const group of groups) {
          const commands = group.hooks ?? [];
          for (const cmd of commands) {
            if (cmd.type !== "command" || typeof cmd.command !== "string") {
              continue;
            }
            if (
              disabledHookSet.has(
                pluginHookKey({
                  plugin: pluginNameFromKey(key),
                  rawEvent: eventNameRaw,
                  command: cmd.command,
                }),
              )
            ) {
              continue;
            }
            const commandLine = cmd.command;
            const timeoutMs = cmd.timeout_ms;
            const matcher = group.matcher;
            const handler = async (ctx: HookContext): Promise<HookResult> => {
              if (!matcherAccepts(mapped, matcher, ctx)) return {};
              return runPluginCommandHook(
                {
                  command: commandLine,
                  installPath,
                  pluginKey: key,
                  timeoutMs,
                },
                ctx,
              );
            };
            registry.register(
              mapped,
              handler,
              PLUGIN_HOOK_PRIORITY,
              `plugin:${pluginNameFromKey(key)}:${eventNameRaw}`,
            );
          }
        }
      }
    }
  }
}

/** A single plugin-provided hook, surfaced read-only to the settings UI. */
export interface PluginHookEntry {
  /** Source plugin name (bare, no @marketplace). */
  plugin: string;
  /** Mapped codeshell event name. */
  event: HookEventName;
  /** Original CC event name as written in hooks.json (for display). */
  rawEvent: string;
  /** The shell command the hook runs. */
  command: string;
  /** Optional matcher (regex) from the hooks.json group. */
  matcher?: string;
  /** Whether the owning plugin is currently disabled (its hooks don't fire). */
  disabled: boolean;
  /** Stable per-hook identity ({@link pluginHookKey}) — the record key the
   *  UI writes to `capabilityOverrides.pluginHooks` to toggle just this hook. */
  key: string;
}

/**
 * Read-only counterpart to {@link loadPluginHooks}: scan installed plugins and
 * RETURN their command hooks (instead of registering them), so the settings
 * "钩子" page can show plugin-provided hooks alongside the user's hand-written
 * ones, labelled by owner plugin. `disabledPlugins` doesn't filter the list —
 * disabled plugins are still listed but flagged `disabled:true` (so the UI can
 * show "由 xxx 插件提供（已禁用）"); pass it so that flag is accurate.
 */
export function listPluginHooks(disabledPlugins: string[] = []): PluginHookEntry[] {
  const data = readInstalledPlugins();
  const disabledSet = new Set(disabledPlugins);
  const out: PluginHookEntry[] = [];
  for (const [key, entries] of Object.entries(data.plugins)) {
    const plugin = pluginNameFromKey(key);
    const disabled = disabledSet.has(plugin);
    for (const entry of entries) {
      const installPath = entry.installPath;
      if (!installPath || !existsSync(installPath)) continue;
      const raw = readHooksJson(installPath);
      if (!raw?.hooks) continue;
      for (const [eventNameRaw, groups] of Object.entries(raw.hooks)) {
        const mapped = EVENT_NAME_MAP[eventNameRaw];
        if (mapped === null || mapped === undefined) continue;
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          for (const cmd of group.hooks ?? []) {
            if (cmd.type !== "command" || typeof cmd.command !== "string") continue;
            out.push({
              plugin,
              event: mapped,
              rawEvent: eventNameRaw,
              command: cmd.command,
              matcher: group.matcher,
              disabled,
              key: pluginHookKey({ plugin, rawEvent: eventNameRaw, command: cmd.command }),
            });
          }
        }
      }
    }
  }
  return out;
}
