/** Native observers only need to know which projections to refresh. */
export interface SettingsChange {
  panelApps: boolean;
  git: boolean;
  pet: boolean;
  externalVisibility: boolean;
  pluginCommands: boolean;
}
const flags: readonly (keyof SettingsChange)[] = [
  "panelApps",
  "git",
  "pet",
  "externalVisibility",
  "pluginCommands",
];
export function isSettingsChange(value: unknown): value is SettingsChange {
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value).length === flags.length &&
    flags.every(
      (flag) =>
        Object.hasOwn(value, flag) && typeof (value as Record<string, unknown>)[flag] === "boolean",
    )
  );
}
