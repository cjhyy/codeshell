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
