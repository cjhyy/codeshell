import { resolvePanelAppBindingProjectPath } from "@cjhyy/code-shell-core";
import { panelExecutionProject, type PanelExecutionScope } from "./execution-gate.js";

export interface PanelPackageMutation {
  appId: string;
  projectPath: string;
  kind: "install" | "update" | "binding" | "remove";
}
/** A catalog install or update supersedes every project's pin, so it reaches every project. */
export function panelPackageMutationMatches(change: PanelPackageMutation) {
  const project = panelExecutionProject(resolvePanelAppBindingProjectPath(change.projectPath));
  return (scope: PanelExecutionScope): boolean => {
    if (scope.appId !== change.appId) return false;
    if (change.kind === "remove") return true;
    const bindingProject = resolvePanelAppBindingProjectPath(scope.projectPath);
    if (panelExecutionProject(bindingProject) === project) return true;
    return change.kind !== "binding";
  };
}
