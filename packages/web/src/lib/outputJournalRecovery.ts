import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { OutputJournalPage } from "@cjhyy/code-shell-core/internal";

/** Per-recovery state; keep it separate from Main/Hub transport sequence state. */
export interface OutputJournalRecovery {
  cursor?: string;
  /** Safe to persist across browser restarts; never points inside a fragmented event. */
  appliedCursor?: string;
  through?: string;
  coverageStart?: string;
  legacyBaseThroughEventId?: string;
  incomplete: boolean;
  pending?: { id: string; total: number; next: number; bytes: number; chunks: Uint8Array[] };
}

const MAX_EVENT_BYTES = 16 * 1024 * 1024;
function position(token: unknown): { identity: string; sequence: number; offset: number } {
  if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token))
    throw new Error("Invalid output cursor");
  const parsed = JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/")));
  if (
    typeof parsed.identity !== "string" ||
    !Number.isSafeInteger(parsed.sequence) ||
    parsed.sequence < 0 ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0
  )
    throw new Error("Invalid output cursor");
  return parsed;
}
function decodeFragment(value: string): Uint8Array {
  if (value.length > Math.ceil((64 * 1024) / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error("Invalid output fragment");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Only compare positions in the same Session journal, never Host counters. */
export function compareOutputCursors(left: string, right: string): number | undefined {
  try {
    const a = position(left),
      b = position(right);
    return a.identity === b.identity ? Math.sign(a.sequence - b.sequence) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold a frozen, contiguous page exactly once. Callers first load legacy history
 * through legacyBaseThroughEventId, then apply returned StreamEvents to their
 * existing reducer. An unpaired legacy transcript remains behind its barrier.
 * This function neither treats EOF as completion nor changes transport epochs.
 */
export function applyOutputJournalPage(
  state: OutputJournalRecovery,
  page: OutputJournalPage,
  emit: (event: StreamEvent) => void,
): boolean {
  if (state.incomplete) return false;
  try {
    if (
      page.version !== 1 ||
      page.status !== "ok" ||
      !page.from ||
      !page.through ||
      !page.next ||
      !page.coverageStart ||
      !Array.isArray(page.frames) ||
      page.frames.length > 512 ||
      new TextEncoder().encode(JSON.stringify(page)).length > 1024 * 1024 + 16 * 1024
    )
      throw new Error("Output recovery is incomplete");
    if (
      (state.cursor ?? page.coverageStart) !== page.from ||
      (state.through && state.through !== page.through) ||
      (state.coverageStart && state.coverageStart !== page.coverageStart) ||
      (state.legacyBaseThroughEventId !== undefined &&
        state.legacyBaseThroughEventId !== page.legacyBaseThroughEventId)
    )
      throw new Error("Output recovery page changed its snapshot");
    let previous = position(page.from);
    const through = position(page.through);
    const start = position(page.coverageStart);
    if (
      start.sequence !== 0 ||
      start.identity !== previous.identity ||
      through.identity !== previous.identity ||
      previous.sequence > through.sequence
    )
      throw new Error("Output recovery cursor domain changed");
    let pending = state.pending
      ? { ...state.pending, chunks: state.pending.chunks.slice() }
      : undefined;
    let appliedCursor = state.appliedCursor ?? page.from;
    const events: StreamEvent[] = [];
    for (const frame of page.frames) {
      const next = position(frame.cursor);
      if (
        next.identity !== previous.identity ||
        next.sequence !== previous.sequence + 1 ||
        frame.sequence !== next.sequence ||
        next.offset <= previous.offset ||
        next.sequence > through.sequence ||
        !!frame.event === !!frame.fragment
      )
        throw new Error("Output recovery has a gap");
      let event = frame.event;
      if (frame.fragment) {
        const part = frame.fragment;
        if (!pending) {
          if (
            part.index !== 0 ||
            !Number.isSafeInteger(part.total) ||
            part.total < 2 ||
            part.total > 256
          )
            throw new Error("Output fragment has no beginning");
          pending = { id: part.id, total: part.total, next: 0, bytes: 0, chunks: [] };
        }
        if (part.id !== pending.id || part.total !== pending.total || part.index !== pending.next)
          throw new Error("Output fragment has a gap");
        const bytes = decodeFragment(part.data);
        pending.bytes += bytes.length;
        if (pending.bytes > MAX_EVENT_BYTES) throw new Error("Output fragment exceeds its budget");
        pending.chunks.push(bytes);
        pending.next++;
        if (pending.next === pending.total) {
          const data = new Uint8Array(pending.bytes);
          let offset = 0;
          for (const chunk of pending.chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
          }
          event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
          pending = undefined;
        }
      } else if (pending) throw new Error("Output fragment was interrupted");
      if (event) {
        if (
          typeof event !== "object" ||
          typeof event.type !== "string" ||
          event.outputRecovery === "incomplete"
        )
          throw new Error("Invalid output event");
        events.push({ ...event, outputCursor: frame.cursor });
        appliedCursor = frame.cursor;
      }
      previous = next;
    }
    const next = position(page.next);
    if (
      next.identity !== previous.identity ||
      next.sequence !== previous.sequence ||
      next.offset !== previous.offset ||
      (page.frames.at(-1)?.cursor ?? page.from) !== page.next ||
      page.complete !== (page.next === page.through) ||
      (page.complete && pending) ||
      (!page.complete && !page.frames.length)
    )
      throw new Error("Output recovery page did not establish coverage");
    state.cursor = page.next;
    state.appliedCursor = appliedCursor;
    state.through = page.through;
    state.coverageStart = page.coverageStart;
    state.legacyBaseThroughEventId = page.legacyBaseThroughEventId;
    state.pending = pending;
    for (const event of events) emit(event);
    return page.complete;
  } catch {
    state.incomplete = true;
    state.pending = undefined;
    return false;
  }
}
