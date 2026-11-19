import React from "react";
import type { SessionSummary } from "./protocol.js";
import "./session-sidebar-tools.css";

/**
 * Sidebar conversation search and pinning, matching Desktop's sidebar search
 * box and "置顶" group. Search filters the conversations this browser has
 * already loaded; pins are a per-browser, per-workspace preference (Desktop
 * also keeps pins locally), so neither needs a protocol change.
 */
export const PIN_STORAGE_PREFIX = "codeshell.web.pinnedSessions:";
const MAX_PINS = 50;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function loadPinnedSessions(scope: string, storage = defaultStorage()): string[] {
  try {
    const raw = JSON.parse(storage?.getItem(PIN_STORAGE_PREFIX + scope) ?? "[]");
    return Array.isArray(raw)
      ? [...new Set(raw.filter((id): id is string => typeof id === "string" && !!id))].slice(
          0,
          MAX_PINS,
        )
      : [];
  } catch {
    return []; // A corrupt entry must not break the sidebar; the next pin rewrites it.
  }
}

export function savePinnedSessions(scope: string, ids: string[], storage = defaultStorage()) {
  try {
    if (ids.length) storage?.setItem(PIN_STORAGE_PREFIX + scope, JSON.stringify(ids));
    else storage?.removeItem(PIN_STORAGE_PREFIX + scope);
  } catch {
    /* Pins still apply for this page when storage is unavailable. */
  }
}

/** Newest pin first; unpinning removes it. */
export function togglePinned(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [id, ...ids].slice(0, MAX_PINS);
}

function searchableText(session: SessionSummary): string {
  return [session.customTitle, session.title, session.preview, session.sessionId]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/** Every whitespace-separated term must appear in the title, preview or ID. */
export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
): SessionSummary[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...sessions];
  return sessions.filter((session) => {
    const text = searchableText(session);
    return terms.every((term) => text.includes(term));
  });
}

/** Pinned rows (in pin order) are lifted out of the regular list. */
export function splitPinned(
  sessions: readonly SessionSummary[],
  pinned: readonly string[],
): { pinned: SessionSummary[]; rest: SessionSummary[] } {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const lifted = pinned.flatMap((id) => byId.get(id) ?? []);
  const set = new Set(lifted.map((session) => session.sessionId));
  return { pinned: lifted, rest: sessions.filter((session) => !set.has(session.sessionId)) };
}

export function useSessionSidebar(
  scope: string,
  sessions: readonly SessionSummary[],
  navigationSessions: readonly SessionSummary[],
) {
  const [query, setQuery] = React.useState("");
  const [pins, setPins] = React.useState(() => loadPinnedSessions(scope));
  React.useEffect(() => {
    setPins(loadPinnedSessions(scope));
    setQuery("");
  }, [scope]);
  React.useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === PIN_STORAGE_PREFIX + scope)
        setPins(loadPinnedSessions(scope));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [scope]);
  const toggle = React.useCallback(
    (id: string) =>
      setPins((current) => {
        const next = togglePinned(current, id);
        savePinnedSessions(scope, next);
        return next;
      }),
    [scope],
  );
  const lists = React.useMemo(() => {
    const flat = splitPinned(filterSessions(sessions, query), pins);
    const grouped = splitPinned(filterSessions(navigationSessions, query), pins);
    // Pinned rows come from the full catalog so they survive the flat/grouped switch.
    return { pinned: grouped.pinned, sessions: flat.rest, navigationSessions: grouped.rest };
  }, [sessions, navigationSessions, query, pins]);
  return { query, setQuery, isPinned: (id: string) => pins.includes(id), toggle, ...lists };
}

export type SessionSidebar = ReturnType<typeof useSessionSidebar>;

/** Search box plus the "置顶" group; renders nothing until there is something to search. */
export function SessionSidebarHeader({
  sidebar,
  total,
  grouped,
  renderSession,
}: {
  sidebar: SessionSidebar;
  total: number;
  /** Whether the project-grouped catalog (not the flat list) is shown below. */
  grouped: boolean;
  renderSession: (session: SessionSummary) => React.ReactNode;
}) {
  if (!total && !sidebar.query) return null;
  const empty =
    !!sidebar.query &&
    !sidebar.pinned.length &&
    !(grouped ? sidebar.navigationSessions : sidebar.sessions).length;
  return (
    <>
      <div className="session-search">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input
          type="search"
          aria-label="搜索对话"
          placeholder="搜索对话"
          value={sidebar.query}
          onChange={(event) => sidebar.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && sidebar.query) {
              event.stopPropagation();
              sidebar.setQuery("");
            }
          }}
        />
      </div>
      {empty ? (
        <p className="session-search-empty" role="status">
          没有匹配“{sidebar.query.trim()}”的对话
        </p>
      ) : null}
      {sidebar.pinned.length ? (
        <>
          <div className="rail-section-label history-label pinned-label">
            <span>置顶</span>
            <span>{sidebar.pinned.length}</span>
          </div>
          <ul className="sessions pinned-sessions" aria-label="置顶对话">
            {sidebar.pinned.map(renderSession)}
          </ul>
        </>
      ) : null}
    </>
  );
}

/**
 * Hover/focus pin control placed after a session row (never nested inside its
 * button). Its name deliberately omits the title so row-name queries stay unique.
 */
export function SessionPinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="session-pin"
      aria-pressed={pinned}
      aria-label={pinned ? "取消置顶此对话" : "置顶此对话"}
      title={pinned ? "取消置顶" : "置顶"}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path d="M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 13v7" />
      </svg>
    </button>
  );
}
