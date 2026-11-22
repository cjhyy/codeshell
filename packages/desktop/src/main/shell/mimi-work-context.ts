import { AgentBridge } from "../agent-bridge.js";
import type { PetArchiveAnchors } from "../pet/pet-segment-controller.js";
import { buildMigrationSummary } from "@cjhyy/code-shell-pet";
import { dlog } from "../desktop-logger.js";
import type {
  NativeMimiHost,
  MimiWorkMemory,
  MimiRecords,
  MimiSegments,
} from "./mimi-shell-types.js";
export async function hydrateMimiWorkMemory({
  bridge,
  desktopHost,
  petWorkMemory,
  mimiRecords,
  segments,
}: {
  bridge: AgentBridge;
  desktopHost: Pick<NativeMimiHost, "callBusiness">;
  petWorkMemory: MimiWorkMemory;
  mimiRecords: MimiRecords;
  segments: MimiSegments;
}) {
  // Build the topic-segment controller now that the pet session id is
  // resolved. Range archival rides the generic archive_range worker query;
  // dispatch currently passes no turnRange, so it stays dormant.
  const { petSessionId } = await mimiRecords.metadata.ensure();
  const petBridge = bridge;
  const archivePetRange = async (
    sessionId: string,
    range: { start: number; end: number },
    anchors?: PetArchiveAnchors,
  ): Promise<{ before: number; after: number }> => {
    const response = await petBridge.requestWorker(
      "agent/query",
      {
        type: "archive_range",
        sessionId,
        start: range.start,
        end: range.end,
        ...(anchors ?? {}),
      },
      { meta: { origin: "host", producer: "pet-archive-range" } },
    );
    if (!response.ok) throw new Error(response.message);
    const data = (response.result as { data?: { before?: number; after?: number } })?.data;
    return { before: data?.before ?? 0, after: data?.after ?? 0 };
  };
  // Shared by the segment-closure pipeline and the startup migration below:
  // whether the user has auto-memory extraction enabled. Extraction (not
  // just archival) is what writes journal entries, so both consumers need
  // the same read of this preference.
  const autoExtractEnabled = () => desktopHost.callBusiness("mimi/extractionAllowed", {});
  segments.closure = {
    close: (input) => desktopHost.callBusiness("mimi/closeSegment", input),
    backfill: (segments, now) =>
      desktopHost.callBusiness("mimi/backfillSegments", { segments, now }),
    readSegmentMessages: (range) => desktopHost.callBusiness("mimi/segmentMessages", range),
  };
  const closureService = segments.closure;
  // Defense-in-depth against a segment's range being archived twice.
  // archive_range uses absolute message indices; a second archive of the
  // same segment would run on now-shifted indices and remove the wrong
  // turns. The controller serializes beginTurn to prevent a double close,
  // and this set guarantees at-most-once archival per segment regardless.
  const closedSegmentIds = new Set<string>();
  segments.controller = petWorkMemory.controller({
    petSessionId,
    archiveRange: archivePetRange,
    // The dispatcher calls this after the boundary turn settles, so the
    // exclusive-end message is guaranteed to exist for journal range math.
    onSegmentClosed: async (closed) => {
      if (closedSegmentIds.has(closed.segmentId)) return;
      closedSegmentIds.add(closed.segmentId);
      await closureService
        .close(closed)
        .catch((error) => dlog("main", "pet.closure.failed", { error: String(error) }));
    },
  });
  // Startup compensation: a segment whose closure was interrupted by app exit
  // still has no journal entry. Recover those (journal + memory only; the
  // range was — or will be — archived by the live path, so backfill never
  // re-archives). Fire-and-forget; never blocks pet initialization.
  const backfillPromise = closureService
    .backfill(petWorkMemory.allSegments(), Date.now())
    .catch((error) => dlog("main", "pet.closure.backfill.failed", { error: String(error) }));
  // One-time context-boundary migration for pre-existing Mimi sessions:
  // before range_archive existed, closures trimmed context only in-memory,
  // so every restart re-inflated the prompt to the full transcript. Seed a
  // single persisted marker covering everything before the active segment,
  // summarized from the journal entries we already have — no model call.
  // Idempotent: Engine.appendArchiveMarker dedupes on segmentId, so
  // relaunches and already-migrated sessions no-op. Waits for backfill to
  // settle before taking the journal snapshot, so it never misses the
  // journal entry backfill is about to write for an interrupted segment —
  // context-migration-v1 is a one-time permanent write, so reading too
  // early and missing an entry would not be a benign transient.
  void (async () => {
    // When auto-extract is off, closure only archives — it never writes a
    // journal entry (see the closure service's extraction gate) — so any
    // segment closed while the toggle was off has no summary to represent
    // it here. Migrating anyway would make those segments' messages
    // vanish from the model context with zero representation: a real
    // visibility regression versus today's full-history behavior. Skip
    // and leave today's (uncompacted) exposure as-is until the toggle is
    // back on and a later launch can migrate with full coverage.
    if (!(await autoExtractEnabled())) {
      dlog("main", "pet.contextMigration.skippedAutoExtractOff", { petSessionId });
      return;
    }
    await backfillPromise.catch(() => undefined);
    const activeSegment = petWorkMemory.activeSegment();
    // Ensure the journal is loaded before snapshotting (idempotent/memoized;
    // same pattern as the journal.list() IPC handler above) — otherwise a
    // slow-disk cold start could read an empty list and skip migration for
    // this launch entirely.
    // PetJournalStore.list() is newest-first (sorted by endedAt desc); the
    // migration summary must read oldest→newest, so reverse a copy here.
    const journalEntries = [...(await mimiRecords.journal.list())].reverse();
    if (!activeSegment?.boundaryBeforeMessageId || journalEntries.length === 0) return;
    const summary = buildMigrationSummary(journalEntries);
    if (!summary) return;
    const appended = await petBridge.appendStartupArchiveMarker({
      sessionId: petSessionId,
      summary,
      toClientMessageId: activeSegment.boundaryBeforeMessageId,
      segmentId: "context-migration-v1",
    });
    // false covers two benign cases, not an error: this session was
    // already migrated on a prior launch (idempotent no-op — expected on
    // every subsequent startup), or the anchor was dead (engine already
    // warn-logs that distinctly as engine.archive_marker.dead_anchor).
    // This dlog is just a startup trace, not an alarm.
    if (appended === false) {
      dlog("main", "pet.contextMigration.notAppended", { petSessionId });
    }
  })().catch((error) => dlog("main", "pet.contextMigration.failed", { error: String(error) }));
}
