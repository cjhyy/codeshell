import { useEffect, useRef, useState } from "react";

import type { PermissionMode } from "../chat/PermissionPill";
import {
  isTransientOverrideBucket,
  loadOverrideMap,
  overrideMapKey,
  saveOverrideMap,
} from "../transcripts";
import { normalizeExternalRuntimeModelKey } from "../../shared/external-runtime-models";

function loadModelOverrides(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(loadOverrideMap<string>("model")).map(([bucket, key]) => [
      bucket,
      normalizeExternalRuntimeModelKey(key),
    ]),
  );
}

function loadPermissionOverrides(): Record<string, PermissionMode> {
  return loadOverrideMap<PermissionMode>("permission");
}

function loadGoalOverrides(): Record<string, boolean> {
  return loadOverrideMap<boolean>("goal");
}

/**
 * One override namespace shared by every open window through localStorage.
 * A window persists only the buckets it changed onto the latest stored map,
 * and adopts other windows' saves, so a stale whole-map write never erases a
 * preference another window saved meanwhile.
 */
function useSharedOverrideMap<V>(
  namespace: string,
  load: () => Record<string, V>,
): [Record<string, V>, React.Dispatch<React.SetStateAction<Record<string, V>>>] {
  const [map, setMap] = useState(load);
  // Starts as the raw stored map, so values normalized on load (e.g. a
  // migrated model key) are written back on mount.
  const persisted = useRef<Record<string, V>>(loadOverrideMap<V>(namespace));

  useEffect(() => {
    const previous = persisted.current;
    if (previous === map) return;
    persisted.current = map;
    const latest = loadOverrideMap<V>(namespace);
    let changed = false;
    for (const bucket of Object.keys(previous)) {
      if (bucket in map) continue;
      delete latest[bucket];
      changed = true;
    }
    for (const [bucket, value] of Object.entries(map)) {
      if (previous[bucket] === value) continue;
      latest[bucket] = value;
      changed = true;
    }
    if (changed) saveOverrideMap(namespace, latest);
  }, [map, namespace]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== overrideMapKey(namespace)) return;
      const stored = load();
      setMap((current) => {
        // Unpersisted draft/quick-chat choices belong to this window only.
        const next = { ...stored };
        for (const [bucket, value] of Object.entries(current)) {
          if (isTransientOverrideBucket(bucket)) next[bucket] = value;
        }
        persisted.current = next;
        return next;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [load, namespace]);

  return [map, setMap];
}

/** Bucket-scoped renderer preferences with their localStorage projection. */
export function useBucketOverrides(): {
  permissionOverrides: Record<string, PermissionMode>;
  setPermissionOverrides: React.Dispatch<React.SetStateAction<Record<string, PermissionMode>>>;
  modelOverrides: Record<string, string>;
  setModelOverrides: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  goalOverrides: Record<string, boolean>;
  setGoalOverrides: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
} {
  const [permissionOverrides, setPermissionOverrides] = useSharedOverrideMap(
    "permission",
    loadPermissionOverrides,
  );
  const [modelOverrides, setModelOverrides] = useSharedOverrideMap("model", loadModelOverrides);
  const [goalOverrides, setGoalOverrides] = useSharedOverrideMap("goal", loadGoalOverrides);

  return {
    permissionOverrides,
    setPermissionOverrides,
    modelOverrides,
    setModelOverrides,
    goalOverrides,
    setGoalOverrides,
  };
}
