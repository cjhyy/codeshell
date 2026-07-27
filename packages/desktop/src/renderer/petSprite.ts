import React from "react";
import dogIcon from "./assets/codeshell-dog-icon.png";
// Looping mood animations sliced from the Codex v2 atlas (see slice-atlas.py).
import animIdle from "./assets/mimi-papillon/anim-idle.webp";
import animRunning from "./assets/mimi-papillon/anim-running.webp";
import animReview from "./assets/mimi-papillon/anim-review.webp";
import animWaving from "./assets/mimi-papillon/anim-waving.webp";
import animJumping from "./assets/mimi-papillon/anim-jumping.webp";
import animWaiting from "./assets/mimi-papillon/anim-waiting.webp";
import animFailed from "./assets/mimi-papillon/anim-failed.webp";
// Directional drag frames (cycled per-frame in code so we can pick direction).
import runRight1 from "./assets/mimi-papillon/run-right-1.png";
import runRight2 from "./assets/mimi-papillon/run-right-2.png";
import runRight3 from "./assets/mimi-papillon/run-right-3.png";
import runRight4 from "./assets/mimi-papillon/run-right-4.png";
import runRight5 from "./assets/mimi-papillon/run-right-5.png";
import runRight6 from "./assets/mimi-papillon/run-right-6.png";
import runRight7 from "./assets/mimi-papillon/run-right-7.png";
import runRight8 from "./assets/mimi-papillon/run-right-8.png";
import runLeft1 from "./assets/mimi-papillon/run-left-1.png";
import runLeft2 from "./assets/mimi-papillon/run-left-2.png";
import runLeft3 from "./assets/mimi-papillon/run-left-3.png";
import runLeft4 from "./assets/mimi-papillon/run-left-4.png";
import runLeft5 from "./assets/mimi-papillon/run-left-5.png";
import runLeft6 from "./assets/mimi-papillon/run-left-6.png";
import runLeft7 from "./assets/mimi-papillon/run-left-7.png";
import runLeft8 from "./assets/mimi-papillon/run-left-8.png";
import { loadThemePackId } from "./theme";
import { resolveThemePack, subscribeInstalledThemes } from "./installedThemes";
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
 * The default pack's sprites, drawn from the Codex v2 Mimi atlas. Kept here (not
 * in the pure theme-packs data) because it references bundled asset urls. The
 * default dog is thus delivered as a real builtin pack — the same path every
 * other pack uses. `alert` maps to the atlas's "review" (ready/completed) mood.
 */
const DEFAULT_PET_SPRITES: PetSprites = {
  idle: animIdle,
  running: animRunning,
  alert: animReview,
  waving: animWaving,
  jumping: animJumping,
  waiting: animWaiting,
  failed: animFailed,
  walk: [runRight1, runRight2, runRight3, runRight4, runRight5, runRight6, runRight7, runRight8],
  walkLeft: [runLeft1, runLeft2, runLeft3, runLeft4, runLeft5, runLeft6, runLeft7, runLeft8],
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
