import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { SettingsManager } from "../settings/manager.js";
import { userHome, type SettingsScope } from "../settings/manager.js";
import { listPluginHooksForHost, matcherAccepts } from "../plugins/loadPluginHooks.js";
import type { PluginHookSource } from "../plugins/loadPluginHooks.js";
import type { SettingsHookOrigin } from "../settings/hook-provenance.js";
import { installedPluginsPath } from "../plugins/installedPlugins.js";
import { shellHookMatches } from "./shell-runner.js";
import type { HookEventName } from "./events.js";
import { sha256 } from "../runtime/constrained-process/resources.js";

export const TOOL_HOOK_EVENTS = [
  "pre_tool_use",
  "on_permission_check",
  "on_tool_start",
  "on_tool_end",
  "post_tool_use",
] as const satisfies readonly HookEventName[];

export interface ConfiguredToolHook {
  id: string;
  event: HookEventName;
  protocol: "settings" | "plugin";
  priority: 50 | 80;
  command: string;
  timeoutMs: number;
  cwd?: string;
  pluginInstallPath?: string;
  source?: PluginHookSource | SettingsHookOrigin;
}

function fileIdentity(path: string): unknown {
  try {
    const info = lstatSync(path, { bigint: true });
    if (info.isSymbolicLink()) throw new Error("Hook authority cannot use a symlink");
    // A configuration directory's unrelated state children are not policy.
    // Pin traversal/replacement/permissions; the actual known config files
    // below retain their complete identity, including timestamps and size.
    if (info.isDirectory()) return [path, info.dev, info.ino, info.mode].map(String);
    return [path, info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, "absent"];
    throw error;
  }
}

/**
 * Selection only. Never borrows Engine handlers or runs commands. Preserve the
 * existing settings/plugin matcher, disable, approval and priority contracts.
 */
export function prepareConfiguredToolHooks(options: {
  settings: SettingsManager;
  cwd: string;
  settingsScope: SettingsScope;
  disabledPlugins: string[];
  disabledPluginHooks: string[];
  toolName: string;
}) {
  const events = new Set<HookEventName>(TOOL_HOOK_EVENTS);
  const definitions = options.settings.get().hooks ?? [];
  const origins = options.settings.getHookOrigins();
  const plugins = listPluginHooksForHost(options.disabledPlugins);
  const descriptors: ConfiguredToolHook[] = [];
  for (const [index, hook] of definitions.entries()) {
    if (
      !hook.disabled &&
      events.has(hook.event as HookEventName) &&
      shellHookMatches(hook, {
        eventName: hook.event as HookEventName,
        data: { toolName: options.toolName },
      })
    )
      descriptors.push({
        id: `settings:${index}:${sha256(JSON.stringify(hook))}`,
        event: hook.event as HookEventName,
        protocol: "settings",
        priority: 50,
        command: hook.command,
        timeoutMs: Math.min(hook.timeout_ms ?? 60000, 60000),
        ...(hook.cwd === undefined ? {} : { cwd: hook.cwd }),
        ...(origins[index] === undefined ? {} : { source: origins[index] }),
      });
  }
  for (const [index, hook] of plugins.entries()) {
    if (
      hook.disabled ||
      options.disabledPluginHooks.includes(hook.key) ||
      !["approved", "legacy"].includes(hook.approval) ||
      !events.has(hook.event) ||
      !matcherAccepts(hook.event, hook.matcher, {
        eventName: hook.event,
        data: { toolName: options.toolName },
      })
    )
      continue;
    descriptors.push({
      id: `plugin:${index}:${sha256(JSON.stringify(hook))}`,
      event: hook.event,
      protocol: "plugin",
      priority: 80,
      command: hook.command,
      timeoutMs: Math.min(hook.timeoutMs ?? 60000, 60000),
      pluginInstallPath: hook.installPath,
      source: hook.source,
    });
  }
  const stateRoots = [
    ...(options.settingsScope === "full" ? [join(userHome(), ".code-shell")] : []),
    ...(options.settingsScope !== "isolated" ? [join(options.cwd, ".code-shell")] : []),
  ];
  const files = [
    ...stateRoots.flatMap((root) => [
      root,
      ...["settings", "settings.local", "settings.managed"].flatMap((name) =>
        ["json", "yaml", "yml"].map((extension) => join(root, `${name}.${extension}`)),
      ),
    ]),
    installedPluginsPath(),
    ...plugins.flatMap((hook) => [
      hook.installPath,
      join(hook.installPath, "hooks"),
      join(hook.installPath, "hooks", "hooks.json"),
    ]),
  ];
  return {
    descriptors,
    revision: sha256(
      JSON.stringify([
        definitions,
        plugins,
        options.disabledPlugins,
        options.disabledPluginHooks,
        [...new Set(files)].map(fileIdentity),
      ]),
    ),
  };
}

/**
 * A deliberately complete tiny grammar, not a general shell analyser. Literal
 * builtin output/exit needs no Host resources. Every other command requires a
 * complete explicit Host closure plan; sandbox denial alone is not proof that
 * an arbitrary policy script completed its intended external checks.
 */
export function isClosedInlineHook(command: string): boolean {
  return /^\s*(?::|exit (?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])|printf (?:'%s' )?'[^']*'(?:; ?exit (?:0|2))?)\s*$/.test(
    command,
  );
}
