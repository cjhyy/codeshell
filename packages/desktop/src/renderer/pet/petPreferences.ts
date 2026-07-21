import {
  petChatModelKeyFromSettings,
  petChatModelSettingsPatch,
} from "../../shared/pet-settings";

export interface PetSettingsBridge {
  getSettings(scope: "user"): Promise<Record<string, unknown> | null>;
  updateSettings(scope: "user", patch: Record<string, unknown>): Promise<void>;
}

export async function loadPetChatModelKey(bridge: PetSettingsBridge): Promise<string | null> {
  return petChatModelKeyFromSettings(await bridge.getSettings("user"));
}

export async function savePetChatModelKey(
  modelKey: string | null,
  bridge: PetSettingsBridge,
): Promise<void> {
  await bridge.updateSettings("user", petChatModelSettingsPatch(modelKey));
}
