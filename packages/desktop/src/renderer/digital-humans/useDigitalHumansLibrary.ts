import React from "react";
import type { DigitalHumanTeam } from "../../shared/digital-human-team";
import type {
  DigitalHumanCatalogEntry,
  DigitalHumanProfileEntry,
  DigitalHumanSkillEntry,
} from "./types";

export interface DigitalHumansLibraryApi {
  listProfiles(cwd?: string): Promise<DigitalHumanProfileEntry[]>;
  listProfileCatalog(): Promise<DigitalHumanCatalogEntry[]>;
  listDigitalHumanTeams(): Promise<DigitalHumanTeam[]>;
  listSkills(cwd: string, options: { includeDisabled: true }): Promise<DigitalHumanSkillEntry[]>;
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
  activeProjectPath: string | null,
  api: DigitalHumansLibraryApi = window.codeshell,
): DigitalHumansLibraryState {
  const [profiles, setProfiles] = React.useState<DigitalHumanProfileEntry[]>([]);
  const [catalog, setCatalog] = React.useState<DigitalHumanCatalogEntry[]>([]);
  const [teams, setTeams] = React.useState<DigitalHumanTeam[]>([]);
  const [availableSkills, setAvailableSkills] = React.useState<DigitalHumanSkillEntry[]>([]);
  const [status, setStatus] = React.useState<DigitalHumansLibraryStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const requestGeneration = React.useRef(0);
  const loadedProjectPath = React.useRef<string | null | undefined>(undefined);

  const refresh = React.useCallback(async () => {
    const generation = ++requestGeneration.current;
    const hasCurrentProjectData = loadedProjectPath.current === activeProjectPath;
    const projectChanged =
      loadedProjectPath.current !== undefined && loadedProjectPath.current !== activeProjectPath;
    if (projectChanged) {
      // Profiles contain a project-specific `active` flag and skills can be
      // project-filtered. Never render the previous project's values while a
      // new project is loading or after its first load fails.
      setProfiles([]);
      setAvailableSkills([]);
      loadedProjectPath.current = undefined;
    }
    setStatus(hasCurrentProjectData ? "refreshing" : "loading");
    setError(null);
    try {
      const [nextProfiles, nextCatalog, nextTeams, nextSkills] = await Promise.all([
        api.listProfiles(activeProjectPath ?? undefined),
        api.listProfileCatalog(),
        api.listDigitalHumanTeams(),
        api.listSkills(activeProjectPath ?? "/", { includeDisabled: true }),
      ]);
      if (generation !== requestGeneration.current) return false;
      setProfiles(nextProfiles);
      setCatalog(nextCatalog);
      setTeams(nextTeams);
      setAvailableSkills(nextSkills);
      loadedProjectPath.current = activeProjectPath;
      setStatus("ready");
      return true;
    } catch (caught) {
      if (generation !== requestGeneration.current) return false;
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus(hasCurrentProjectData ? "ready" : "error");
      return false;
    }
  }, [activeProjectPath, api]);

  React.useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);

  return {
    profiles,
    catalog,
    teams,
    availableSkills,
    status,
    error,
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
