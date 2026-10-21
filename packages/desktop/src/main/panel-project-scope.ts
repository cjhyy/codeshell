import { realpathSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome, resolvePanelAppBindingProjectPath } from "@cjhyy/code-shell-core";
import {
  capturePanelProjectScope,
  createHubPanelBinding,
  type PanelProjectScopeBinding,
} from "@cjhyy/code-shell-server/panels";
import type { ProjectStore } from "./project-store.js";

type PanelProjectRegistry = Pick<
  ProjectStore,
  "resolveExactRootSync" | "resolveProjectRootByIdSync"
>;

/**
 * Main's registry proves `rootPath` is a mounted root of the project registered
 * at `projectPath`. A Session may legally move between a project's roots.
 */
export function isRegisteredPanelProjectRoot(
  store: Pick<ProjectStore, "resolveExactRootSync">,
  projectPath: string,
  rootPath: string,
): boolean {
  try {
    const bound = store.resolveExactRootSync(projectPath);
    return !!bound && store.resolveExactRootSync(rootPath)?.project.id === bound.project.id;
  } catch {
    return false;
  }
}

/** Panels of a registered root belong to its project, bound at the primary root like native. */
export function resolveDesktopPanelProjectPath(store: PanelProjectRegistry, cwd: string): string {
  const mount = resolvePanelAppBindingProjectPath(cwd);
  try {
    const root = store.resolveExactRootSync(mount);
    if (!root || root.mainRoot.id === root.project.primaryRootId) return mount;
    return store.resolveProjectRootByIdSync(root.project.id).cwd;
  } catch {
    return mount;
  }
}

/** Native and paired Web use the same registry, environment, and execution-root inputs. */
export function createDesktopPanelProjectScopeResolver(options: {
  environmentDir?: string;
  store: PanelProjectRegistry;
}) {
  const environmentDir = options.environmentDir ?? join(codeShellHome(), "desktop");
  return async (
    projectPath: string,
    cwd: string,
  ): Promise<PanelProjectScopeBinding | undefined> => {
    const selected = options.store.resolveExactRootSync(projectPath);
    if (!selected) return undefined; // Legacy/unregistered workspaces receive no stable identity.
    const projectId = selected.project.id;
    const boundRootId = selected.mainRoot.id;
    const topology = createHubPanelBinding(cwd);
    topology.assertBinding();
    // Identity stays with the project; execution follows the Session's registered root.
    const execution = options.store.resolveExactRootSync(topology.bindingCwd);
    if (execution?.project.id !== projectId)
      throw new Error("Panel execution root is outside its registered project");
    const rootId = execution.mainRoot.id;
    const assertAuthority = () => {
      topology.assertBinding();
      for (const [path, id] of [
        [projectPath, boundRootId],
        [topology.bindingCwd, rootId],
      ]) {
        const exact = options.store.resolveExactRootSync(path);
        const current = options.store.resolveProjectRootByIdSync(projectId, id);
        if (
          exact?.project.id !== projectId ||
          exact.mainRoot.id !== id ||
          current.project.id !== projectId ||
          current.mainRoot.id !== id ||
          realpathSync(current.cwd) !== realpathSync(path)
        )
          throw new Error("Panel registered project identity changed");
      }
    };
    assertAuthority();
    return capturePanelProjectScope({
      environmentDir,
      projectPath,
      cwd,
      projectId,
      rootId,
      assertAuthority,
    });
  };
}
