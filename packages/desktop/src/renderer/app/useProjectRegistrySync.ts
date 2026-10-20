import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { PermissionMode } from "../chat/PermissionPill";
import {
  loadSessionIndex,
  migrateProjectBucketOverrides,
  migrateProjectSessionBucket,
  type SessionIndex,
} from "../transcripts";
import {
  loadProjects,
  migrateLegacyProjects,
  readLegacyProjectsForMigration,
  reconcileProjectsFromDiskWithRemap,
  type TrackedProject,
} from "../projects";

interface ProjectRegistrySyncOptions {
  setProjects: Dispatch<SetStateAction<TrackedProject[]>>;
  setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  setPermissionOverrides: Dispatch<SetStateAction<Record<string, PermissionMode>>>;
  setModelOverrides: Dispatch<SetStateAction<Record<string, string>>>;
  setGoalOverrides: Dispatch<SetStateAction<Record<string, boolean>>>;
}

/** Keep renderer projections keyed by Main's durable V2 project authority. */
export function useProjectRegistrySync(options: ProjectRegistrySyncOptions): void {
  useEffect(() => {
    const registry = window.codeshell.projectRegistry;
    if (!registry) return;
    let alive = true;
    // Counts live registry broadcasts, so the startup continuation can tell
    // that its own snapshot was overtaken while it awaited the migration.
    let liveGeneration = 0;
    const apply = (
      diskProjects: Parameters<typeof reconcileProjectsFromDiskWithRemap>[0],
    ): void => {
      if (!alive) return;
      liveGeneration += 1;
      const next = reconcileProjectsFromDiskWithRemap(diskProjects, loadProjects()).projects;
      options.setProjects(next);
      options.setSessionIndices((previous) => {
        const updated = { ...previous };
        for (const project of next) {
          if (!updated[project.id]) updated[project.id] = loadSessionIndex(project.id);
        }
        return updated;
      });
    };
    void (async () => {
      const startGeneration = liveGeneration;
      // Upgrade-only localStorage projects cross the native picker proof flow
      // before they can join the live registry snapshot.
      const disk = await registry.list();
      const migrated = await migrateLegacyProjects({
        diskProjects: disk,
        cachedProjects: readLegacyProjectsForMigration(),
        registry,
      });
      const { projectIdRemap } = migrated;
      const remaps = Object.entries(projectIdRemap);
      const migratedProjectIds = new Set<string>();
      for (const [fromProjectId, toProjectId] of remaps) {
        await migrateProjectSessionBucket(fromProjectId, toProjectId);
        migratedProjectIds.add(toProjectId);
      }
      // A registry change broadcast meanwhile (e.g. a project added while the
      // bucket copy was pending) is newer than the migration's snapshot.
      // Re-read until no broadcast overtakes the read, instead of publishing
      // the older list over it.
      let projects = migrated.projects;
      for (let seen = startGeneration; alive && seen !== liveGeneration; ) {
        seen = liveGeneration;
        projects = reconcileProjectsFromDiskWithRemap(await registry.list(), projects).projects;
      }
      if (!alive) return;
      options.setProjects(projects);
      options.setSessionIndices((previous) => {
        const next = { ...previous };
        for (const project of projects) {
          if (!next[project.id]) next[project.id] = loadSessionIndex(project.id);
        }
        return next;
      });
      if (remaps.length > 0) {
        options.setActiveProjectId((previous) =>
          previous && projectIdRemap[previous] ? projectIdRemap[previous] : previous,
        );
        options.setPermissionOverrides((previous) =>
          migrateProjectBucketOverrides(previous, projectIdRemap),
        );
        options.setModelOverrides((previous) =>
          migrateProjectBucketOverrides(previous, projectIdRemap),
        );
        options.setGoalOverrides((previous) =>
          migrateProjectBucketOverrides(previous, projectIdRemap),
        );
        options.setSessionIndices((previous) => {
          const next = { ...previous };
          for (const [fromProjectId] of remaps) delete next[fromProjectId];
          for (const id of migratedProjectIds) next[id] = loadSessionIndex(id);
          return next;
        });
      }
    })().catch((error) => {
      window.codeshell.log("session.project_migration_failed", { error: String(error) });
    });
    const unsubscribe = registry.onChanged(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
    // The subscription owns subsequent refreshes; setters are stable React dispatchers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
