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

export interface PetPersonalization {
  /** Language Mimi should normally use when replying. */
  responseLanguage?: string;
  /** How Mimi should address the owner and stable background she should know. */
  userProfile?: string;
  /** Mimi-only tone, voice, and communication style. */
  communicationStyle?: string;
  /** Additional standing instructions that apply only to Mimi manager turns. */
  customInstructions?: string;
}

const PET_PERSONALIZATION_LIMITS = {
  responseLanguage: 120,
  userProfile: 2_000,
  communicationStyle: 2_000,
  customInstructions: 6_000,
} as const;

function boundedSettingText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, limit);
}

/**
 * Read Mimi-only personalization from the user settings layer. Keeping this
 * under `pet.personalization` prevents the ordinary `agent.*` Session settings
 * from silently changing Mimi's manager voice (and vice versa).
 */
export function petPersonalizationFromSettings(settings: unknown): PetPersonalization {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const pet = (settings as Record<string, unknown>).pet;
  if (!pet || typeof pet !== "object" || Array.isArray(pet)) return {};
  const personalization = (pet as Record<string, unknown>).personalization;
  if (!personalization || typeof personalization !== "object" || Array.isArray(personalization)) {
    return {};
  }
  const raw = personalization as Record<string, unknown>;
  return {
    responseLanguage: boundedSettingText(
      raw.responseLanguage,
      PET_PERSONALIZATION_LIMITS.responseLanguage,
    ),
    userProfile: boundedSettingText(raw.userProfile, PET_PERSONALIZATION_LIMITS.userProfile),
    communicationStyle: boundedSettingText(
      raw.communicationStyle,
      PET_PERSONALIZATION_LIMITS.communicationStyle,
    ),
    customInstructions: boundedSettingText(
      raw.customInstructions,
      PET_PERSONALIZATION_LIMITS.customInstructions,
    ),
  };
}

export function petPersonalizationSettingsPatch(
  personalization: PetPersonalization,
): Record<string, unknown> {
  return { pet: { personalization } };
}
