import React from "react";
import type { DigitalHumanTeam } from "../../shared/digital-human-team";
import type {
  DigitalHumanCatalogEntry,
  DigitalHumanProfileEntry,
  DigitalHumanSkillEntry,
} from "./types";
import type { RendererConfigurationTarget } from "../../preload/types";

export interface DigitalHumansLibraryApi {
  listProfiles(target: RendererConfigurationTarget): Promise<DigitalHumanProfileEntry[]>;
  listProfileCatalog(): Promise<DigitalHumanCatalogEntry[]>;
  listDigitalHumanTeams(): Promise<DigitalHumanTeam[]>;
  listSkills(
    target: RendererConfigurationTarget,
    options: { includeDisabled: true },
  ): Promise<DigitalHumanSkillEntry[]>;
}

export type DigitalHumansLibraryStatus = "loading" | "refreshing" | "ready" | "error";

export interface DigitalHumansLibraryState {
  profiles: DigitalHumanProfileEntry[];
  catalog: DigitalHumanCatalogEntry[];
  teams: DigitalHumanTeam[];
  availableSkills: DigitalHumanSkillEntry[];
  status: DigitalHumansLibraryStatus;
  error: string | null;
  refresh: () => Promise<boolean>;
}

export function useDigitalHumansLibrary(
  target: RendererConfigurationTarget,
  api: DigitalHumansLibraryApi = window.codeshell,
): DigitalHumansLibraryState {
  const [profiles, setProfiles] = React.useState<DigitalHumanProfileEntry[]>([]);
  const [catalog, setCatalog] = React.useState<DigitalHumanCatalogEntry[]>([]);
  const [teams, setTeams] = React.useState<DigitalHumanTeam[]>([]);
  const [availableSkills, setAvailableSkills] = React.useState<DigitalHumanSkillEntry[]>([]);
  const [status, setStatus] = React.useState<DigitalHumansLibraryStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const requestGeneration = React.useRef(0);
  const targetRef = React.useRef(target);
  targetRef.current = target;
  const targetKey =
    "projectId" in target
      ? `project:${target.projectId}`
      : "sessionId" in target
        ? `session:${target.sessionId}`
        : "no-repo";
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;
  const loadedTargetKey = React.useRef<string | undefined>(undefined);

  const refresh = React.useCallback(async () => {
    const generation = ++requestGeneration.current;
    const requestTarget = targetRef.current;
    const requestTargetKey = targetKeyRef.current;
    const hasCurrentTargetData = loadedTargetKey.current === requestTargetKey;
    const targetChanged =
      loadedTargetKey.current !== undefined && loadedTargetKey.current !== requestTargetKey;
    if (targetChanged) {
      // Profiles contain a project-specific `active` flag and skills can be
      // project-filtered. Never render the previous project's values while a
      // new project is loading or after its first load fails.
      setProfiles([]);
      setAvailableSkills([]);
      loadedTargetKey.current = undefined;
    }
    setStatus(hasCurrentTargetData ? "refreshing" : "loading");
    setError(null);
    try {
      const [nextProfiles, nextCatalog, nextTeams, nextSkills] = await Promise.all([
        api.listProfiles(requestTarget),
        api.listProfileCatalog(),
        api.listDigitalHumanTeams(),
        api.listSkills(requestTarget, { includeDisabled: true }),
      ]);
      if (generation !== requestGeneration.current) return false;
      setProfiles(nextProfiles);
      setCatalog(nextCatalog);
      setTeams(nextTeams);
      setAvailableSkills(nextSkills);
      loadedTargetKey.current = requestTargetKey;
      setStatus("ready");
      return true;
    } catch (caught) {
      if (generation !== requestGeneration.current) return false;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus(hasCurrentTargetData ? "ready" : "error");
      return false;
    }
  }, [api]);

  React.useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh, targetKey]);

  // A prop change renders before the replacement effect starts. Mask data
  // synchronously in that render so even one frame cannot expose A under B.
  const masksPreviousTarget =
    loadedTargetKey.current !== undefined && loadedTargetKey.current !== targetKey;

  return {
    profiles: masksPreviousTarget ? [] : profiles,
    catalog,
    teams,
    availableSkills: masksPreviousTarget ? [] : availableSkills,
    status: masksPreviousTarget ? "loading" : status,
    error: masksPreviousTarget ? null : error,
    refresh,
  };
}

export type DigitalHumanOperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; duplicate: true }
  | { ok: false; duplicate: false; error: unknown };

/**
 * Locks by operation key before the first await, so rapid double-clicks cannot
 * enqueue duplicate writes. The lock covers the follow-up refresh as well.
 */
export function useDigitalHumanOperations(refresh: () => Promise<boolean>) {
  const locks = React.useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = React.useState<Set<string>>(() => new Set());

  const run = React.useCallback(
    async <T>(key: string, action: () => Promise<T>): Promise<DigitalHumanOperationResult<T>> => {
      if (locks.current.has(key)) return { ok: false, duplicate: true };
      locks.current.add(key);
      setBusyKeys(new Set(locks.current));
      try {
        const value = await action();
        await refresh();
        return { ok: true, value };
      } catch (error) {
        return { ok: false, duplicate: false, error };
      } finally {
        locks.current.delete(key);
        setBusyKeys(new Set(locks.current));
      }
    },
    [refresh],
  );

  return {
    run,
    isBusy: React.useCallback((key: string) => busyKeys.has(key), [busyKeys]),
    hasBusyOperation: busyKeys.size > 0,
  };
}
