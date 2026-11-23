import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { archiveDiskSession, deleteSessionDir } from "@cjhyy/code-shell-server/storage";
import { assertDesktopSessionId } from "../../main/session-validation.js";
import type { BusinessGrant } from "./business-calls.js";
import { claimBusinessCommit } from "./business-calls.js";

type Change = { sessionId: string; archivedAt?: number };
type Command = "sessions/archive" | "sessions/deleteFiles";

export function sessionFileOperations(
  storage: Promise<StateStorage>,
  changed: (id: string) => Promise<void>,
) {
  const route = (command: Command) => async (input: Change, grant: BusinessGrant) => {
    const db = await storage;
    grant.assertCurrent();
    if (!(await db.request<boolean>(command, { input, permit: grant.permit })))
      throw Error("Session storage is unavailable");
    await changed(input.sessionId);
  };
  return {
    "sessions/archive": route("sessions/archive"),
    "sessions/deleteFiles": route("sessions/deleteFiles"),
  };
}

/** Both legacy flat files and current Session directories live under the writer's fixed root. */
export async function changeSessionFiles(
  root: string,
  command: Command,
  operation: { input: Change; permit: Int32Array },
) {
  const { sessionId, archivedAt } = operation.input;
  assertDesktopSessionId(sessionId);
  if (archivedAt !== undefined && !Number.isSafeInteger(archivedAt))
    throw Error("Invalid archive timestamp");
  claimBusinessCommit(operation.permit);
  if (command === "sessions/archive") await archiveDiskSession(sessionId, archivedAt, root);
  else await deleteSessionDir(sessionId, root);
  return true;
}
