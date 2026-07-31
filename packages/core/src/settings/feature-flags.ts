/**
 * Feature Flags — a small, central on/off registry for opt-in or
 * experimental behavior.
 *
 * Design goals:
 *   - One source of truth for flag NAMES + their DEFAULT state, so a flag
 *     can't be checked under a typo (the known set is a const).
 *   - Settings-driven: `settings.featureFlags` is a `{ [name]: boolean }`
 *     overlay over the defaults. Project settings override user settings the
 *     same way every other settings field does (the SettingsManager merge),
 *     so a flag can be flipped per-workspace.
 *   - Forgiving read: `isFeatureEnabled` falls back to the default when a
 *     flag is absent from settings, and ignores unknown flag names from
 *     settings (forward-compat with older binaries).
 *
 * This is the knob layer only — each consumer still has to CHECK its flag.
 * The `/features` command (CLI) reads/writes this same map.
 */

/** Canonical flag names. Add new flags here so checks stay typo-safe. */
export const FEATURE_FLAGS = {
  /** Web search tool availability (also gated by a configured provider). */
  web_search: { default: true, description: "Enable the WebSearch tool" },
  /** The Bash/shell tool. Off → the model cannot run shell commands. */
  shell_tool: { default: true, description: "Enable the Bash/shell tool" },
  /** Fast-output mode for supported models. */
  fast_mode: { default: false, description: "Faster streaming output on supported models" },
  /** Undo system (file-operation backups + /undo). */
  undo: { default: false, description: "Per-session file undo (/undo)" },
  /** Shell snapshot: capture full stdout/stderr of commands. */
  shell_snapshot: { default: false, description: "Capture full command stdout/stderr snapshots" },
  /**
   * Run a session on an EXTERNAL Agent Runtime (Codex / Claude Code) instead of
   * the native Engine. Default off per §20: the native path must not depend on an
   * external binary being installed or logged in, and the fallback has to stay
   * one setting away.
   */
  external_agent_runtime: {
    default: false,
    description: "Allow a session to run on Codex or Claude Code instead of the native engine",
  },
  /**
   * Expose CodeShell Host Tools to an external runtime. Separate from the flag
   * above so the runtime can be trialled with NO tool surface at all — §20 asks
   * for exactly that split, because the tool bridge is the part that carries the
   * security burden.
   */
  external_host_tools: {
    default: false,
    description: "Expose allowlisted CodeShell tools to an external Agent Runtime",
  },
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

/** The settings overlay shape: a partial map of known flags → boolean. */
export type FeatureFlagOverrides = Partial<Record<FeatureFlagName, boolean>>;

/** All known flag names, for iteration (e.g. the /features listing). */
export function featureFlagNames(): FeatureFlagName[] {
  return Object.keys(FEATURE_FLAGS) as FeatureFlagName[];
}

/** True when `name` is a recognized flag (narrows an arbitrary string). */
export function isKnownFeatureFlag(name: string): name is FeatureFlagName {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, name);
}

/**
 * Resolve a flag's effective state: the settings overlay value when present
 * and boolean, else the flag's compiled-in default. Unknown names → false
 * (a check for a flag that doesn't exist is never "enabled").
 */
export function isFeatureEnabled(
  overrides: FeatureFlagOverrides | undefined,
  name: FeatureFlagName,
): boolean {
  const override = overrides?.[name];
  if (typeof override === "boolean") return override;
  return FEATURE_FLAGS[name].default;
}

/**
 * Resolve the full effective flag map (defaults merged with overrides).
 * Used by `/features` to show the current state of every flag.
 */
export function resolveFeatureFlags(
  overrides: FeatureFlagOverrides | undefined,
): Record<FeatureFlagName, boolean> {
  const out = {} as Record<FeatureFlagName, boolean>;
  for (const name of featureFlagNames()) {
    out[name] = isFeatureEnabled(overrides, name);
  }
  return out;
}
