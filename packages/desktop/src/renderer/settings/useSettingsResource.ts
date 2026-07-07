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

/**
 * Run `cb` once on mount and again whenever config changes anywhere
 * (codeshell:files-changed / settings-changed). For pages whose load pulls
 * several pieces of state (so the single-resource useSettingsResource doesn't
 * fit) — they keep their own load() and just subscribe to refresh here, so the
 * listener wiring still lives in one place and can't be forgotten.
 */
export function useRefreshOnSettingsChange(cb: () => void, deps: unknown[] = []): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const fire = () => cbRef.current();
    fire(); // initial load + reload when `deps` change (e.g. scope/cwd/tag switch)
    window.addEventListener("codeshell:files-changed", fire);
    window.addEventListener("codeshell:settings-changed", fire);
    return () => {
      window.removeEventListener("codeshell:files-changed", fire);
      window.removeEventListener("codeshell:settings-changed", fire);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
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
  const requestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const requestIdRef = useRef(0);

  const reload = useCallback(() => {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const id = ++requestIdRef.current;
    requestRef.current = { id, controller };
    void (async () => {
      try {
        const next = await loaderRef.current();
        const active = requestRef.current;
        if (!active || active.id !== id || active.controller.signal.aborted) return;
        setData(next);
        cacheSet(cacheKey, next);
      } catch {
        // best-effort — keep the last good (cached) value on failure
      } finally {
        if (requestRef.current?.id === id) requestRef.current = null;
      }
    })();
    return () => {
      controller.abort();
      if (requestRef.current?.id === id) requestRef.current = null;
    };
  }, [cacheKey]);

  useEffect(() => {
    // Re-seed synchronously when the key changes (e.g. scope/cwd switch) so we
    // show that key's cached snapshot, not the previous key's, before reload.
    setData(seedValue(cacheKey, fallback));
    const cancel = reload();
    const onChange = () => {
      reload();
    };
    window.addEventListener("codeshell:files-changed", onChange);
    window.addEventListener("codeshell:settings-changed", onChange);
    return () => {
      cancel?.();
      requestRef.current?.controller.abort();
      requestRef.current = null;
      window.removeEventListener("codeshell:files-changed", onChange);
      window.removeEventListener("codeshell:settings-changed", onChange);
    };
    // fallback intentionally omitted from deps — it's an initial-seed default,
    // not a reactive input; including it would reload on every inline [] literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, reload]);

  return { data, reload };
}
