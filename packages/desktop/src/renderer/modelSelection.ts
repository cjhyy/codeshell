type SettingsScope = "user" | "project";

export interface PersistDefaultTextModelArgs {
  key: string;
  getSettings: (scope: "user") => Promise<Record<string, unknown> | null | undefined>;
  writeSettings: (scope: SettingsScope, patch: Record<string, unknown>) => Promise<void>;
}

export async function persistDefaultTextModel({
  key,
  getSettings,
  writeSettings,
}: PersistDefaultTextModelArgs): Promise<void> {
  const userS = ((await getSettings("user")) ?? {}) as Record<string, unknown>;
  const defaults = userS.defaults && typeof userS.defaults === "object"
    ? (userS.defaults as Record<string, unknown>)
    : {};
  await writeSettings("user", {
    defaults: { ...defaults, text: key },
  });
}
