import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { MessageStream } from "../MessageStream";
import {
  foldTranscriptIncremental,
  type IncrementalTranscriptFold,
} from "../automation/foldTranscript";
import { useT } from "../i18n/I18nProvider";
import type { MessagesReducerState } from "../types";
import type { SubagentSelection } from "./SubagentNavigation";
import { SubagentList, type SubagentListItem } from "./SubagentList";

type ChildSession = Awaited<
  ReturnType<typeof window.codeshell.listDiskSessions>
>["sessions"][number];

// Nested child details share the dock's visibility even when MessageStream owns
// their local navigation state.
const SubagentDetailActiveContext = React.createContext(true);

/** useState whose setter skips identical values, so background polls that find
 *  nothing new do not schedule renders. */
function useTrackedState<T>(initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useCallback((next: T) => {
    if (Object.is(ref.current, next)) return;
    ref.current = next;
    setValue(next);
  }, []);
  return [value, set];
}

/** Read the existing child transcript without registering it in the main session
 * index. One detail surface can navigate nested children through MessageStream. */
export function SubagentSessionDetail({
  agentId,
  parentSessionId,
  label,
  running = false,
  agents = [],
  navigationNonce,
  active = true,
  onBack,
}: SubagentSelection & { active?: boolean; onBack?: () => void }) {
  const { t } = useT();
  const parentActive = React.useContext(SubagentDetailActiveContext);
  const detailActive = active && parentActive;
  const activeRef = useRef(detailActive);
  activeRef.current = detailActive;
  const selectionKey = JSON.stringify([agentId, parentSessionId, navigationNonce]);
  const [navigation, setNavigation] = useState({ key: selectionKey, selectedId: agentId });
  // A new chat-owned selection takes effect immediately, before passive effects.
  const selectedId = navigation.key === selectionKey ? navigation.selectedId : agentId;
  const listOpen = Boolean(agentId && parentSessionId && !selectedId);
  const [catalog, setCatalog] = useState<{ key: string; rows: ChildSession[] } | null>(null);
  const catalogRef = useRef<{ key: string; rows: string } | null>(null);
  const children = catalog?.key === selectionKey ? catalog.rows : [];
  const [state, setState] = useState<{
    key: string;
    sessionId: string;
    value: MessagesReducerState;
  } | null>(null);
  // The last fold of the shown transcript; polls extend it instead of rebuilding.
  const foldRef = useRef<{ key: string; fold: IncrementalTranscriptFold } | null>(null);
  const [loading, setLoading] = useTrackedState(false);
  const [loadingChildren, setLoadingChildren] = useTrackedState(false);
  const [error, setError] = useTrackedState<string | null>(null);
  const [catalogError, setCatalogError] = useTrackedState<{
    key: string;
    message: string;
  } | null>(null);
  const generation = useRef(0);
  const catalogGeneration = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const navigationFocus = useRef<"list" | "detail" | null>(null);
  useEffect(() => {
    if (!detailActive || !navigationFocus.current) return;
    const selector =
      navigationFocus.current === "list"
        ? "[data-subagent-list]"
        : '[data-subagent-action="back-to-list"]';
    sectionRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    navigationFocus.current = null;
  }, [detailActive, listOpen, selectedId]);

  // Background reads (polls, file changes) only show the spinner until the
  // first catalog for this selection has loaded.
  const loadChildren = useCallback(
    async (manual = false) => {
      if (!activeRef.current || !agentId || !parentSessionId) return;
      const request = ++catalogGeneration.current;
      if (manual || catalogRef.current?.key !== selectionKey) setLoadingChildren(true);
      try {
        const rows: ChildSession[] = [];
        let cursor: string | undefined;
        do {
          const page = await window.codeshell.listDiskSessions({
            parentSessionId,
            cursor,
            limit: 100,
          });
          if (!activeRef.current || request !== catalogGeneration.current) return;
          rows.push(
            ...page.sessions.filter(
              (child) => !child.parentSessionId || child.parentSessionId === parentSessionId,
            ),
          );
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        const serialized = JSON.stringify(rows);
        if (catalogRef.current?.key !== selectionKey || catalogRef.current.rows !== serialized) {
          catalogRef.current = { key: selectionKey, rows: serialized };
          setCatalog({ key: selectionKey, rows });
        }
        setCatalogError(null);
      } catch (cause) {
        // Catalog metadata is optional; the explicitly selected transcript can
        // still load when its parent catalog is unavailable.
        if (activeRef.current && request === catalogGeneration.current) {
          setCatalogError({
            key: selectionKey,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      } finally {
        if (activeRef.current && request === catalogGeneration.current) setLoadingChildren(false);
      }
    },
    [agentId, parentSessionId, selectionKey, setCatalogError, setLoadingChildren],
  );

  useEffect(() => {
    setNavigation({ key: selectionKey, selectedId: agentId });
  }, [agentId, selectionKey]);

  const listItems = useMemo(() => {
    if (!agentId || !parentSessionId) return [];
    const items = new Map<string, SubagentListItem>();
    for (const summary of agents) {
      if (!summary.id) continue;
      items.set(summary.id, {
        id: summary.id,
        title: summary.name || summary.description || summary.id,
        status: summary.error ? "failed" : summary.done ? "completed" : "active",
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
      });
    }
    if (!items.has(agentId)) {
      items.set(agentId, {
        id: agentId,
        title: label || agentId,
        status: running ? "active" : "completed",
      });
    }
    for (const child of children) {
      const previous = items.get(child.engineSessionId);
      items.set(child.engineSessionId, {
        ...previous,
        id: child.engineSessionId,
        title: child.title || previous?.title || child.engineSessionId,
        status: child.status ?? previous?.status ?? "completed",
        updatedAt: child.updatedAt,
      });
    }
    return [...items.values()];
  }, [agentId, agents, children, label, parentSessionId, running]);

  useEffect(() => {
    if (!detailActive) {
      setLoadingChildren(false);
      return;
    }
    void loadChildren();
    return () => {
      catalogGeneration.current += 1;
    };
  }, [detailActive, loadChildren, setLoadingChildren]);

  const selectedStatus = children.find((child) => child.engineSessionId === selectedId)?.status;
  const selectedRunning =
    !!selectedId &&
    (selectedStatus
      ? selectedStatus === "active"
      : listItems.find((child) => child.id === selectedId)?.status === "active" ||
        (selectedId === agentId && running));

  // A poll whose transcript is unchanged leaves every piece of state alone; one
  // that only grew folds the appended items onto the previous messages.
  const refresh = useCallback(
    async (manual = false) => {
      if (!activeRef.current) return;
      const request = ++generation.current;
      if (!selectedId) {
        setLoading(false);
        return;
      }
      const foldKey = JSON.stringify([selectionKey, selectedId]);
      const previous = foldRef.current?.key === foldKey ? foldRef.current.fold : null;
      if (manual || !previous) setLoading(true);
      try {
        const items = await window.codeshell.getSessionTranscript(selectedId);
        if (!activeRef.current || generation.current !== request) return;
        const fold = foldTranscriptIncremental(previous, items, { live: selectedRunning });
        if (fold !== previous) {
          foldRef.current = { key: foldKey, fold };
          setState({ key: selectionKey, sessionId: selectedId, value: fold.value });
        }
        setError(null);
      } catch (cause) {
        if (!activeRef.current || generation.current !== request) return;
        setError(String(cause instanceof Error ? cause.message : cause));
      } finally {
        if (activeRef.current && generation.current === request) setLoading(false);
      }
    },
    [selectedId, selectedRunning, selectionKey, setError, setLoading],
  );

  useEffect(() => {
    foldRef.current = null;
    setState(null);
    setError(null);
  }, [selectedId, selectionKey, setError]);

  useEffect(() => {
    if (!detailActive) {
      setLoading(false);
      return;
    }
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [detailActive, refresh, setLoading]);

  const refreshAll = useCallback(
    (manual = false) => {
      void loadChildren(manual);
      if (selectedId) void refresh(manual);
    },
    [loadChildren, refresh, selectedId],
  );

  const poll = listOpen ? listItems.some((child) => child.status === "active") : selectedRunning;

  useEffect(() => {
    if (!detailActive) return;
    const onChanged = () => refreshAll();
    window.addEventListener("codeshell:files-changed", onChanged);
    const timer = poll
      ? setInterval(() => {
          if (document.visibilityState === "visible") refreshAll();
        }, 3000)
      : undefined;
    return () => {
      window.removeEventListener("codeshell:files-changed", onChanged);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [detailActive, refreshAll, poll]);

  const backToList = () => {
    if (!detailActive) return;
    generation.current += 1;
    navigationFocus.current = "list";
    setNavigation({ key: selectionKey, selectedId: undefined });
    void loadChildren();
  };
  const selectChild = (id: string) => {
    if (!detailActive || !listItems.some((child) => child.id === id)) return;
    navigationFocus.current = "detail";
    setNavigation({ key: selectionKey, selectedId: id });
  };
  const transcript =
    state && state.key === selectionKey && state.sessionId === selectedId ? state.value : null;

  return (
    <section
      ref={sectionRef}
      aria-label={listOpen ? t("msg.agent.listTitle") : t("msg.agent.transcript")}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {((selectedId && parentSessionId) || onBack) && (
          <button
            type="button"
            disabled={!detailActive}
            onClick={selectedId && parentSessionId ? backToList : onBack}
            data-subagent-action={selectedId && parentSessionId ? "back-to-list" : "back-to-parent"}
            aria-label={t(
              selectedId && parentSessionId ? "msg.agent.backToList" : "msg.agent.back",
            )}
            className="rounded p-1 text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {listOpen
              ? t("msg.agent.listTitle")
              : children.find((child) => child.engineSessionId === selectedId)?.title ||
                listItems.find((child) => child.id === selectedId)?.title ||
                label ||
                t("msg.agent.transcript")}
          </div>
          {!listOpen && (
            <div className="text-xs text-muted-foreground">{t("msg.agent.transcript")}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => refreshAll(true)}
          disabled={!detailActive || loading || loadingChildren || (!selectedId && !listOpen)}
          aria-label={t("msg.agent.refresh")}
          className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`size-4${loading || loadingChildren ? " animate-spin" : ""}`} />
        </button>
      </div>
      {!listOpen && error && (
        <div role="alert" className="px-4 py-3 text-sm text-status-err">
          {t("msg.agent.transcriptError", { error })}
        </div>
      )}
      {listOpen ? (
        <SubagentList
          items={listItems}
          active={detailActive}
          loading={loadingChildren}
          error={catalogError?.key === selectionKey ? catalogError.message : null}
          onSelect={selectChild}
        />
      ) : !selectedId ? (
        <div className="p-4 text-sm text-muted-foreground">{t("msg.agent.openFromChat")}</div>
      ) : !transcript || transcript.messages.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          {loading || loadingChildren
            ? t("msg.agent.loadingTranscript")
            : t("msg.agent.emptyTranscript")}
        </div>
      ) : (
        <SubagentDetailActiveContext.Provider value={detailActive}>
          <MessageStream
            key={selectedId}
            messages={transcript.messages}
            engineSessionId={selectedId}
            pageHistory
            readOnly
          />
        </SubagentDetailActiveContext.Provider>
      )}
    </section>
  );
}
