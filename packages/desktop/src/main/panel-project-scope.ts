import { realpathSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import {
  capturePanelProjectScope,
  createHubPanelBinding,
  type PanelProjectScopeBinding,
} from "@cjhyy/code-shell-server/panels";
import type { ProjectStore } from "./project-store.js";

/** Native and paired Web use the same registry, environment, and execution-root inputs. */
export function createDesktopPanelProjectScopeResolver(options: {
  environmentDir?: string;
  store: Pick<ProjectStore, "resolveExactRootSync" | "resolveProjectRootByIdSync">;
}) {
  const environmentDir = options.environmentDir ?? join(codeShellHome(), "desktop");
  return async (
    projectPath: string,
    cwd: string,
  ): Promise<PanelProjectScopeBinding | undefined> => {
    const selected = options.store.resolveExactRootSync(projectPath);
    if (!selected) return undefined; // Legacy/unregistered workspaces receive no stable identity.
    const projectId = selected.project.id;
    const rootId = selected.mainRoot.id;
    const topology = createHubPanelBinding(cwd);
    const assertAuthority = () => {
      topology.assertBinding();
      if (realpathSync(topology.bindingCwd) !== realpathSync(projectPath))
        throw new Error("Panel execution root is outside its registered project");
      const exact = options.store.resolveExactRootSync(projectPath);
      const current = options.store.resolveProjectRootByIdSync(projectId, rootId);
      if (
        exact?.project.id !== projectId ||
        exact.mainRoot.id !== rootId ||
        current.project.id !== projectId ||
        current.mainRoot.id !== rootId ||
        realpathSync(current.cwd) !== realpathSync(projectPath)
      )
        throw new Error("Panel registered project identity changed");
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
