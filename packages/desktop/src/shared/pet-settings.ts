export const PET_CHAT_MODEL_SETTING = "chatModelKey";

function validModelKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function petChatModelKeyFromSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const pet = (settings as Record<string, unknown>).pet;
  if (!pet || typeof pet !== "object" || Array.isArray(pet)) return null;
  const value = (pet as Record<string, unknown>)[PET_CHAT_MODEL_SETTING];
  return validModelKey(value) ? value : null;
}

export function petChatModelSettingsPatch(modelKey: string | null): Record<string, unknown> {
  return { pet: { [PET_CHAT_MODEL_SETTING]: modelKey } };
}

export const PET_MEMORY_AUTO_EXTRACT_SETTING = "memoryAutoExtract";

/** Auto-extraction defaults ON; only an explicit `false` disables it. */
export function petMemoryAutoExtractFromSettings(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return true;
  const pet = (settings as Record<string, unknown>).pet;
  if (!pet || typeof pet !== "object" || Array.isArray(pet)) return true;
  return (pet as Record<string, unknown>)[PET_MEMORY_AUTO_EXTRACT_SETTING] !== false;
}

export function petMemoryAutoExtractSettingsPatch(enabled: boolean): Record<string, unknown> {
  return { pet: { [PET_MEMORY_AUTO_EXTRACT_SETTING]: enabled } };
}
