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
 *   SubagentStop       → notification (implied matcher on kind ^agent_(completed|failed|cancelled)$)
 *
 * matcher semantics:
 *   SessionStart    — matches against ctx.data.source ("startup"|"resume"|"clear"|"compact")
 *   PreToolUse /
 *   PostToolUse     — matches against ctx.data.toolName
 *   Notification /
 *   SubagentStop    — matches against ctx.data.kind (agent_* terminal states,
 *                     approval_requested/resolved, mcp_server_*, …)
 *   other events    — matcher is currently ignored (the CC spec doesn't
 *                     define matcher semantics for them either)
 *
 * Errors are swallowed per-plugin: a malformed hooks.json from one plugin
 * must not block other plugins from loading.
 */

import type { HookContext, HookEventName, HookResult } from "../hooks/events.js";
import type { HookRegistry } from "../hooks/registry.js";
import { readInstalledPlugins } from "./installedPlugins.js";
import { runPluginCommandHook } from "./pluginCommandHook.js";
import {
  inspectPluginHooks,
  pluginHookApprovalState,
  verifyPluginHookIntegrity,
  type ParsedPluginCommandHook,
  type ParsedPluginHooksDefinition,
  type PluginHookApprovalState,
  type PluginHookIntegrity,
  type SupportedPluginHookEvent,
} from "./pluginHookIntegrity.js";

/** Priority for plugin hooks — between built-in (100) and settings (50). */
const PLUGIN_HOOK_PRIORITY = 80;

const EVENT_NAME_MAP: Record<SupportedPluginHookEvent, HookEventName> = {
  SessionStart: "on_session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  Notification: "notification",
  Stop: "on_session_end",
  // Sub-agent terminal states surface on the notification hook with
  // kind "agent_completed" / "agent_failed" / "agent_cancelled"; the matcher
  // filters on that kind, so SubagentStop maps to a kind-filtered
  // notification subscription (notify-only — codeshell sub-agent stops are
  // not interceptable the way CC's SubagentStop is).
  SubagentStop: "notification",
};

/** CC events whose codeshell notification `kind` the matcher defaults to when absent. */
const IMPLIED_NOTIFICATION_KIND: Record<string, string> = {
  SubagentStop: "^agent_(completed|failed|cancelled)$",
};

/**
 * Per-event matcher logic. Returns true when the hook should fire.
 *
 * We only consult the matcher for events where CC defines its semantics;
 * for others we always fire (matcher is treated as advisory metadata only).
 */
export function matcherAccepts(
  event: HookEventName,
  matcher: string | undefined,
  ctx: HookContext,
): boolean {
  if (!matcher) return true;
  let re: RegExp;
  try {
    re = new RegExp(matcher);
  } catch {
    // Runtime definitions are pre-validated, but direct callers still fail
    // closed if they supply an invalid expression.
    return false;
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
  if (event === "notification") {
    // Notification fan-in carries a `kind` discriminator (agent_* terminal
    // states, approval_requested/resolved, mcp_server_*…). Matcher filters on
    // it so a subscriber only wakes for the kinds it cares about.
    const kind = ctx.data.kind;
    if (typeof kind !== "string") return true;
    return re.test(kind);
  }
  return true;
}

function pluginNameFromKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

interface ParsedPluginHook {
  rawEvent: SupportedPluginHookEvent;
  event: HookEventName;
  matcher?: string;
  command: ParsedPluginCommandHook;
}

function* iteratePluginHooks(definition: ParsedPluginHooksDefinition): Generator<ParsedPluginHook> {
  for (const rawEvent of Object.keys(definition.hooks) as SupportedPluginHookEvent[]) {
    const event = EVENT_NAME_MAP[rawEvent];
    for (const group of definition.hooks[rawEvent] ?? []) {
      for (const command of group.hooks) {
        yield {
          rawEvent,
          event,
          matcher: group.matcher,
          command,
        };
      }
    }
  }
}

/**
 * Stable identity for ONE plugin-provided hook, used as the record key in
 * `capabilityOverrides.pluginHooks` (per-hook project off-switch). Derived
 * from content (`plugin:RawEvent:command`) rather than scan order so it
 * survives plugin reinstalls and hooks.json reordering. Two entries that
 * differ only by matcher collide — acceptable: toggling one toggles both,
 * and identical commands on the same event are in practice the same hook.
 */
export function pluginHookKey(hook: { plugin: string; rawEvent: string; command: string }): string {
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
      if (!installPath) continue;
      const snapshot = inspectPluginHooks(installPath);
      const approval = pluginHookApprovalState(entry, snapshot);
      if (approval === "pending" || approval === "changed" || approval === "none") {
        // Pending and changed executable definitions fail closed. The rest of
        // the plugin remains available; hook-free installs have nothing to load.
        continue;
      }
      if (!snapshot.definition) continue;

      for (const hook of iteratePluginHooks(snapshot.definition)) {
        if (
          disabledHookSet.has(
            pluginHookKey({
              plugin: pluginNameFromKey(key),
              rawEvent: hook.rawEvent,
              command: hook.command.command,
            }),
          )
        ) {
          continue;
        }
        const commandLine = hook.command.command;
        const timeoutMs = hook.command.timeoutMs;
        // A CC event that maps onto a SHARED codeshell event (SubagentStop
        // → notification) gets an implied kind-matcher, so it only fires
        // for the notification kinds that correspond to the CC semantics.
        const matcher = hook.matcher ?? IMPLIED_NOTIFICATION_KIND[hook.rawEvent];
        const handler = async (ctx: HookContext): Promise<HookResult> => {
          if (!matcherAccepts(hook.event, matcher, ctx)) return {};
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
          hook.event,
          handler,
          PLUGIN_HOOK_PRIORITY,
          `plugin:${pluginNameFromKey(key)}:${hook.rawEvent}`,
        );
      }
    }
  }
}

/** A single plugin-provided hook, surfaced read-only to the settings UI. */
export interface PluginHookEntry {
  /** Full install key (`plugin@marketplace`) used by approval APIs. */
  installKey: string;
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
  /** Install-time integrity state for the executable hook definition. */
  integrity: PluginHookIntegrity;
  /** Explicit execution trust state. Pending/changed hooks do not register. */
  approval: PluginHookApprovalState;
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
      if (!installPath) continue;
      const snapshot = inspectPluginHooks(installPath);
      const integrity = verifyPluginHookIntegrity(entry, snapshot);
      const approval = pluginHookApprovalState(entry, snapshot);
      if (!snapshot.definition) continue;
      for (const hook of iteratePluginHooks(snapshot.definition)) {
        out.push({
          installKey: key,
          plugin,
          event: hook.event,
          rawEvent: hook.rawEvent,
          command: hook.command.command,
          matcher: hook.matcher,
          disabled,
          integrity,
          approval,
          key: pluginHookKey({
            plugin,
            rawEvent: hook.rawEvent,
            command: hook.command.command,
          }),
        });
      }
    }
  }
  return out;
}
