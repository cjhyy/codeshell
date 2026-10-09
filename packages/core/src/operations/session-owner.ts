import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageLedger } from "../cost-ledger/store.js";

/** Host-only snapshot. Never accept this structure from a renderer or a tool. */
export interface OperationSessionOwner {
  incarnation: string;
  binding: string;
  startedAt: number;
  state: Record<string, unknown>;
  directory: string;
}

export function readOperationSessionOwner(
  root: string,
  sessionId: string,
  usageLedger = new UsageLedger({ storageDir: join(root, ".usage-ledger") }),
): OperationSessionOwner {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(sessionId) || sessionId.includes(".."))
    throw new Error("Invalid operation Session");
  const directory = join(root, sessionId);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Operation Session replaced");
  const fd = openSync(
    join(directory, "state.json"),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let state: Record<string, unknown>;
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > 8 * 1024 * 1024)
      throw new Error("Invalid operation Session state");
    state = JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  const cost = state.costState as Record<string, unknown> | undefined;
  if (
    state.sessionId !== sessionId ||
    state.ephemeral === true ||
    typeof state.startedAt !== "number" ||
    !Number.isFinite(state.startedAt) ||
    !cost ||
    !usageLedger.adoptSession(sessionId, cost, root)
  )
    throw new Error("Operation Session has no durable incarnation");
  const incarnation = JSON.stringify([sessionId, state.startedAt, cost.accountingSessionId]);
  return {
    incarnation,
    binding: JSON.stringify([
      incarnation,
      info.dev,
      info.ino,
      state.project ?? null,
      state.cwd,
      state.workspace ?? null,
      state.runId ?? null,
      state.stateRevision ?? null,
      state.status,
    ]),
    startedAt: state.startedAt,
    state,
    directory,
  };
}
