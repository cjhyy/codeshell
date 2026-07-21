import { describe, expect, test } from "bun:test";
import {
  loadPetChatModelKey,
  savePetChatModelKey,
} from "./petPreferences";

function settingsBridge(seed?: unknown) {
  let settings: Record<string, unknown> = seed ? { pet: { chatModelKey: seed } } : {};
  return {
    getSettings: async () => settings,
    updateSettings: async (_scope: "user", patch: Record<string, unknown>) => {
      const petPatch = patch.pet as Record<string, unknown>;
      const nextKey = petPatch.chatModelKey;
      settings = nextKey === null ? {} : { pet: { chatModelKey: nextKey } };
    },
  };
}

describe("Pet model preference", () => {
  test("round-trips Mimi's model independently from the app default", async () => {
    const bridge = settingsBridge();
    await savePetChatModelKey("deepseek-v4-pro", bridge);
    expect(await loadPetChatModelKey(bridge)).toBe("deepseek-v4-pro");
    await savePetChatModelKey(null, bridge);
    expect(await loadPetChatModelKey(bridge)).toBeNull();
  });

  test("rejects malformed persisted keys", async () => {
    expect(await loadPetChatModelKey(settingsBridge("\u0000bad"))).toBeNull();
    expect(await loadPetChatModelKey(settingsBridge(" padded "))).toBeNull();
  });
});
