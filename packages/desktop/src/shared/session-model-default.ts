/** A host model selection is an opaque, bounded key; routing belongs to the host. */
export function isSessionModelKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/** Read only the explicit cross-channel session preference, without a native fallback. */
export function sessionModelKeyFromSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const defaults = (settings as Record<string, unknown>).sessionDefaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return null;
  const model = (defaults as Record<string, unknown>).model;
  return isSessionModelKey(model) ? model : null;
}

/** New sessions retain the native connection default until a host preference is set. */
export function defaultSessionModelKeyFromSettings(settings: unknown): string | null {
  const selected = sessionModelKeyFromSettings(settings);
  if (selected) return selected;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const defaults = (settings as Record<string, unknown>).defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return null;
  const model = (defaults as Record<string, unknown>).text;
  return isSessionModelKey(model) ? model : null;
}

/** Resolve raw layers with the same nested inheritance/deletion rules as settings merge. */
export function defaultSessionModelKeyFromSettingsLayers(...layers: unknown[]): string | null {
  const resolve = (section: string, field: string): string | null => {
    let selected: string | null = null;
    for (const layer of layers) {
      if (!layer || typeof layer !== "object" || Array.isArray(layer)) continue;
      const value = (layer as Record<string, unknown>)[section];
      if (value === null) {
        selected = null;
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(record, field)) {
          selected = isSessionModelKey(record[field]) ? record[field] : null;
        }
      }
    }
    return selected;
  };
  return resolve("sessionDefaults", "model") ?? resolve("defaults", "text");
}

/** Null is the settings layer's deletion marker; it restores inherited/native behavior. */
export function sessionModelSettingsPatch(model: string | null): Record<string, unknown> {
  return { sessionDefaults: { model: isSessionModelKey(model) ? model : null } };
}
