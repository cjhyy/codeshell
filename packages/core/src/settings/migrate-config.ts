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
 * Registered migrations, in ascending `from` order. EMPTY for now — the schema
 * is at version 0 and no breaking migration has shipped yet. New breaking
 * changes append a step here and bump CURRENT_CONFIG_VERSION. Example:
 *   { from: 0, to: 1, migrate: (c) => ({ ...c, renamedKey: c.oldKey }) }
 */
export const MIGRATIONS: readonly MigrationStep[] = [];

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
