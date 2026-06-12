/**
 * Module-level snapshot cache for settings sub-pages.
 *
 * SettingsPage switches tabs by conditional rendering, so every sub-page
 * unmounts and remounts on each visit, re-fetches over IPC, and renders a
 * "加载中…" placeholder for a frame or two — the "settings page flashes on
 * every entry" feedback. Sub-pages stash their last successfully-loaded
 * snapshot here (keyed per page + scope); on remount they seed their state
 * from the snapshot synchronously (no placeholder) and refresh silently in
 * the background (stale-while-revalidate). Only the very first visit per app
 * run shows a loading placeholder.
 *
 * Pure in-memory — cleared on app restart. Values are stored by reference;
 * treat them as immutable snapshots (always cacheSet a fresh object, never
 * mutate a cached one).
 */
const cache = new Map<string, unknown>();

export function cacheGet<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function cacheSet(key: string, value: unknown): void {
  cache.set(key, value);
}
