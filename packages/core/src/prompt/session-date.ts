/**
 * The date the model is told, kept out of the cache's way.
 *
 * The head context message is the first thing after the system prompt, so
 * every cached prefix of a session contains it. It used to state the current
 * date, recomputed per run — at local midnight the whole session's cache
 * broke. It now states the date the session started, which never changes,
 * and a later "today" is announced through the context ledger: appended once
 * per date change, superseding the earlier statement, never rewriting it.
 *
 * Pure: the clock is passed in.
 */

/** Local date, not UTC: toISOString() would show the wrong "today" near midnight. */
export function localDateYmd(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface SessionDates {
  /** Date stated in the head message: the session's start date. */
  headDate: string;
  /** Today's date, only when it differs from `headDate`. */
  changedTo?: string;
}

/**
 * `sessionStartedAt` is epoch milliseconds (SessionState.startedAt). Without
 * a usable start the head states today's date, as it did before.
 */
export function resolveSessionDates(sessionStartedAt: number | undefined, now: Date): SessionDates {
  const today = localDateYmd(now);
  if (sessionStartedAt === undefined || !Number.isFinite(sessionStartedAt)) {
    return { headDate: today };
  }
  const headDate = localDateYmd(new Date(sessionStartedAt));
  return headDate === today ? { headDate } : { headDate, changedTo: today };
}

/** Text of the ledger's "date" section. */
export function dateChangeNotice(today: string): string {
  return `The date has changed since this conversation began. Today's date is now ${today}; this supersedes any date stated earlier.`;
}
