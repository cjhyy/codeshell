import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfiguredToolHook } from "../hooks/configured-tool-hooks.js";
import { installedPluginsPath } from "../plugins/installedPlugins.js";
import { listPluginHooksForHost, type PluginHookSource } from "../plugins/loadPluginHooks.js";
import {
  assertSettingsHookOriginCurrent,
  assertSettingsHookOriginMetadataCurrent,
  type SettingsHookOrigin,
} from "../settings/hook-provenance.js";

function identity(path: string): string {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink()) throw new Error("Hook source custody is unsafe");
  if (info.isDirectory()) return [info.dev, info.ino, info.mode].map(String).join(":");
  if (!info.isFile() || info.nlink !== 1n) throw new Error("Hook source custody is unsafe");
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.nlink]
    .map(String)
    .join(":");
}

export function sourceMatches(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | undefined,
): boolean {
  return (
    actual !== undefined && Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

/** Shared native custody only. No review owner/signal/SettingsManager is retained. */
export function createHookSourceCustody(hook: Readonly<ConfiguredToolHook>): () => void {
  if (!hook.source) throw new Error("Hook source provenance unavailable");
  const source = structuredClone(hook.source);
  if (source.kind === "settings") {
    assertSettingsHookOriginCurrent(source as SettingsHookOrigin);
    return () => assertSettingsHookOriginMetadataCurrent(source as SettingsHookOrigin);
  }
  const plugin = source as PluginHookSource;
  if (!plugin.custody) throw new Error("Plugin Hook source provenance unavailable");
  if (realpathSync(plugin.installPath) !== plugin.installPath)
    throw new Error("Hook installation is not canonical");
  const paths = new Set([
    installedPluginsPath(),
    plugin.installPath,
    join(plugin.installPath, "hooks"),
    join(plugin.installPath, "hooks", "hooks.json"),
  ]);
  for (const path of [...paths]) {
    let parent = dirname(path);
    while (true) {
      paths.add(parent);
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  const pins = [...paths].map((path) => ({ path, identity: identity(path) }));
  const assertCurrent = () => {
    for (const pin of pins)
      if (identity(pin.path) !== pin.identity) throw new Error("Hook source custody changed");
  };
  assertCurrent();
  const { custody, ...expectedSource } = plugin;
  const matches = listPluginHooksForHost().filter(
    (item) =>
      item.event === hook.event &&
      item.command === hook.command &&
      sourceMatches(
        expectedSource as unknown as Record<string, unknown>,
        item.source as unknown as Record<string, unknown>,
      ) &&
      item.source.custody?.registryIdentity === custody!.registryIdentity &&
      item.source.custody?.hooksIdentity === custody!.hooksIdentity,
  );
  if (matches.length !== 1) throw new Error("Hook installation identity changed");
  // The initial bounded RAW registry/definition proof above is immutable.
  // Every callback retains its complete file/parent identity. Fresh review
  // policy loads separately parse current approval/selection on each check.
  assertCurrent();
  return assertCurrent;
}
