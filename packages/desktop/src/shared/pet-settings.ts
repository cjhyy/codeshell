import { isSessionModelKey } from "./session-model-default.js";

export const PET_CHAT_MODEL_SETTING = "chatModelKey";

/**
 * Mimi's explicit override uses the same model-key contract as ordinary
 * sessions, including external runtimes supported by the desktop host.
 */
export function isPetChatModelKey(value: unknown): value is string {
  return isSessionModelKey(value);
}

export function petChatModelKeyFromSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const pet = (settings as Record<string, unknown>).pet;
  if (!pet || typeof pet !== "object" || Array.isArray(pet)) return null;
  const value = (pet as Record<string, unknown>)[PET_CHAT_MODEL_SETTING];
  return isPetChatModelKey(value) ? value : null;
}

export function petChatModelSettingsPatch(modelKey: string | null): Record<string, unknown> {
  return {
    pet: { [PET_CHAT_MODEL_SETTING]: isPetChatModelKey(modelKey) ? modelKey : null },
  };
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

export const PET_DELEGATED_PERMISSION_SETTING = "delegatedPermissionMode";

/**
 * Permission mode for Work Sessions Mimi delegates:
 *   - inherit: the owner's default permission mode for new Sessions (plan → ask)
 *   - auto:    engine auto mode; low-risk calls run, anything else fails without asking
 *   - ask:     always the default mode; anything needing approval waits for the owner
 */
export const PET_DELEGATED_PERMISSION_MODES = ["inherit", "auto", "ask"] as const;
export type PetDelegatedPermissionSetting = (typeof PET_DELEGATED_PERMISSION_MODES)[number];

/** Engine permission modes a delegated native Work Session may run with. */
export type PetDelegatedEnginePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "auto";

function petSettingsRecord(settings: unknown): Record<string, unknown> | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const pet = (settings as Record<string, unknown>).pet;
  return pet && typeof pet === "object" && !Array.isArray(pet)
    ? (pet as Record<string, unknown>)
    : null;
}

/** Missing or unrecognized values mean "inherit". */
export function petDelegatedPermissionFromSettings(
  settings: unknown,
): PetDelegatedPermissionSetting {
  const value = petSettingsRecord(settings)?.[PET_DELEGATED_PERMISSION_SETTING];
  return (PET_DELEGATED_PERMISSION_MODES as readonly unknown[]).includes(value)
    ? (value as PetDelegatedPermissionSetting)
    : "inherit";
}

export function petDelegatedPermissionSettingsPatch(
  mode: PetDelegatedPermissionSetting,
): Record<string, unknown> {
  return { pet: { [PET_DELEGATED_PERMISSION_SETTING]: mode } };
}

function configuredPermissionMode(settings: Record<string, unknown> | null): unknown {
  if (!settings) return undefined;
  const permissions = settings.permissions;
  const defaultMode =
    permissions && typeof permissions === "object" && !Array.isArray(permissions)
      ? (permissions as Record<string, unknown>).defaultMode
      : undefined;
  return settings.permissionMode ?? defaultMode;
}

/**
 * The owner's default Session permission mode in engine spelling. Mirrors the
 * renderer's composer default (project layer over user layer; the desktop
 * spellings `accept_edits`/`bypass` and legacy `auto`/`goal` → default), except
 * that plan becomes default: a read-only plan run cannot do delegated work.
 */
export function inheritedDelegatedPermissionMode(layers: {
  user: Record<string, unknown> | null;
  project?: Record<string, unknown> | null;
}): PetDelegatedEnginePermissionMode {
  // Same shallow merge as the renderer's `{ ...userS, ...projectS }`.
  switch (configuredPermissionMode({ ...layers.user, ...layers.project })) {
    case "accept_edits":
    case "acceptEdits":
      return "acceptEdits";
    case "bypass":
    case "bypassPermissions":
      return "bypassPermissions";
    default:
      return "default";
  }
}

/** Resolve the delegated Work Session mode from the user (and trusted project) layers. */
export function resolvePetDelegatedPermissionMode(layers: {
  user: Record<string, unknown> | null;
  project?: Record<string, unknown> | null;
}): PetDelegatedEnginePermissionMode {
  switch (petDelegatedPermissionFromSettings(layers.user)) {
    case "auto":
      return "auto";
    case "ask":
      return "default";
    default:
      return inheritedDelegatedPermissionMode(layers);
  }
}
