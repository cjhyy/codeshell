import {
  petChatModelKeyFromSettings,
  petMemoryAutoExtractFromSettings,
} from "../../shared/pet-settings.js";
import { sessionModelKeyFromSettings } from "../../shared/session-model-default.js";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import { isPersistedExternalRuntime } from "../mobile-remote/external-runtime-commands.js";

/** Neither an external default nor an actual external turn authorizes native aux spend. */
export function allowNativePetExtraction(
  settings: unknown,
  actualManager: { provider?: string; model?: string } | undefined,
): boolean {
  const configured = petChatModelKeyFromSettings(settings) ?? sessionModelKeyFromSettings(settings);
  return (
    !parseExternalRuntimeModelKey(configured) &&
    !isPersistedExternalRuntime(actualManager) &&
    petMemoryAutoExtractFromSettings(settings)
  );
}
