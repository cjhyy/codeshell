import React from "react";
import dogIcon from "./assets/codeshell-dog-icon.png";
import { loadThemePackId } from "./theme";
import { getThemePack, petVisualState, type PetSpriteState, type ThemePack } from "./theme-packs";

/** The bundled default pet image, used whenever a pack supplies no sprite. */
export const DEFAULT_PET_SPRITE = dogIcon;

/**
 * The pet image url for a pack + state, falling back to the default dog when the
 * pack supplies no sprite for that state (and then for `idle`). Pure so it is
 * trivially testable and identical across windows.
 */
export function petSpriteUrl(pack: ThemePack, state: PetSpriteState): string {
  return pack.pet?.[state] ?? pack.pet?.idle ?? DEFAULT_PET_SPRITE;
}

/**
 * Track the active theme pack in the renderer. Re-reads on the cross-window
 * `storage` event that theme.ts uses for pack changes, so switching packs (even
 * from another window, e.g. settings while the widget is open) updates live.
 * `resolvePack` is injected so installed packs (loaded via IPC in a later phase)
 * can be resolved too; it defaults to the builtin table.
 */
export function useActiveThemePack(
  resolvePack: (id: string) => ThemePack = getThemePack,
): ThemePack {
  const [id, setId] = React.useState<string>(() => loadThemePackId());
  React.useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === "codeshell.theme-pack") setId(loadThemePackId());
    };
    window.addEventListener("storage", onStorage);
    // A same-window pack switch does not emit `storage`; AppearanceSection
    // dispatches this custom event so the picker's own window updates too.
    const onLocal = (): void => setId(loadThemePackId());
    window.addEventListener("codeshell:theme-pack-changed", onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("codeshell:theme-pack-changed", onLocal);
    };
  }, []);
  return resolvePack(id);
}

/**
 * The pet sprite url for the current pack and a given visual state (default
 * `idle` for the static avatars that have no live state).
 */
export function usePetSprite(
  state: PetSpriteState = "idle",
  resolvePack?: (id: string) => ThemePack,
): string {
  const pack = useActiveThemePack(resolvePack);
  return petSpriteUrl(pack, state);
}

export { petVisualState };
