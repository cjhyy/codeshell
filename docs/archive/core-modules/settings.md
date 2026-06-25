# settings

**One-line role.** Defines the settings schema and loads/validates `settings.json` from a layered disk hierarchy (managed → user → project → local → CLI flags), with deep merge, version migration, and the helpers that feed hot-reload.

## 职责 / Responsibility

This module owns the on-disk configuration contract for codeshell. It declares the Zod `SettingsSchema` (the single source of truth for shape + defaults), reads every settings layer from disk, deep-merges them by priority, and runs version-based migrations on load. It also exposes the small derived helpers other modules need — the feature-flag registry, the personalization slice, and the `diskDefaultsFrom` patch used by config hot-reload. Boundaries: it does NOT decide *when* to reload (the protocol server / engine do), and it does NOT resolve models, capabilities, or sandbox policy — it only supplies validated raw data that those modules interpret.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `schema.ts` | The Zod `SettingsSchema`, derived `ValidatedSettings` type, capability-override enums, and `validateSettings()` (applies defaults). Largest file; the shape contract. |
| `manager.ts` | `SettingsManager` class: layered disk load, deep merge, scoped reads/writes, atomic persist. Also `userHome()` and `noRepoDir()` path helpers. The main entry point. |
| `migrate-config.ts` | Version-stamped migration steps (`MIGRATIONS`) + `migrateConfig()`. Brings old `settings.json` files forward; pure and unit-testable. |
| `disk-defaults.ts` | `diskDefaultsFrom()` + `DiskDefaultPatch` — derives the subset of `EngineConfig` that config hot-reload ("layer 2") pushes onto running sessions. |
| `feature-flags.ts` | Central `FEATURE_FLAGS` registry + `isFeatureEnabled` / `resolveFeatureFlags`. The knob layer for opt-in behavior. |
| `personalization.ts` | `personalizationFrom()` + `PersonalizationConfig` — extracts the `agent.*` personalization fields so every host wires them identically. |

(There is no `index.ts`; consumers import submodules directly, e.g. `from "../settings/manager.js"`. The public re-exports live in `packages/core/src/index.ts`.)

## 公开接口 / Public API

```ts
// manager.ts
export type SettingsScope = "isolated" | "project" | "full";
export function userHome(): string;       // process.env.HOME ?? os.homedir() — env wins (Bun cache trap)
export function noRepoDir(): string;       // ~/.code-shell/no-repo (pure-chat cwd sentinel)

export class SettingsManager {
  constructor(cwd?: string, scope?: SettingsScope /* default "project" */);
  load(flagOverrides?: Record<string, unknown>): ValidatedSettings;  // re-read disk, re-merge
  get(): ValidatedSettings;                                          // cached; loads on first call
  invalidate(): void;                                                // drop merge cache
  saveUserSetting(key: string, value: unknown): void;                // dotted path → ~/.code-shell/settings.json
  saveProjectSetting(key: string, value: unknown, cwd: string): void;// dotted path → <cwd>/.code-shell/settings.json
  deleteProjectSetting(key: string, cwd: string): void;              // remove key = "inherit"
  getForScope(scope: "user" | "project", cwd?: string): Partial<ValidatedSettings>; // UNMERGED single layer
}

// schema.ts
export const SettingsSchema: ZodObject;
export type ValidatedSettings = z.infer<typeof SettingsSchema>;
export function validateSettings(raw: unknown): ValidatedSettings;
export type CapabilityOverride = "inherit" | "on" | "off";
export type CapabilityOverrides; // per-capability override map

// feature-flags.ts
export const FEATURE_FLAGS;                       // canonical { name: { default, description } }
export type FeatureFlagName;
export function isFeatureEnabled(overrides: FeatureFlagOverrides | undefined, name: FeatureFlagName): boolean;
export function resolveFeatureFlags(overrides: FeatureFlagOverrides | undefined): Record<FeatureFlagName, boolean>;

// disk-defaults.ts
export type DiskDefaultPatch; // Pick<EngineConfig, preset|customSystemPrompt|appendSystemPrompt|responseLanguage|userProfile|instructions|mcpServers>
export function diskDefaultsFrom(settings: ValidatedSettings, effectiveDisabledPlugins?: string[]): DiskDefaultPatch;

// personalization.ts
export interface PersonalizationConfig { responseLanguage?; userProfile?; instructions?; }
export function personalizationFrom(agent): PersonalizationConfig;

// migrate-config.ts
export function migrateConfig(input, migrations?): MigrateResult;
export function configVersionOf(config): number;
export const CURRENT_CONFIG_VERSION: number;
```

