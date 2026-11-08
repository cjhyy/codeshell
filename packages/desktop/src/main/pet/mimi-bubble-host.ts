import type { IpcMain } from "electron";
import type { MimiCompanionAttention, MimiCompanionRect } from "../../shared/mimi-companion.js";
import type { MimiBubblePanel, MimiPresenceSnapshot } from "../../shared/mimi-presence.js";
import { createPetBubbleSurface, type PetBubbleSurfaceOptions } from "./pet-bubble-surface.js";

export interface MimiBubbleHostOptions extends Omit<PetBubbleSurfaceOptions, "onReleased"> {
  ipcMain: Pick<IpcMain, "on">;
  /** The moving character, when computer use composed one. */
  companion(): { setAttention(attention: MimiCompanionAttention | undefined): void } | undefined;
  /** The full Mimi page: the fallback, and one click away from the bubble. */
  openOverview(request?: { prompt: string }): Promise<void>;
}

/**
 * One Mimi, one chat. While moving is the form the user wants, the docked
 * widget's chat and work list live in a bubble beside the character, and the
 * bubble's work counts become the badge over her head.
 */
export function createMimiBubbleHost(options: MimiBubbleHostOptions) {
  const surface = createPetBubbleSurface({
    ...options,
    onReleased: () => options.companion()?.setAttention(undefined),
  });
  options.ipcMain.on("pet:bubble-attention", (event, attention: unknown) => {
    if (!surface.owns(event.sender.id) || !attention || typeof attention !== "object") return;
    options.companion()?.setAttention(attention as MimiCompanionAttention);
  });
  options.ipcMain.on("pet:bubble-interactive", (event, interactive: unknown) => {
    if (!surface.owns(event.sender.id) || typeof interactive !== "boolean") return;
    surface.setInteractive(interactive);
  });
  return {
    surface,
    /** The bubble exists exactly while moving is the form the user wants shown. */
    sync(snapshot: MimiPresenceSnapshot): void {
      if (snapshot.visible && snapshot.effectiveMode === "moving") {
        void surface.prepare().catch((error) => {
          options.log?.("pet-bubble.prepare.failed", { error: String(error) });
        });
      } else surface.release();
    },
    async open(
      panel: MimiBubblePanel,
      near?: MimiCompanionRect,
      prompt?: string,
      send?: boolean,
    ): Promise<void> {
      if (surface.active()) {
        try {
          await surface.open(panel, near, prompt, send);
          return;
        } catch (error) {
          options.log?.("pet-bubble.open.failed", { panel, error: String(error) });
        }
      }
      await options.openOverview(prompt ? { prompt } : undefined);
    },
  };
}

export type MimiBubbleHost = ReturnType<typeof createMimiBubbleHost>;
