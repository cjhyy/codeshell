import { withdrawRootMigration } from "@cjhyy/code-shell-core/internal/storage";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { dlog } from "./desktop-logger.js";
import { randomUUID } from "node:crypto";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import type { AgentBridge } from "./agent-bridge.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import type { ProjectMigrationOutcome } from "../shared/project-migration.js";
import type { getTrust } from "./trust-store.js";

/** Only this adapter holds the Engine's claim. The workbench supplies two opaque IDs. */
export async function migrateHostedSession(
  sessionId: string,
  targetRootId: string,
  document: AbortSignal,
  generation: AbortSignal,
  call: CallShellBusiness,
  bridge: Pick<AgentBridge, "migrateSessionMainRoot" | "completeSessionMainRootMigration">,
  trust: typeof getTrust,
) {
  const ticket = randomUUID();
  const signal = AbortSignal.any([document, generation, AbortSignal.timeout(60_000)]);
  // A native document must be able to revoke its own one-use grant even if the
  // originating utility has died and its stdio child is still finishing a request.
  const withdraw = () => {
    void withdrawRootMigration(sessionsRoot(), sessionId, ticket).catch((error) =>
      dlog("main", "project_store.migration_withdraw_failed", { sessionId, error: String(error) }),
    );
  };
  signal.addEventListener("abort", withdraw, { once: true });
  let claim: string | undefined;
  try {
    const target = await call(
      "projects/prepareMigration",
      { ticket, sessionId, targetRootId },
      signal,
    );
    const trusted = (await trust(target.mainRoot)) === "trusted";
    signal.throwIfAborted();
    let outcome: ProjectMigrationOutcome | { status: "response-lost"; message: string };
    try {
      outcome = await bridge.migrateSessionMainRoot(
        sessionId,
        {
          projectId: target.projectId,
          mainRootId: target.mainRootId,
        },
        target.mainRoot,
        {
          workspaceContext: target.workspaceContext,
          projectTrusted: trusted,
          commitTicket: ticket,
        },
      );
      if (outcome.status === "not-resident") claim = outcome.ownershipToken;
    } catch (error) {
      // The Engine may have committed before its reply was lost. Only matching disk state
      // authorizes the Host to finish the projections for this reservation.
      outcome = {
        status: "response-lost",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (outcome.status === "not-resident") signal.throwIfAborted();
    const result = await call("projects/settleMigration", { ticket, outcome }, generation);
    getSessionCwdIndex().upsert(sessionId, {
      cwd: result.mainRoot,
      workspaceRoot: result.workspace.root,
      projectId: result.projectId,
      mainRootId: result.targetRootId,
    });
    return result;
  } finally {
    // Wait until the storage owner has stopped using its write permit before releasing the Engine.
    const releaseFailed = (error: unknown) =>
      dlog("main", "project_store.migration_release_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    signal.removeEventListener("abort", withdraw);
    await call("projects/releaseMigration", { ticket }, generation).catch(releaseFailed);
    if (claim) await bridge.completeSessionMainRootMigration(sessionId, claim).catch(releaseFailed);
  }
}
