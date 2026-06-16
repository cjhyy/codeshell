/**
 * Version-based settings migration (TODO 8.5).
 *
 * A settings file carries an optional `configVersion` number. As the schema
 * evolves, breaking shape changes register a migration step here; on load we
 * apply every step whose `from` is >= the file's current version, in order,
 * bringing the object up to CURRENT_CONFIG_VERSION. Pure + ordered so it's
 * deterministic and unit-testable; the SettingsManager wires the result to a
 * write-back (with a .bak) the same way the existing models[] migration does.
 *
 * Files with no `configVersion` are treated as version 0 (pre-versioning).
 * A file already at CURRENT is a no-op (changed:false).
 */

import { BUILTIN_CATALOG } from "../model-catalog/builtin.js";

export const CONFIG_VERSION_KEY = "configVersion";

export interface MigrationStep {
  /** Apply this step to a config at exactly this version. */
  from: number;
  /** Version the config is at after this step runs. */
  to: number;
  /** Transform the raw config object (must not mutate the input). */
  migrate: (config: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * v0 → v1: backfill `catalogId` on imageGen/videoGen `providers[]` entries
 * written before the model catalog existed (Catalog v1). Legacy entries only
 * carry `kind`; the connections UI resolves its template by `catalogId`, so
 * without it the model-preset dropdown degrades to an empty text box. The
 * match mirrors the renderer's legacy fallback: builtin entry whose
 * `adapterKind === kind` within the section's tag. Unmatched entries are left
 * untouched (the UI shows a manual-input hint for those).
 */
function backfillGenCatalogIds(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  for (const [key, tag] of [
    ["imageGen", "image"],
    ["videoGen", "video"],
  ] as const) {
    const gen = next[key];
    if (!gen || typeof gen !== "object" || Array.isArray(gen)) continue;
    const providers = (gen as Record<string, unknown>).providers;
    if (!Array.isArray(providers)) continue;
    let touched = false;
    const out = providers.map((p) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) return p;
      const rec = p as Record<string, unknown>;
      if (typeof rec.catalogId === "string") return p;
      const entry = BUILTIN_CATALOG.find((e) => e.adapterKind === rec.kind && e.tag === tag);
      if (!entry) return p;
      touched = true;
      return { ...rec, catalogId: entry.id };
    });
    if (touched) next[key] = { ...(gen as Record<string, unknown>), providers: out };
  }
  return next;
}

/**
 * v1 → v2: drop the sandbox config the 设置页 mis-wrote. The local-env page
 * used to write `sandbox:{mode:"auto", network:"allow", writableRoots:[],
 * deniedReads:[]}` (its display default) on every save — opting users into a
 * sandbox they never chose. That exact fingerprint = not a real choice, so we
 * remove the whole sandbox field (→ follow/off). A user who actually configured
 * it (changed mode/network or set roots/reads) is left untouched.
 */
function clearMisWrittenSandboxAuto(config: Record<string, unknown>): Record<string, unknown> {
  const sb = config.sandbox;
  if (!sb || typeof sb !== "object" || Array.isArray(sb)) return config;
  const s = sb as Record<string, unknown>;
  const isMisWritten =
    s.mode === "auto" &&
    s.network === "allow" &&
    Array.isArray(s.writableRoots) && s.writableRoots.length === 0 &&
    Array.isArray(s.deniedReads) && s.deniedReads.length === 0;
  if (!isMisWritten) return config;
  const next = { ...config };
  delete next.sandbox;
  return next;
}

/**
 * Registered migrations, in ascending `from` order. New breaking changes
 * append a step here; CURRENT_CONFIG_VERSION follows automatically.
 */
export const MIGRATIONS: readonly MigrationStep[] = [
  { from: 0, to: 1, migrate: backfillGenCatalogIds },
  { from: 1, to: 2, migrate: clearMisWrittenSandboxAuto },
];

/** The version a freshly-written config is stamped with. */
export const CURRENT_CONFIG_VERSION = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.to),
  0,
);

/** Read the config's version, defaulting to 0 for pre-versioning files. */
export function configVersionOf(config: Record<string, unknown>): number {
  const v = config[CONFIG_VERSION_KEY];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export interface MigrateResult {
  config: Record<string, unknown>;
  changed: boolean;
  fromVersion: number;
  toVersion: number;
}

/**
 * Bring a raw config up to CURRENT_CONFIG_VERSION by applying each registered
 * step whose `from` matches the running version, in order. Always stamps the
 * resulting (and an already-current) config with the current version key.
 * `changed` is true when any step ran OR the version stamp was added/updated.
 * Never mutates the input.
 */
export function migrateConfig(
  input: Record<string, unknown>,
  migrations: readonly MigrationStep[] = MIGRATIONS,
): MigrateResult {
  const target = migrations.reduce((max, m) => Math.max(max, m.to), 0);
  const fromVersion = configVersionOf(input);
  let config: Record<string, unknown> = { ...input };
  let v = fromVersion;
  let stepsRan = false;

  // Apply steps deterministically: for the current version, find the matching
  // step, run it, advance. A migration list with gaps simply stops when no
  // step matches the running version.
  for (;;) {
    const step = migrations.find((m) => m.from === v);
    if (!step) break;
    config = { ...step.migrate(config) };
    v = step.to;
    stepsRan = true;
  }

  const alreadyStamped = input[CONFIG_VERSION_KEY] === target;
  config[CONFIG_VERSION_KEY] = target;

  return {
    config,
    changed: stepsRan || !alreadyStamped,
    fromVersion,
    toVersion: target,
  };
}