## 怎么用 / How to use

**1. Load settings at a host entrypoint (real call site: `cli/agent-server-stdio.ts`).** Hosts that should read the user's global `~/.code-shell` config construct with `"full"` scope; a per-session factory re-reads on each new session so settings edits take effect without restarting the worker:

```ts
import { SettingsManager } from "../settings/manager.js";

// Boot: full scope reads managed + user + project + local layers.
const settingsManager = new SettingsManager(cwd, "full");
const settings = settingsManager.get(); // cached ValidatedSettings

// Per new session — re-read disk, fall back to bootstrap snapshot if malformed.
function freshSettings() {
  try { return settingsManager.load(); }
  catch { return settings; }
}
```

**2. Push a disk-default patch onto already-running sessions on hot-reload (real call site: `protocol/server.ts`).** `diskDefaultsFrom` projects fresh settings into the exact `EngineConfig` slice the engine can hot-apply; the engine's `refreshRuntimeConfig` consumes it with a monotonic version to drop stale deliveries:

```ts
import { diskDefaultsFrom } from "../engine/engine.js"; // re-exported from settings/disk-defaults.js

const settings = settingsReader();
session.engine.refreshRuntimeConfig(
  diskDefaultsFrom(settings, session.engine.getEffectiveDisabledLists().disabledPlugins),
  reloadVersion,
);
```

**3. Gate behavior on a feature flag (pattern from `engine/engine.ts`).**

```ts
import { isFeatureEnabled } from "../settings/feature-flags.js";

const flags = settings.featureFlags; // FeatureFlagOverrides | undefined
if (isFeatureEnabled(flags, "web_search")) { /* register the WebSearch tool */ }
```

## 注意 / Gotchas

- **Default scope is `"project"`, not `"full"`.** A bare `new SettingsManager(cwd)` will NOT read the host's `~/.code-shell` (keys, models, MCP, hooks). Embedders get isolation by default; pass `"full"` explicitly to inherit the user dir. `"isolated"` reads no disk at all — only flag overrides.
- **Use `userHome()`, never `os.homedir()` directly.** On Bun/macOS `homedir()` caches the user DB at process start and ignores later `process.env.HOME` mutations — this is exactly how tests isolate `$HOME`. All path math in this module routes through `userHome()`.
- **`get()` is cached; mutations don't auto-refresh other managers.** `saveUserSetting`/`saveProjectSetting`/`deleteProjectSetting` call `invalidate()` on *that* instance, but a different `SettingsManager` instance holds its own cache. Call `load()`/`invalidate()` to pick up external writes.
- **`getForScope` returns the UNMERGED single layer** (only keys present in that file, defaults projected through `validateSettings` but absent keys omitted). It exists because the merged `get()` collapses provenance and can't express tri-state `inherit`/`on`/`off` capability math. Don't substitute `get()` where the project-vs-user distinction matters.
- **Writes are best-effort and defensive.** Loads silently skip malformed/corrupt JSON layers (rather than crash); writes are atomic (`.tmp` + rename); migrations write back only when content actually changed (a version-stamp-only diff is NOT persisted) and always leave a `.bak`. `saveProjectSetting` refuses to recreate a deleted project root.
- **`hooks` is the one array that concatenates across layers** (user + project both run), every other key is wholesale-replaced by higher-priority layers. An explicit `"hooks": null` resets everything below; `null` on any key deletes it during merge.
- **`diskDefaultsFrom` OVERRIDES per-request slice values** for the fields it covers — safe today because the desktop slice only carries `permissionMode`+`cwd` (both excluded from the patch). A future host setting any patched field per-request must exclude it from the reload patch or it will be clobbered.
- **No `index.ts` barrel.** Import submodules directly (`from "../settings/manager.js"`); the curated public surface is re-exported through `packages/core/src/index.ts`. Note `migrate-models` (legacy `models[]` migration) lives one level up at `../migrate-models.js`, not in this module, to avoid an import cycle with `manager.ts`.
- **Core is compiled — rebuild after edits.** TUI/CLI dist imports and many tests run against built output; changes here need a `core` rebuild before downstream consumers see them.
