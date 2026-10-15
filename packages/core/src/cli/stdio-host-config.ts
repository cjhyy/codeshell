/**
 * Read only the spawning Host's declaration, before project settings/env load.
 * Headless hosts leave this unset and use Core's persisted workspace fallback.
 */
export function hasWorkspaceHostBridge(env: NodeJS.ProcessEnv): boolean {
  return env.CODE_SHELL_WORKSPACE_ACCESS === "host";
}
