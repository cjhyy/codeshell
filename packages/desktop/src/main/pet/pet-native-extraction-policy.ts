import {
  petChatModelKeyFromSettings,
  petMemoryAutoExtractFromSettings,
} from "../../shared/pet-settings.js";
import { defaultSessionModelKeyFromSettings } from "../../shared/session-model-default.js";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import { isPersistedExternalRuntime } from "../mobile-remote/external-runtime-commands.js";

/** Neither an external default nor an actual external turn authorizes native aux spend. */
export function allowNativePetAuxiliary(
  settings: unknown,
  actualManager?: { provider?: string; model?: string },
): boolean {
  const configured =
    petChatModelKeyFromSettings(settings) ?? defaultSessionModelKeyFromSettings(settings);
  return !parseExternalRuntimeModelKey(configured) && !isPersistedExternalRuntime(actualManager);
}

export function allowNativePetExtraction(
  settings: unknown,
  actualManager?: { provider?: string; model?: string },
): boolean {
  return (
    allowNativePetAuxiliary(settings, actualManager) && petMemoryAutoExtractFromSettings(settings)
  );
}
