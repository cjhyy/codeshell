import type { ModelTraceListQuery } from "@cjhyy/code-shell-core/internal";

/** Project-owned Panel work is visible from an authorized worktree, never root chats. */
export function createDesktopModelTraceScopeResolver(authority: {
  resolveBindingProjectPath: (cwd: string) => string;
  resolveWorkspace: (input: string | undefined, deviceId: string) => Promise<string | undefined>;
}) {
  return async (cwd: string, deviceId: string): Promise<ModelTraceListQuery["workspaceScopes"]> => {
    try {
      const projectPath = authority.resolveBindingProjectPath(cwd);
      if (
        projectPath === cwd ||
        (await authority.resolveWorkspace(projectPath, deviceId)) !== projectPath
      )
        return undefined;
      return [{ workspacePath: projectPath, sourcePrefix: "panel:" }];
    } catch {
      // The current workspace remains readable when related authority is unavailable.
      return undefined;
    }
  };
}
