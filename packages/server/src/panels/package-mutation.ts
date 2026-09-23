import {
  projectPanelAppPackagePins,
  resolvePanelAppBindingProjectPath,
} from "@cjhyy/code-shell-core";
import { panelExecutionProject, type PanelExecutionScope } from "./execution-gate.js";

export interface PanelPackageMutation {
  appId: string;
  projectPath: string;
  kind: "install" | "update" | "binding" | "remove";
}
/** Pinned projects retain their bytes when a different project updates the catalog. */
export function panelPackageMutationMatches(change: PanelPackageMutation) {
  const project = panelExecutionProject(resolvePanelAppBindingProjectPath(change.projectPath));
  return (scope: PanelExecutionScope): boolean => {
    if (scope.appId !== change.appId) return false;
    if (change.kind === "remove") return true;
    const bindingProject = resolvePanelAppBindingProjectPath(scope.projectPath);
    if (panelExecutionProject(bindingProject) === project) return true;
    if (change.kind === "binding") return false;
    try {
      return !projectPanelAppPackagePins(bindingProject)[change.appId];
    } catch {
      return true;
    } // An unreadable project cannot prove that it is insulated.
  };
}
