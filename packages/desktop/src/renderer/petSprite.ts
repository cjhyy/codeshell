import React from "react";
import dogIcon from "./assets/codeshell-dog-icon.png";
import { loadThemePackId } from "./theme";
import { resolveThemePack } from "./installedThemes";
import {
  DEFAULT_PACK_ID,
  petVisualState,
  type PetSprites,
  type PetSpriteState,
  type ThemePack,
} from "./theme-packs";

/** The bundled default pet image, used whenever a pack supplies no sprite. */
export const DEFAULT_PET_SPRITE = dogIcon;

/**
 * The default pack's own sprites. Kept here (not in the pure theme-packs data)
 * because it references a bundled asset url. The default dog is thus delivered
 * as a real builtin pack's sprites — the same path every other pack uses —
 * rather than a special fallback. Drop frame urls into `walk` to make the
 * default dog run while dragged (assets go in ./assets and are imported here).
 */
const DEFAULT_PET_SPRITES: PetSprites = {
  idle: dogIcon,
  walk: [],
};

/** The pet sprites a pack effectively provides (the default pack gets the dog). */
function effectivePetSprites(pack: ThemePack): PetSprites {
  if (pack.id === DEFAULT_PACK_ID && !pack.pet) return DEFAULT_PET_SPRITES;
  return pack.pet ?? {};
}

/**
 * The pet image url for a pack + state, falling back to idle then to the default
 * dog when the pack supplies no sprite for that state. Pure and window-agnostic.
 */
export function petSpriteUrl(pack: ThemePack, state: PetSpriteState): string {
  const sprites = effectivePetSprites(pack);
  return sprites[state] ?? sprites.idle ?? DEFAULT_PET_SPRITE;
}

/** A pack's walk frames (non-empty urls only); empty when it supplies none. */
export function petWalkFrames(pack: ThemePack): string[] {
  return (effectivePetSprites(pack).walk ?? []).filter(
    (url) => typeof url === "string" && url.length > 0,
  );
}

/**
 * Track the active theme pack in the renderer. Re-reads on the cross-window
 * `storage` event that theme.ts uses for pack changes, so switching packs (even
 * from another window, e.g. settings while the widget is open) updates live.
 * `resolvePack` is injected so installed packs (loaded via IPC in a later phase)
 * can be resolved too; it defaults to the builtin table.
 */
export function useActiveThemePack(
  resolvePack: (id: string) => ThemePack = resolveThemePack,
): ThemePack {
  const [id, setId] = React.useState<string>(() => loadThemePackId());
  const [, bump] = React.useState(0);
  React.useEffect(() => {
    const reread = (): void => setId(loadThemePackId());
    const onStorage = (event: StorageEvent): void => {
      if (event.key === "codeshell.theme-pack") reread();
    };
    window.addEventListener("storage", onStorage);
    // A same-window pack switch does not emit `storage`; AppearanceSection
    // dispatches this custom event so the picker's own window updates too.
    window.addEventListener("codeshell:theme-pack-changed", reread);
    // An install/uninstall keeps the id but changes what it resolves to.
    const shell = globalThis.window?.codeshell as
      | { onThemesChanged?: (cb: () => void) => () => void }
      | undefined;
    const off = shell?.onThemesChanged?.(() => bump((n) => n + 1));
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("codeshell:theme-pack-changed", reread);
      off?.();
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

/** ms per walk frame while dragging (~8fps reads as a lively trot). */
const WALK_FRAME_MS = 120;

/**
 * The pet sprite for the widget: normally the state sprite, but while
 * `dragging` and the pack has walk frames, cycle those frames to animate a
 * "run". Falls back to the state sprite when the pack has no walk frames, so a
 * plain pack (or the default dog before walk frames are added) is unaffected.
 */
export function usePetWidgetSprite(
  state: PetSpriteState,
  dragging: boolean,
  resolvePack?: (id: string) => ThemePack,
): string {
  const pack = useActiveThemePack(resolvePack);
  const frames = petWalkFrames(pack);
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    if (!dragging || frames.length < 2) {
      setFrame(0);
      return;
    }
    const id = setInterval(() => setFrame((n) => (n + 1) % frames.length), WALK_FRAME_MS);
    return () => clearInterval(id);
  }, [dragging, frames.length]);

  if (dragging && frames.length > 0) return frames[frame % frames.length]!;
  return petSpriteUrl(pack, state);
}

export { petVisualState };
