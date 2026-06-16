/**
 * resolveSandboxConfig — pick the sandbox config for a run, reading the
 * 设置页's settings.sandbox so a project-scoped sandbox setting actually takes
 * effect. Priority: explicit config.sandbox → settings.sandbox.mode → per-run
 * default (headless=auto, REPL/desktop=off).
 *
 * Background: the engine previously only honored config.sandbox, which the
 * desktop host never passes — so a user enabling sandbox in 设置页 had no
 * effect. This bridges settings → run config.
 * See memory project_10_review_bug_list #9.
 */
import { defaultSandboxConfig, type SandboxConfig, type SandboxMode } from "../tool-system/sandbox/index.js";

/** The shape of settings.sandbox (all fields optional). */
export interface SettingsSandbox {
  mode?: SandboxMode;
  network?: "allow" | "deny";
  writableRoots?: string[];
  deniedReads?: string[];
}

export function resolveSandboxConfig(
  configSandbox: SandboxConfig | undefined,
  settingsSandbox: SettingsSandbox | undefined,
  headless: boolean,
): SandboxConfig {
  // 1. Explicit host-passed config wins.
  if (configSandbox) return configSandbox;

  // 2. settings.sandbox with an explicit mode — start from that mode's defaults
  // and overlay any fields the user set.
  if (settingsSandbox?.mode) {
    const base = defaultSandboxConfig(settingsSandbox.mode);
    return {
      mode: settingsSandbox.mode,
      network: settingsSandbox.network ?? base.network,
      writableRoots: settingsSandbox.writableRoots ?? base.writableRoots,
      deniedReads: settingsSandbox.deniedReads ?? base.deniedReads,
    };
  }

  // 3. Per-run default.
  return defaultSandboxConfig(headless ? "auto" : "off");
}
