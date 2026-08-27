import type { LocalProject, ProjectStore } from "./project-store.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";

export type LegacyProjectMigrationStatus = "migrated" | "reauthorization_required" | "failed";

export interface LegacyProjectMigrationPathResult {
  path: string;
  status: LegacyProjectMigrationStatus;
  project?: LocalProject;
  error?: string;
}

export interface LegacyProjectMigrationBatchResult {
  results: LegacyProjectMigrationPathResult[];
  completed: boolean;
}

interface LegacyProjectMigrationOptions {
  store: ProjectStore;
  pickDirectory: () => Promise<string | null>;
  noRepoPath?: string;
  sessionRoot?: string;
}

export interface LegacyProjectMigrationService {
  migratePaths(paths: string[]): Promise<LegacyProjectMigrationBatchResult>;
  reauthorizePath(path: string): Promise<LegacyProjectMigrationPathResult>;
}

export function createLegacyProjectMigrationService(
  options: LegacyProjectMigrationOptions,
): LegacyProjectMigrationService {
  const registeredPaths = async (): Promise<string[]> =>
    (await options.store.list()).flatMap((project) => project.roots.map((root) => root.path));

  return {
    async migratePaths(paths) {
      if (!Array.isArray(paths) || paths.length > 5_000) {
        throw new Error("legacy project migration paths must be a bounded array");
      }
      const uniquePaths = [...new Set(paths)];
      const results: LegacyProjectMigrationPathResult[] = [];
      for (const path of uniquePaths) {
        try {
          const authorized = await requireRendererProjectPath(path, {
            registeredPaths: await registeredPaths(),
            noRepoPath: options.noRepoPath,
            sessionRoot: options.sessionRoot,
          });
          const project = await options.store.migrateLegacyPath(authorized);
          results.push(
            project
              ? { path, status: "migrated", project }
              : { path, status: "failed", error: "legacy project could not be migrated" },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            path,
            status: /not registered with CodeShell/i.test(message)
              ? "reauthorization_required"
              : "failed",
            error: message,
          });
        }
      }
      const completed = results.every((result) => result.status === "migrated");
      if (completed) await options.store.completeLegacyMigration();
      return { results, completed };
    },

    async reauthorizePath(path) {
      const picked = await options.pickDirectory();
      if (!picked) {
        return {
          path,
          status: "reauthorization_required",
          error: "folder picker authorization was cancelled",
        };
      }
      try {
        const project = await options.store.migrateLegacyPickedPath(path, picked);
        return project
          ? { path, status: "migrated", project }
          : {
              path,
              status: "reauthorization_required",
              error: "the selected folder does not match the legacy project path",
            };
      } catch (error) {
        return {
          path,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
