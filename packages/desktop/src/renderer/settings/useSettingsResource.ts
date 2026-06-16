/**
 * useSettingsResource — one hook for reading a settings/catalog resource that
 * must (a) not flash a loading placeholder and (b) auto-refresh when config
 * changes anywhere (the EditModelCatalog tool, a settings save, another panel).
 *
 * Before this, every settings sub-page hand-rolled: useState(cacheGet) +
 * useEffect(load + cacheSet) + manually addEventListener('codeshell:files-changed'
 * & 'settings-changed') + cleanup. The manual listeners were forgotten on most
 * pages → "改完不刷新". Folding the listeners into one hook makes forgetting
 * impossible: any page using this hook auto-follows refresh.
 *
 * - seed: synchronously from settingsCache (no placeholder), else fallback.
 * - load: runs `loader`, stores into state + settingsCache (stale-while-revalidate).
 * - refresh: re-runs `loader` on codeshell:files-changed / settings-changed.
 *
 * `loader` should be stable (wrap in useCallback) or change only when its inputs
 * (scope/cwd) do — the hook reloads when the loader identity changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cacheGet, cacheSet } from "./settingsCache";

/** Pure seed: cached snapshot if present, else fallback. Testable without DOM. */
export function seedValue<T>(cacheKey: string, fallback: T | undefined): T | undefined {
  const cached = cacheGet<T>(cacheKey);
  return cached !== undefined ? cached : fallback;
}

export function useSettingsResource<T>(
  cacheKey: string,
  loader: () => Promise<T>,
  opts?: { fallback?: T },
): { data: T | undefined; reload: () => void } {
  const fallback = opts?.fallback;
  const [data, setData] = useState<T | undefined>(() => seedValue(cacheKey, fallback));
  // Keep the latest loader without making `reload` change identity every render.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await loaderRef.current();
        if (cancelled) return;
        setData(next);
        cacheSet(cacheKey, next);
      } catch {
        // best-effort — keep the last good (cached) value on failure
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  useEffect(() => {
    // Re-seed synchronously when the key changes (e.g. scope/cwd switch) so we
    // show that key's cached snapshot, not the previous key's, before reload.
    setData(seedValue(cacheKey, fallback));
    const cancel = reload();
    const onChange = () => reload();
    window.addEventListener("codeshell:files-changed", onChange);
    window.addEventListener("codeshell:settings-changed", onChange);
    return () => {
      cancel?.();
      window.removeEventListener("codeshell:files-changed", onChange);
      window.removeEventListener("codeshell:settings-changed", onChange);
    };
    // fallback intentionally omitted from deps — it's an initial-seed default,
    // not a reactive input; including it would reload on every inline [] literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, reload]);

  return { data, reload };
}
