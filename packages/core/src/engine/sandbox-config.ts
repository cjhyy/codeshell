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

/**
 * Three-layer resolve. Priority:
 *   1. config.sandbox — explicit host-passed.
 *   2. project settings.sandbox (has mode) — overrides global.
 *   3. global settings.sandbox (has mode) — what a project "follows".
 *   4. per-run default: headless → auto, desktop/REPL → off.
 *
 * A layer without `mode` is "unset / 跟随上一层" — pass unmerged per-scope
 * values so a project that wrote nothing genuinely follows global (a merged
 * value would make every project look like it set global's mode).
 */
export function resolveSandboxConfig(
  configSandbox: SandboxConfig | undefined,
  projectSandbox: SettingsSandbox | undefined,
  globalSandbox: SettingsSandbox | undefined,
  headless: boolean,
): SandboxConfig {
  if (configSandbox) return configSandbox;

  const layer = projectSandbox?.mode ? projectSandbox : globalSandbox?.mode ? globalSandbox : undefined;
  if (layer?.mode) {
    const base = defaultSandboxConfig(layer.mode);
    return {
      mode: layer.mode,
      network: layer.network ?? base.network,
      writableRoots: layer.writableRoots ?? base.writableRoots,
      deniedReads: layer.deniedReads ?? base.deniedReads,
    };
  }

  return defaultSandboxConfig(headless ? "auto" : "off");
}
