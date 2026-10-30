import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelAppDescriptor } from "../../shared/panel-apps";
import { replacePanelApps } from "../panels/PanelRegistry";
import type { PanelCatalogState } from "../panels/PanelCatalogContext";

interface CatalogSnapshot {
  descriptors: PanelAppDescriptor[];
  boundProjectPathsByAppId: Record<string, string[]>;
}

type CatalogApi = Partial<
  Pick<typeof window.codeshell, "listPanelApps" | "listPanelAppsForProjects" | "onPanelAppsChanged">
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeSnapshots(snapshots: CatalogSnapshot[]): CatalogSnapshot {
  const variants = new Map<string, PanelAppDescriptor>();
  const bindings: Record<string, string[]> = {};
  for (const snapshot of snapshots) {
    for (const descriptor of snapshot.descriptors) {
      const advertised = snapshot.boundProjectPathsByAppId[descriptor.appId] ?? [];
      // Capture each variant's scope before merging the per-app binding map:
      // two projects may intentionally select different versions of one app.
      const paths = descriptor.projectPaths
        ? descriptor.projectPaths.filter((path) => advertised.includes(path))
        : advertised;
      const existing = variants.get(descriptor.hostId);
      variants.set(descriptor.hostId, {
        ...descriptor,
        projectPaths: [...new Set([...(existing?.projectPaths ?? []), ...paths])],
      });
      bindings[descriptor.appId] = [...new Set([...(bindings[descriptor.appId] ?? []), ...paths])];
    }
  }
  return { descriptors: [...variants.values()], boundProjectPathsByAppId: bindings };
}

async function readProject(
  api: CatalogApi,
  projectPath: string,
  locale: string,
): Promise<CatalogSnapshot> {
  if (api.listPanelAppsForProjects) return api.listPanelAppsForProjects([projectPath], locale);
  const descriptors = await api.listPanelApps!(projectPath, locale);
  // Legacy hosts return an already authorized single-project list, without a
  // binding map. Record that exact scope rather than passing an empty deny map.
  return {
    descriptors: descriptors.map((descriptor) => ({ ...descriptor, projectPaths: [projectPath] })),
    boundProjectPathsByAppId: Object.fromEntries(
      descriptors.map((descriptor) => [descriptor.appId, [projectPath]]),
    ),
  };
}

/** Load every tracked project's authorized variants without one failed path hiding the rest. */
export function usePanelAppCatalog({
  projectPaths,
  activeProjectPath,
  locale,
}: {
  projectPaths: readonly string[];
  activeProjectPath: string | null;
  locale: string;
}): PanelCatalogState {
  const pathsKey = JSON.stringify(
    [...new Set([...projectPaths, ...(activeProjectPath ? [activeProjectPath] : [])])]
      .filter(Boolean)
      .sort(),
  );
  const generation = useRef(0);
  const refreshRef = useRef<() => void>(() => {});
  const errorRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const [state, setState] = useState({
    loading: true,
    refreshing: false,
    error: null as string | null,
  });
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let changedWhileLoading = false;
    const paths = JSON.parse(pathsKey) as string[];
    const api = window.codeshell as CatalogApi | undefined;
    const run = async () => {
      const request = ++generation.current;
      if (!alive) return;
      // Re-reading a healthy catalog keeps it on screen: a full host read can
      // take seconds, and swapping the list for a loading row made it jump.
      if (loadedRef.current && !errorRef.current)
        setState((previous) => ({ ...previous, refreshing: true }));
      else {
        errorRef.current = null;
        setState({ loading: true, refreshing: false, error: null });
      }
      const current = () => alive && generation.current === request;
      const publish = (snapshot: CatalogSnapshot, error: string | null = null) => {
        if (!current()) return;
        replacePanelApps(snapshot.descriptors, null, snapshot.boundProjectPathsByAppId);
        loadedRef.current = true;
        errorRef.current = error;
        setState({ loading: false, refreshing: false, error });
      };
      const empty: CatalogSnapshot = { descriptors: [], boundProjectPathsByAppId: {} };
      if (!api?.listPanelAppsForProjects && !api?.listPanelApps) {
        publish(
          empty,
          "Panel App catalog is unavailable. Restart or update CodeShell, then retry.",
        );
        return;
      }
      if (paths.length === 0) {
        publish(empty);
        return;
      }
      if (api.listPanelAppsForProjects) {
        try {
          const snapshot = await api.listPanelAppsForProjects(paths, locale);
          publish(snapshot);
          return;
        } catch {
          if (!current()) return;
          // A stale/unmounted project can reject the batch authorization. Each
          // fallback request still crosses the same Main authorization boundary.
        }
      }
      const results = await Promise.allSettled(paths.map((path) => readProject(api, path, locale)));
      const snapshots: CatalogSnapshot[] = [];
      const failures: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") snapshots.push(result.value);
        else failures.push(`${paths[index]}: ${errorMessage(result.reason)}`);
      });
      publish(mergeSnapshots(snapshots), failures.length ? failures.join("\n") : null);
    };
    const start = () => {
      if (!alive || inFlight) return;
      inFlight = true;
      void run()
        .catch((error) => {
          if (!alive) return;
          replacePanelApps([], null, {});
          const message = errorMessage(error);
          errorRef.current = message;
          setState({ loading: false, refreshing: false, error: message });
        })
        .finally(() => {
          inFlight = false;
          if (alive && changedWhileLoading) {
            changedWhileLoading = false;
            start();
          }
        });
    };
    const onChanged = () => {
      if (inFlight) changedWhileLoading = true;
      else start();
    };
    const onFocus = () => {
      if (errorRef.current) start();
    };
    refreshRef.current = start;
    start();
    const unsubscribe = api?.onPanelAppsChanged?.(onChanged);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      if (refreshRef.current === start) refreshRef.current = () => {};
      unsubscribe?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [pathsKey, locale]);

  return useMemo(() => ({ ...state, refresh }), [state, refresh]);
}
