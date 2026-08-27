import { randomUUID } from "node:crypto";
import type { LocalProject, ProjectStore } from "./project-store.js";

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
  makeToken?: () => string;
}

export interface LegacyProjectMigrationService {
  begin(paths: string[]): Promise<{ completed: boolean; token?: string }>;
  authorizePath(token: string, path: string): Promise<LegacyProjectMigrationPathResult>;
  complete(token: string): Promise<void>;
}

export function createLegacyProjectMigrationService(
  options: LegacyProjectMigrationOptions,
): LegacyProjectMigrationService {
  const migrations = new Map<string, Set<string>>();

  const requirePending = (token: string): Set<string> => {
    if (options.store.isLegacyMigrationComplete()) {
      throw new Error("legacy project migration is complete");
    }
    const pending = migrations.get(token);
    if (!pending) throw new Error("legacy project migration token is invalid or expired");
    return pending;
  };

  return {
    async begin(paths) {
      if (!Array.isArray(paths) || paths.length > 5_000) {
        throw new Error("legacy project migration paths must be a bounded array");
      }
      if (options.store.isLegacyMigrationComplete()) return { completed: true };
      for (const path of paths) {
        if (typeof path !== "string" || !path || path.length > 32_768 || path.includes("\0")) {
          throw new Error("legacy project migration path is invalid");
        }
      }
      const token = (options.makeToken ?? randomUUID)();
      migrations.set(token, new Set(paths));
      return { completed: false, token };
    },

    async authorizePath(token, path) {
      const pending = requirePending(token);
      if (!pending.has(path)) {
        throw new Error("legacy project path is not pending for this migration token");
      }
      const picked = await options.pickDirectory();
      if (!picked) {
        return {
          path,
          status: "reauthorization_required",
          error: "folder picker authorization was cancelled",
        };
      }
      try {
        const project = await options.store.authorizeLegacyMigration(path, picked);
        if (project) pending.delete(path);
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

    async complete(token) {
      const pending = requirePending(token);
      if (pending.size > 0) {
        throw new Error("legacy project migration still requires picker authorization");
      }
      await options.store.completeLegacyMigration();
      migrations.clear();
    },
  };
}
