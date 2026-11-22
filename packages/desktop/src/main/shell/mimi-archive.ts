import { selectSessionsToArchive } from "../pet/pet-auto-archive.js";
import { dlog } from "../desktop-logger.js";
import type { MimiShellOptions } from "./mimi-shell-types.js";
import type { NativeMimiProjection } from "../desktop-host/mimi-projection-client.js";
/** Days of inactivity after which a completed work session is auto-archived. */
const PET_AUTO_ARCHIVE_IDLE_DAYS = 7;

/**
 * One-shot auto-archival pass, run right after pet init. Pulls the full catalog
 * (including already-archived rows so the policy can skip them), selects the
 * completed sessions idle for 7+ days, writes their archival markers, and — if
 * anything changed — forces a FULL catalog rebuild so the aggregator's held Map
 * is repopulated from the archive-filtered listDiskSessions (no ghost rows).
 */
export async function runPetAutoArchive(
  aggregator: NativeMimiProjection,
  {
    listAllDiskSessions,
    archiveDiskSession,
  }: Pick<MimiShellOptions, "listAllDiskSessions" | "archiveDiskSession">,
): Promise<void> {
  const sessions = await listAllDiskSessions();
  const toArchive = selectSessionsToArchive(
    sessions.map((s) => ({
      engineSessionId: s.engineSessionId,
      status: s.status,
      updatedAt: s.updatedAt,
      archivedAt: s.archivedAt,
    })),
    { now: Date.now(), idleDays: PET_AUTO_ARCHIVE_IDLE_DAYS },
  );
  if (toArchive.length === 0) return;
  const now = Date.now();
  for (const id of toArchive) {
    await archiveDiskSession(id, now).catch((error) => {
      dlog("main", "pet.autoArchive.write.failed", { id, error: String(error) });
    });
  }
  // Full rebuild: archived sessions must be evicted from the held Map, not just
  // absent from an incremental page (see the trigger comment in the pet init).
  await aggregator.refreshCatalog(true, { full: true });
}
