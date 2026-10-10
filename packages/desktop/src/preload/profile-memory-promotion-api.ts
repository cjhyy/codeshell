import type { IpcRenderer } from "electron";
import type { ProfileMemoryPromotionApi } from "../shared/profile-memory-promotion.js";

export function createProfileMemoryPromotionApi(
  ipc: Pick<IpcRenderer, "invoke">,
): ProfileMemoryPromotionApi {
  return {
    previewProfileMemoryPromotion: (input) => ipc.invoke("memory:previewProfilePromotion", input),
    commitProfileMemoryPromotion: (input) => ipc.invoke("memory:commitProfilePromotion", input),
  };
}
