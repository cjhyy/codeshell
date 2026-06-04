/**
 * Project picker model for the automation detail view.
 *
 * An automation job runs in a `cwd` (the project path) or with no project at
 * all (empty/absent cwd → the sidebar-bottom "对话" section). The detail panel
 * lets the user re-point a job at a different project; the options come from
 * the user's tracked repos plus a "无项目" choice.
 *
 * shadcn <Select> forbids an empty-string item value, so "no project" is
 * represented by the NO_PROJECT_VALUE sentinel in the control and mapped back
 * to an empty cwd on save. If the job's current cwd isn't among the tracked
 * repos (e.g. a path added by another machine, or a since-removed project), we
 * append a synthetic option so the current value stays visible and selectable.
 */

export interface ProjectRepo {
  id: string;
  path: string;
  /** Sidebar display name — `displayName` overrides `name`. */
  name: string;
  displayName?: string;
}

export interface ProjectOption {
  /** <Select> item value: a repo path, or the no-project sentinel. */
  value: string;
  /** Human label shown in the dropdown. */
  label: string;
}

/** Sentinel value for the "无项目" option (shadcn Select disallows ""). */
export const NO_PROJECT_VALUE = "__no_project__";

const NO_PROJECT_LABEL = "无项目(对话)";

function repoLabel(repo: ProjectRepo): string {
  return repo.displayName?.trim() || repo.name;
}

/**
 * Build the dropdown options for a job's current cwd.
 *
 * Order: 无项目 first, then tracked repos (input order preserved), then — only
 * when the current cwd is a non-empty path absent from the repo list — a
 * trailing synthetic entry so the active selection never silently vanishes.
 */
export function buildProjectOptions(
  repos: ProjectRepo[],
  currentCwd: string | null | undefined,
): ProjectOption[] {
  const out: ProjectOption[] = [{ value: NO_PROJECT_VALUE, label: NO_PROJECT_LABEL }];
  const seen = new Set<string>();
  for (const repo of repos) {
    if (!repo.path || seen.has(repo.path)) continue;
    seen.add(repo.path);
    out.push({ value: repo.path, label: repoLabel(repo) });
  }
  const cwd = currentCwd?.trim();
  if (cwd && !seen.has(cwd)) {
    out.push({ value: cwd, label: cwd });
  }
  return out;
}

/** Map a job's stored cwd to the matching <Select> value. */
export function selectedProjectValue(currentCwd: string | null | undefined): string {
  const cwd = currentCwd?.trim();
  return cwd ? cwd : NO_PROJECT_VALUE;
}

/**
 * Map a chosen <Select> value back to the cwd to persist. The no-project
 * sentinel becomes "" (cleared cwd); any other value is the project path.
 */
export function cwdFromSelection(value: string): string {
  return value === NO_PROJECT_VALUE ? "" : value;
}
