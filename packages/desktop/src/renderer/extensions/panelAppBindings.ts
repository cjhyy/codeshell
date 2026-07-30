/**
 * Pure helpers for the cross-project Panel App binding list.
 *
 * The renderer imports no `@cjhyy/code-shell-core`, so the binding semantics
 * from `core/src/panel-apps/bindings.ts` (`resolvePanelAppBindingPolicy` +
 * `isPanelAppBound`) are mirrored here over raw settings objects read via
 * `window.codeshell.getSettings("project", path)`. Keep the two in sync:
 * an app counts as bound when the project lists it in `panelAppBindings`,
 * with legacy `panelAppOverrides` "on"/"off" entries applied on top, and the
 * user-level `disabledPanelApps` denylist still able to veto.
 *
 * Reading raw settings per project (rather than calling the main-process
 * `listPanelAppExtensions` once per project) is deliberate: that call
 * re-hashes every installed app's files, so N projects would cost N full
 * catalog scans on the main process.
 */

/** Minimal project shape this module needs; satisfied by TrackedProject. */
export interface BindingProject {
  id: string;
  path: string;
  addedAt: number;
  pinned?: boolean;
}

/** Raw project settings object, or null when the file is absent/unreadable. */
export type ProjectSettingsMap = Record<string, Record<string, unknown> | null>;

export interface ProjectBindingRow {
  projectId: string;
  projectPath: string;
  /** Effective state: bound by the project and not vetoed globally. */
  bound: boolean;
  /**
   * True when the project binds the app but the legacy user-level denylist
   * vetoes it. The global switch has no UI anymore, so this only appears for
   * settings written before it was removed, or hand-edited files.
   */
  vetoedByGlobalDenylist: boolean;
  /** The project's settings could not be read (missing dir, bad JSON, IPC error). */
  unreadable: boolean;
}

export interface ProjectBindingSummary {
  rows: ProjectBindingRow[];
  /** Rows whose effective state is bound. */
  boundCount: number;
  /** Total rows, i.e. tracked project count. */
  total: number;
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter(
          (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
        )
      : [],
  );
}

/**
 * Apps a single project binds, mirroring core's `resolvePanelAppBindingPolicy`:
 * `panelAppBindings` plus legacy `panelAppOverrides` "on", minus "off".
 */
export function boundAppsForProject(settings: Record<string, unknown> | null): Set<string> {
  if (!settings) return new Set();
  const bound = stringSet(settings.panelAppBindings);
  const overrides =
    settings.panelAppOverrides &&
    typeof settings.panelAppOverrides === "object" &&
    !Array.isArray(settings.panelAppOverrides)
      ? (settings.panelAppOverrides as Record<string, unknown>)
      : {};
  for (const [id, value] of Object.entries(overrides)) {
    if (value === "on") bound.add(id);
    else if (value === "off") bound.delete(id);
  }
  return bound;
}

/**
 * Pinned projects first, then oldest-added first. Mirrors `sortProjects`
 * (renderer/repos.ts `sortRepos`) so the binding list matches sidebar order.
 */
export function sortBindingProjects<T extends BindingProject>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => {
    const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinnedDelta !== 0) return pinnedDelta;
    return a.addedAt - b.addedAt;
  });
}

/**
 * Per-project binding state for one app across every tracked project.
 *
 * `settingsByPath` maps project path to its raw settings; a `null` value means
 * the settings could not be read, which is reported as `unreadable` rather
 * than silently folded into "not bound" — a permissions error and an explicit
 * opt-out must not look identical. A path missing from the map entirely is
 * treated as readable-but-empty (no settings file is the normal initial state).
 */
export function computeProjectBindings(
  projects: readonly BindingProject[],
  settingsByPath: ProjectSettingsMap,
  appId: string,
  globalDisabledApps: ReadonlySet<string> = new Set(),
): ProjectBindingSummary {
  const vetoed = globalDisabledApps.has(appId);
  const rows = sortBindingProjects(projects).map((project) => {
    const hasEntry = Object.prototype.hasOwnProperty.call(settingsByPath, project.path);
    const settings = hasEntry ? settingsByPath[project.path]! : {};
    const unreadable = hasEntry && settingsByPath[project.path] === null;
    const declared = boundAppsForProject(unreadable ? null : settings).has(appId);
    return {
      projectId: project.id,
      projectPath: project.path,
      bound: declared && !vetoed,
      vetoedByGlobalDenylist: declared && vetoed,
      unreadable,
    };
  });
  return {
    rows,
    boundCount: rows.filter((row) => row.bound).length,
    total: rows.length,
  };
}

/** Stable key for per-row busy tracking: one app in one project. */
export function bindingBusyKey(appId: string, projectPath: string): string {
  return `${appId}@${projectPath}`;
}

/**
 * The legacy `panelAppOverrides` map with `appId` retired, keeping only valid
 * tri-state entries for other apps.
 *
 * Callers must write this whole map rather than patching `{[appId]: null}`:
 * main's `deepMerge` only treats null as a delete when the key already exists
 * in the target, so on a project with no `panelAppOverrides` the null was
 * persisted verbatim. The settings schema then rejected the file, and
 * `panelAppPolicy` fails closed on a parse error — silently unbinding every
 * Panel App in that project.
 */
export function withoutLegacyOverride(
  value: unknown,
  appId: string,
): Record<string, "inherit" | "on" | "off"> {
  const out: Record<string, "inherit" | "on" | "off"> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === appId) continue;
    if (entry === "inherit" || entry === "on" || entry === "off") out[key] = entry;
  }
  return out;
}
