import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelAppExtensionSummary, PanelAppUpdateCheck } from "../../preload/types";

const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_CONCURRENT_CHECKS = 2;

function identity(app: PanelAppExtensionSummary): string {
  return JSON.stringify([app.version, app.revision, app.updateSource]);
}

type CheckedApp = { identity: string; result: PanelAppUpdateCheck };
type CheckRequest = {
  app: PanelAppExtensionSummary;
  identity: string;
  generation: number;
  force: boolean;
};

/** Version discovery only. Installing always goes through the separate package review. */
export function usePanelAppUpdates(apps: PanelAppExtensionSummary[] | null) {
  const [checked, setChecked] = useState<Record<string, CheckedApp>>({});
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(() => new Set());
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const mounted = useRef(false);
  const generation = useRef(0);
  const active = useRef(0);
  const queue = useRef<CheckRequest[]>([]);
  const pending = useRef(new Set<string>());

  const drain = useCallback(function drainQueue() {
    while (mounted.current && active.current < MAX_CONCURRENT_CHECKS && queue.current.length) {
      const request = queue.current.shift()!;
      active.current += 1;
      void (async () => {
        let result: PanelAppUpdateCheck;
        try {
          result = await window.codeshell.checkPanelAppUpdate(request.app.appId, request.force);
        } catch (cause) {
          result = {
            id: request.app.appId,
            currentVersion: request.app.version,
            status: "error",
            checkedAt: new Date().toISOString(),
            sourceKind: request.app.updateSource.kind,
            message: String((cause as Error)?.message ?? cause),
          };
        }
        const current = appsRef.current?.find((app) => app.appId === request.app.appId);
        if (
          mounted.current &&
          request.generation === generation.current &&
          current &&
          identity(current) === request.identity &&
          result.id === current.appId &&
          (result.currentVersion === current.version ||
            (result.status === "error" && !result.currentVersion))
        ) {
          setChecked((previous) => ({
            ...previous,
            [current.appId]: { identity: request.identity, result },
          }));
        }
      })().finally(() => {
        active.current -= 1;
        if (mounted.current && request.generation === generation.current) {
          pending.current.delete(request.app.appId);
          setCheckingIds(new Set(pending.current));
        }
        drainQueue();
      });
    }
  }, []);

  const invalidate = useCallback(() => {
    generation.current += 1;
    queue.current = [];
    pending.current.clear();
    setChecked({});
    setCheckingIds(new Set());
  }, []);

  const checkAll = useCallback(
    (force = false) => {
      if (!mounted.current || !appsRef.current || (!force && pending.current.size > 0)) return;
      const nextGeneration = ++generation.current;
      queue.current = appsRef.current.map((app) => ({
        app,
        identity: identity(app),
        generation: nextGeneration,
        force,
      }));
      pending.current = new Set(queue.current.map((request) => request.app.appId));
      setCheckingIds(new Set(pending.current));
      drain();
    },
    [drain],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      queue.current = [];
      pending.current.clear();
    };
  }, []);

  useEffect(() => {
    // A fresh catalog may represent a same-version reinstall or a new source.
    // Invalidate by catalog generation as well as version/revision identity.
    invalidate();
    checkAll();
  }, [apps, checkAll, invalidate]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") checkAll();
    };
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [checkAll]);

  const results = useMemo(() => {
    const current: Record<string, PanelAppUpdateCheck> = {};
    for (const app of apps ?? []) {
      const entry = checked[app.appId];
      if (entry?.identity === identity(app)) current[app.appId] = entry.result;
    }
    return current;
  }, [apps, checked]);

  return {
    results,
    checkingIds,
    checking: checkingIds.size > 0,
    availableCount: Object.values(results).filter((result) => result.status === "update-available")
      .length,
    checkAll,
    invalidate,
  };
}
