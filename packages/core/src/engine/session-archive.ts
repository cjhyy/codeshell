/**
 * Range archival over a session transcript: resolving the archive window from
 * stable client-message-id anchors, guarding against dead anchors, and
 * persisting the anchored boundary so a restart replays the trimmed context.
 * Pure transcript helpers — the Engine owns the ContextManager/summarizer and
 * its in-process compacted-message cache.
 */
import { buildAnchoredSummaryMessage, estimateTokens } from "../context/compaction.js";
import type { SessionContextNotes } from "../context/notes.js";
import { logger } from "../logging/logger.js";
import { isAnchoredHookReminder } from "../session/context-messages.js";
import type { SessionBundle } from "../session/session-manager.js";
import type { Message } from "../types.js";

export interface ArchiveAnchors {
  toClientMessageId: string;
  fromClientMessageId?: string;
  segmentId?: string;
}

/** Attempt the durable note path without issuing a separate model request. */
export function tryNotesRollover(
  notes: SessionContextNotes,
  messages: Message[],
): Message[] | undefined {
  try {
    notes.requestRollover();
    return notes.applyRollover(messages);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the messages and half-open window to archive.
 *
 * - With `anchors`, the caller's `range` is IGNORED and the window is
 *   resolved from the client-message-id anchors over a fresh, marker-aware
 *   transcript replay. Callers (the pet segment closure) compute index
 *   ranges over the RAW transcript message list, whose indices grow
 *   forever — but the live list is trimmed by every persisted marker
 *   (replay after restart) and by each in-process archival, so a raw index
 *   range clamps to an empty window or, worse, onto the WRONG tail
 *   messages, which would then be persistently mis-summarized against
 *   correct anchors. Anchors are the only stable coordinates.
 * - Without `anchors`, legacy behavior: `range` is a half-open index window
 *   over the cached/in-process message list.
 *
 * Returns `window: null` when anchors don't resolve: the caller must not
 * summarize or persist anything.
 */
export function resolveArchiveWindow(
  sessionId: string,
  session: SessionBundle,
  range: { start: number; end: number },
  anchors: ArchiveAnchors | undefined,
  cachedMessages: Message[] | undefined,
): { sourceMessages: Message[]; window: { start: number; end: number } | null } {
  if (!anchors) {
    return {
      sourceMessages: cachedMessages ?? session.transcript.toMessages(),
      window: range,
    };
  }
  const { messages: sourceMessages, liveIndexByClientMessageId } =
    session.transcript.toMessagesWithIndex();
  // An absent from-anchor means "from the beginning" — over the live
  // list that is index 0, which includes any previously replayed
  // from-less summary at the head, so summarizeRange merge-feeds it
  // (extractAnchoredSummary) instead of losing it.
  const start =
    anchors.fromClientMessageId !== undefined
      ? liveIndexByClientMessageId.get(anchors.fromClientMessageId)
      : 0;
  let end = liveIndexByClientMessageId.get(anchors.toClientMessageId);
  // The `to` message's hook reminder sits just before it and is not part of
  // the span: replay closes the span at `to` and then emits that reminder.
  while (
    end !== undefined &&
    start !== undefined &&
    end > start &&
    isAnchoredHookReminder(sourceMessages[end - 1])
  ) {
    end -= 1;
  }
  if (start === undefined || end === undefined || end <= start) {
    // Fail open: no summarization, no persistence. Falling back to the
    // caller's raw range is exactly the bug this path exists to fix —
    // it would summarize the wrong messages and persist that against
    // the (correct) anchors, with segmentId dedupe blocking correction.
    logger.warn("engine.archive_range.anchor_window_unresolved", {
      sessionId,
      segmentId: anchors.segmentId,
      fromClientMessageId: anchors.fromClientMessageId,
      toClientMessageId: anchors.toClientMessageId,
    });
    return { sourceMessages, window: null };
  }
  return { sourceMessages, window: { start, end } };
}

/**
 * Persist the boundary so a restart replays the trimmed context. Only when
 * summarizeRange actually replaced the span (identity return means empty
 * window / rejected summary / no summarizer available) and the caller
 * supplied stable anchors to record it against.
 */
export function persistArchivedRange(
  session: SessionBundle,
  anchors: ArchiveAnchors | undefined,
  window: { start: number; end: number },
  sourceMessages: Message[],
  archived: Message[],
): void {
  if (!anchors || archived === sourceMessages) return;
  const clampedStart = Math.max(0, Math.min(window.start, archived.length - 1));
  const summaryMessage = archived[clampedStart];
  const summaryText =
    typeof summaryMessage?.content === "string" ? summaryMessage.content : undefined;
  if (summaryText && hasLiveArchiveAnchors(session, anchors)) {
    session.transcript.appendRangeArchive({ summary: summaryText, ...anchors });
  }
}

/**
 * Guard against writing a marker anchored to a client message id the
 * transcript doesn't actually contain. toMessages()'s replay silently
 * ignores a range_archive event whose anchor doesn't resolve (fail open),
 * so a bad anchor wouldn't corrupt anything on its own — but if the marker
 * carries a segmentId, appendRangeArchive's idempotency check treats that
 * segmentId as "already recorded" forever, with no retry path (e.g. a
 * one-time migration keyed "migration-v1" would be permanently burned on
 * its first, failed attempt). Reject before writing so the caller can
 * retry with a corrected anchor. fromClientMessageId is optional in the
 * data model (absent means "from the beginning"), so only validate it when
 * present; missing it is fail-open by design, same as the replay path.
 */
export function hasLiveArchiveAnchors(
  session: SessionBundle,
  anchors: { toClientMessageId: string; fromClientMessageId?: string },
): boolean {
  if (!session.transcript.hasClientMessageId(anchors.toClientMessageId)) return false;
  if (
    anchors.fromClientMessageId !== undefined &&
    !session.transcript.hasClientMessageId(anchors.fromClientMessageId)
  ) {
    return false;
  }
  return true;
}

/**
 * Persist an archive boundary WITHOUT a summarization call — the caller
 * already has the summary text (e.g. the one-time migration built from
 * pet journal entries). Wraps the plain text in the anchored-summary
 * envelope so replay and rolling-merge treat it like a real archive.
 * Returns false when the segmentId was already recorded (idempotent) OR
 * when the anchors don't resolve to real messages in this transcript —
 * see hasLiveArchiveAnchors for why a dead anchor must be rejected before
 * the (potentially one-shot) segmentId gets burned.
 */
export function appendSessionArchiveMarker(
  sessionId: string,
  session: SessionBundle,
  marker: ArchiveAnchors & { summary: string },
): boolean {
  if (!hasLiveArchiveAnchors(session, marker)) {
    logger.warn("engine.archive_marker.dead_anchor", {
      sessionId,
      segmentId: marker.segmentId,
      toClientMessageId: marker.toClientMessageId,
      fromClientMessageId: marker.fromClientMessageId,
    });
    return false;
  }
  const wrapped = buildAnchoredSummaryMessage(marker.summary, {
    ...(session.transcript.isPersistent()
      ? { transcriptPath: session.transcript.getFilePath() }
      : {}),
  });
  const content = typeof wrapped.content === "string" ? wrapped.content : marker.summary;
  return session.transcript.appendRangeArchive({ ...marker, summary: content }) !== undefined;
}

/** Token estimate of an unresolved/no-op archive: before === after. */
export function unchangedArchiveStats(messages: Message[]): { before: number; after: number } {
  const before = estimateTokens(messages);
  return { before, after: before };
}
