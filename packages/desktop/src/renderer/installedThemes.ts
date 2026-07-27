import type { InstalledThemePack } from "../shared/theme-packs";
import { getThemePack, type ThemePack } from "./theme-packs";

/**
 * Renderer-side cache of installed theme packs (loaded from main via
 * window.codeshell.listInstalledThemes). Kept as a module-level snapshot so the
 * synchronous pack resolver used by applyThemePack / usePetSprite can see
 * installed packs without an async read on the hot path. `refreshInstalledThemes`
 * repopulates it (on boot and on the themes:changed event).
 */
let installed: InstalledThemePack[] = [];

// Subscribers re-render when the cache changes. This is what lets a hook like
// useActiveThemePack pick up the *first* async load: initTheme calls
// refreshInstalledThemes() on boot, which fires no window/themes:changed event,
// so without this a component rendered before the load finishes would resolve an
// installed active pack to the builtin default and never update.
const listeners = new Set<() => void>();

function notifyInstalledChanged(): void {
  for (const cb of [...listeners]) cb();
}

/** Subscribe to installed-cache changes; returns an unsubscribe fn. */
export function subscribeInstalledThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function toThemePack(pack: InstalledThemePack): ThemePack {
  return {
    id: pack.id,
    name: pack.name,
    swatch: pack.swatch,
    colors: pack.colors,
    ...(pack.pet ? { pet: pack.pet } : {}),
    ...(pack.wallpaper ? { wallpaper: pack.wallpaper } : {}),
    source: "installed",
  };
}

/** Resolve an id against installed packs first, then the builtin table. */
export function resolveThemePack(id: string): ThemePack {
  const hit = installed.find((pack) => pack.id === id);
  return hit ? toThemePack(hit) : getThemePack(id);
}

/** All packs the picker should show: builtin table first, then installed. */
export function installedThemePacks(): ThemePack[] {
  return installed.map(toThemePack);
}

/** Load installed packs from main and cache them; safe if the API is absent. */
export async function refreshInstalledThemes(): Promise<void> {
  const api = globalThis.window?.codeshell as
    | { listInstalledThemes?: () => Promise<InstalledThemePack[]> }
    | undefined;
  if (!api?.listInstalledThemes) return;
  try {
    installed = await api.listInstalledThemes();
  } catch {
    installed = [];
  }
  notifyInstalledChanged();
}

/** Test seam. */
export function __setInstalledThemes(packs: InstalledThemePack[]): void {
  installed = packs;
  notifyInstalledChanged();
}
