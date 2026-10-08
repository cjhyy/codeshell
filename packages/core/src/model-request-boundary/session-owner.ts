import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { syncDirectoryAncestors } from "./durability.js";
import type { ModelRequestSubject } from "./types.js";

/** Confirm and commit the Session incarnation before persistent proof or network I/O. */
export function assertDurableRequestOwner(
  subject: ModelRequestSubject,
  sessionStorageDir: string,
): void {
  if (
    subject.ephemeral === true ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(subject.sessionId) ||
    subject.sessionId.startsWith("qchat-") ||
    createHash("sha256").update(sessionStorageDir).digest("hex") !== subject.storageScopeId
  )
    throw new Error("Durable request owner mismatch");
  const directory = join(sessionStorageDir, subject.sessionId);
  const fd = openSync(
    join(directory, "state.json"),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > 8 * 1024 * 1024 ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new Error("Durable request owner storage is not private");
    const state = JSON.parse(readFileSync(fd, "utf8")) as {
      sessionId?: unknown;
      ephemeral?: unknown;
      costState?: { accountingSessionId?: unknown; sessionScopeId?: unknown };
    };
    if (
      !state ||
      state.sessionId !== subject.sessionId ||
      state.ephemeral === true ||
      state.costState?.accountingSessionId !== subject.sessionInstanceId ||
      state.costState?.sessionScopeId !== subject.storageScopeId
    )
      throw new Error("Durable request incarnation mismatch");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectoryAncestors(directory);
}
