import { reserveRootMigration } from "@cjhyy/code-shell-core/internal/storage";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { claimBusinessCommit } from "./business-calls.js";
import type {
  ProjectMigrationOperations,
  ProjectMigrationCommand,
  ProjectMigrationOutcome,
  ProjectMigrationTarget,
} from "../../shared/project-migration.js";
import {
  getProjectStore,
  type ProjectStore,
  type MigratedSessionMainRoot,
} from "../../main/project-store.js";

type Ticket = {
  owner: ReturnType<typeof Promise.withResolvers<ProjectMigrationOutcome>>;
  result: Promise<MigratedSessionMainRoot>;
  beforeCommit?: () => void;
  expires?: NodeJS.Timeout;
  permit?: ReturnType<typeof reserveRootMigration>;
};

/** The registry writer owns the reservation until the same Engine releases its migration claim.
 * Returning the prepared target lets the writer continue serving reads and unrelated edits. */
export class StoredProjectMigrations {
  private readonly pending = new Map<string, Ticket>();
  constructor(
    private readonly store: ProjectStore,
    private readonly root = sessionsRoot(),
  ) {}

  async prepare(
    input: ProjectMigrationOperations["projects/prepareMigration"]["input"],
    commit: () => void,
  ) {
    if (
      !/^[0-9a-f-]{36}$/.test(input.ticket) ||
      this.pending.has(input.ticket) ||
      this.pending.size >= 128
    )
      throw Error("Session migration reservation is unavailable");
    const ready = Promise.withResolvers<ProjectMigrationTarget>();
    const owner = Promise.withResolvers<ProjectMigrationOutcome>();
    const row: Ticket = {
      owner,
      result: this.store.migrateSessionMainRoot(input.sessionId, input.targetRootId, {
        owner: {
          migrate: (target) => {
            row.expires = setTimeout(() => {
              void this.release(input.ticket).catch(() => undefined);
            }, 120_000).unref();
            ready.resolve(target);
            return owner.promise;
          },
          // Main holds the actual Engine claim until settle has returned.
          complete: async () => {},
        },
        beforeOwnerRequest: (target) => {
          commit();
          row.permit = reserveRootMigration(this.root, input.sessionId, input.ticket, target);
        },
        beforeOfflineCommit: () => {
          if (!row.beforeCommit || !row.permit) throw Error("Session migration was revoked");
          row.beforeCommit();
          row.permit.claim();
        },
      }),
    };
    this.pending.set(input.ticket, row);
    void row.result.catch(ready.reject);
    try {
      return await ready.promise;
    } catch (error) {
      this.pending.delete(input.ticket);
      throw error;
    }
  }

  settle(
    input: ProjectMigrationOperations["projects/settleMigration"]["input"],
    commit: () => void,
  ) {
    const row = this.pending.get(input.ticket);
    if (!row || row.beforeCommit) throw Error("Session migration reservation expired");
    row.beforeCommit = commit;
    if (input.outcome.status === "response-lost") row.owner.reject(Error(input.outcome.message));
    else row.owner.resolve(input.outcome);
    return row.result;
  }

  async release(ticket: string): Promise<true> {
    const row = this.pending.get(ticket);
    if (!row) return true;
    clearTimeout(row.expires);
    try {
      row.permit?.revoke();
    } finally {
      row.owner.resolve({ status: "failed", error: "Session migration reservation released" });
      await row.result.catch(() => undefined);
      this.pending.delete(ticket);
    }
    return true;
  }
}

let migrations: StoredProjectMigrations | undefined;
export async function writeHostedProjectMigration<K extends ProjectMigrationCommand>(
  command: K,
  payload: { input: ProjectMigrationOperations[K]["input"]; permit: Int32Array },
) {
  const store = getProjectStore();
  const reservations = (migrations ??= new StoredProjectMigrations(store));
  const commit = () => claimBusinessCommit(payload.permit);
  const operations: {
    [M in ProjectMigrationCommand]: (
      input: ProjectMigrationOperations[M]["input"],
    ) => Promise<ProjectMigrationOperations[M]["result"]>;
  } = {
    "projects/prepareMigration": (input) => reservations.prepare(input, commit),
    "projects/settleMigration": (input) => reservations.settle(input, commit),
    "projects/releaseMigration": ({ ticket }) => reservations.release(ticket),
    "projects/removalPath": async ({ projectId, rootId }) => {
      const project = await store.requireLive(projectId);
      const root = project.roots.find((candidate) => candidate.id === rootId);
      if (!root) throw Error("project root not found");
      return root.path;
    },
  };
  return { value: await operations[command](payload.input) };
}
