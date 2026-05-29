/**
 * Settings change broadcast.
 *
 * The worker (agent-server-stdio) keeps its own SettingsManager
 * instance; without an explicit reload it ignores edits the user
 * makes through the settings page. The "codeshell:settings-changed"
 * event is App.tsx's signal to dispatch configure({reloadModels:
 * true}) at the worker. Every successful settings write must fire
 * the event — historically callers forgot, which is exactly the
 * "project-level settings 不生效" bug from TODO-week.md #3.
 *
 * This helper centralises the dispatch so call sites just go through
 * `writeSettings(...)` and don't have to remember.
 */

export function notifySettingsChanged(): void {
  window.dispatchEvent(new Event("codeshell:settings-changed"));
}

export async function writeSettings(
  scope: "user" | "project",
  patch: Record<string, unknown>,
  cwd?: string,
): Promise<void> {
  await window.codeshell.updateSettings(scope, patch, cwd);
  notifySettingsChanged();
}
