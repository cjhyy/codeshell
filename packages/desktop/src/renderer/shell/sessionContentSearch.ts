/**
 * Pure logic for the session switcher's transcript content-search mode
 * (SessionSearchModal). Extracted so the parsing + engine→local resolution
 * are unit-testable without React/effect entanglement.
 */
import { NO_REPO_KEY, type SessionIndex } from "../transcripts";

/** Content-search mode is entered by prefixing the query with '>'. */
export const CONTENT_PREFIX = ">";
/** Minimum term length before we issue a content search. */
export const MIN_CONTENT_TERM = 2;

export interface ParsedContentQuery {
  /** True when the filter is a '>'-prefixed content-search query. */
  contentMode: boolean;
  /** The search term: filter after '>' with leading whitespace stripped. */
  term: string;
  /** True once contentMode is on AND the term clears the minimum length. */
  ready: boolean;
}

/**
 * Split the switcher's raw filter into content-search intent. A leading '>'
 * switches to content mode; the term is everything after it with leading
 * whitespace trimmed. `ready` gates whether a query should actually fire.
 */
export function parseContentQuery(filter: string): ParsedContentQuery {
  const contentMode = filter.startsWith(CONTENT_PREFIX);
  const term = contentMode ? filter.slice(CONTENT_PREFIX.length).replace(/^\s+/, "") : "";
  const ready = contentMode && term.length >= MIN_CONTENT_TERM;
  return { contentMode, term, ready };
}

/**
 * Map a content-search match (which carries an ENGINE sessionId) back to the
 * local UI session so callers can reuse the title-mode open path. Iterates
 * `[null, ...projects]` and, within each bucket, matches a non-archived
 * session by `engineSessionId` or (fallback) local `id`. Returns null when no
 * in-memory session maps to the engine id (disk-only match).
 */
export function resolveContentMatch(
  match: { sessionId: string },
  projects: { id: string }[],
  sessions: Record<string, SessionIndex>,
): { projectId: string | null; sessionId: string } | null {
  for (const projectId of [null, ...projects.map((p) => p.id)]) {
    const idx = sessions[projectId ?? NO_REPO_KEY];
    if (!idx) continue;
    const local = idx.sessions.find(
      (s) => !s.archived && (s.engineSessionId === match.sessionId || s.id === match.sessionId),
    );
    if (local) return { projectId, sessionId: local.id };
  }
  return null;
}
