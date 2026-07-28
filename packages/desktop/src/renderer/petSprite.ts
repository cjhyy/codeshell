import React from "react";
import dogIcon from "./assets/codeshell-dog-icon.png";
import { loadThemePackId } from "./theme";
import { resolveThemePack, subscribeInstalledThemes } from "./installedThemes";
import {
  petVisualState,
  type PetSprites,
  type PetSpriteState,
  type ThemePack,
} from "./theme-packs";

/**
 * The bundled default pet image: the original static dog-head icon. The default
 * pack ships NO sprites of its own, so every state (and the drag) resolves to
 * this single still image — Mimi is a calm static icon by default. Animated /
 * multi-state pets come from an installed theme pack, not the builtin default.
 * (The Codex "mimi-papillon" atlas frames stay in assets for such a pack.)
 */
export const DEFAULT_PET_SPRITE = dogIcon;

/** The pet sprites a pack effectively provides; the default pack provides none. */
function effectivePetSprites(pack: ThemePack): PetSprites {
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

/** Whether a pack provides any pet art (a static default pack provides none). */
export function hasPetSprites(pack: ThemePack): boolean {
  const sprites = effectivePetSprites(pack);
  return Object.values(sprites).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)));
}

/** Horizontal drag direction; "left" uses walkLeft frames when a pack has them. */
export type WalkDirection = "left" | "right";

/**
 * A pack's drag frames for a direction (non-empty urls only). Leftward drags use
 * `walkLeft` and fall back to `walk` when the pack supplies only one set.
 */
export function petWalkFrames(pack: ThemePack, direction: WalkDirection = "right"): string[] {
  const sprites = effectivePetSprites(pack);
  const frames = direction === "left" ? (sprites.walkLeft ?? sprites.walk) : sprites.walk;
  return (frames ?? []).filter((url) => typeof url === "string" && url.length > 0);
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
    // The initial async load of installed packs (initTheme → refreshInstalledThemes)
    // fires no window event; subscribe so an active *installed* pack's sprites
    // replace the first-frame builtin fallback once the cache populates.
    const offInstalled = subscribeInstalledThemes(() => bump((n) => n + 1));
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("codeshell:theme-pack-changed", reread);
      off?.();
      offInstalled();
    };
  }, []);
  return resolvePack(id);
}

/** True when the active pack is animated (has pet art); false for the static default. */
export function useHasPetSprites(): boolean {
  return hasPetSprites(useActiveThemePack());
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
 * `dragging` cycle the pack's directional walk frames to animate a run
 * (leftward drags use walkLeft when present). Falls back to the state sprite
 * when the pack has no walk frames, so a plain pack is unaffected.
 */
export function usePetWidgetSprite(
  state: PetSpriteState,
  dragging: boolean,
  direction: WalkDirection = "right",
  resolvePack?: (id: string) => ThemePack,
): string {
  const pack = useActiveThemePack(resolvePack);
  const frames = petWalkFrames(pack, direction);
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    if (!dragging || frames.length < 2) {
      setFrame(0);
      return;
    }
    const id = setInterval(() => setFrame((n) => (n + 1) % frames.length), WALK_FRAME_MS);
    return () => clearInterval(id);
    // Restart the loop when direction flips (frame set changes) or drag toggles.
  }, [dragging, direction, frames.length]);

  if (dragging && frames.length > 0) return frames[frame % frames.length]!;
  return petSpriteUrl(pack, state);
}

export { petVisualState };
