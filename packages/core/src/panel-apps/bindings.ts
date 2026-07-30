import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface PanelAppBindingPolicy {
  /** Panel Apps are unavailable without a concrete project. */
  hasProject: boolean;
  /** Apps explicitly bound by this project's settings. */
  boundApps: ReadonlySet<string>;
  /** User-level emergency/master disable switch. */
  globalDisabledApps: ReadonlySet<string>;
}

/**
 * Resolve a session/worktree cwd back to the project whose Panel App bindings
 * it owns. Git worktrees point at `<project>/.git/worktrees/<name>` from their
 * `.git` file; normal repositories and non-git projects use their own root.
 */
export function resolvePanelAppBindingProjectPath(cwd: string): string {
  if (typeof cwd !== "string" || cwd.trim().length === 0) return "";
  let current = resolve(cwd);
  while (true) {
    const gitEntry = join(current, ".git");
    if (existsSync(gitEntry)) {
      try {
        if (statSync(gitEntry).isDirectory()) return current;
        const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(gitEntry, "utf8"));
        if (!match) return current;
        const gitDir = resolve(current, match[1]!);
        const marker = `${sep}.git${sep}worktrees${sep}`;
        const markerIndex = gitDir.lastIndexOf(marker);
        return markerIndex >= 0 ? gitDir.slice(0, markerIndex) : current;
      } catch {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
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
 * Resolve the one policy shared by Desktop discovery and Skill scanning.
 *
 * Installed Panel Apps are a global catalog, but they contribute no UI, tools,
 * Skills, or storage to a project until that project explicitly binds them.
 * Legacy `panelAppOverrides.on` entries count as an explicit binding so
 * projects that already opted in do not silently lose their app.
 */
export function resolvePanelAppBindingPolicy(
  userSettings: Record<string, unknown> | undefined,
  projectSettings: Record<string, unknown> | undefined,
  hasProject: boolean,
): PanelAppBindingPolicy {
  const globalDisabledApps = stringSet(userSettings?.disabledPanelApps);
  const boundApps = hasProject ? stringSet(projectSettings?.panelAppBindings) : new Set<string>();
  const legacyOverrides =
    projectSettings?.panelAppOverrides &&
    typeof projectSettings.panelAppOverrides === "object" &&
    !Array.isArray(projectSettings.panelAppOverrides)
      ? (projectSettings.panelAppOverrides as Record<string, unknown>)
      : {};

  if (hasProject) {
    for (const [id, value] of Object.entries(legacyOverrides)) {
      if (value === "on") boundApps.add(id);
      else if (value === "off") boundApps.delete(id);
    }
  }

  return { hasProject, boundApps, globalDisabledApps };
}

export function isPanelAppBound(appId: string, policy: PanelAppBindingPolicy): boolean {
  return policy.hasProject && policy.boundApps.has(appId) && !policy.globalDisabledApps.has(appId);
}
