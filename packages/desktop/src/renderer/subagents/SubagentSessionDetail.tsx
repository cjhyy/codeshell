import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { MessageStream } from "../MessageStream";
import { foldTranscript } from "../automation/foldTranscript";
import { useT } from "../i18n/I18nProvider";
import type { MessagesReducerState } from "../types";
import type { SubagentSelection } from "./SubagentNavigation";

type ChildSession = Awaited<
  ReturnType<typeof window.codeshell.listDiskSessions>
>["sessions"][number];

// Nested child details share the dock's visibility even when MessageStream owns
// their local navigation state.
const SubagentDetailActiveContext = React.createContext(true);

/** Read the existing child transcript without registering it in the main session
 * index. One detail surface can navigate nested children through MessageStream. */
export function SubagentSessionDetail({
  agentId,
  parentSessionId,
  label,
  running = false,
  active = true,
  onBack,
}: SubagentSelection & { active?: boolean; onBack?: () => void }) {
  const { t } = useT();
  const parentActive = React.useContext(SubagentDetailActiveContext);
  const detailActive = active && parentActive;
  const activeRef = useRef(detailActive);
  activeRef.current = detailActive;
  const selectedId = agentId;
  const [children, setChildren] = useState<ChildSession[]>([]);
  const [state, setState] = useState<MessagesReducerState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const catalogGeneration = useRef(0);

  const loadChildren = useCallback(async () => {
    if (!activeRef.current || !agentId || !parentSessionId) return;
    const request = ++catalogGeneration.current;
    setLoadingChildren(true);
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
        rows.push(...page.sessions);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      setChildren(rows);
    } catch {
      // Catalog metadata is optional; the explicitly selected transcript can
      // still load when its parent catalog is unavailable.
    } finally {
      if (activeRef.current && request === catalogGeneration.current) setLoadingChildren(false);
    }
  }, [agentId, parentSessionId]);

  useEffect(() => {
    setChildren([]);
  }, [agentId, parentSessionId]);

  useEffect(() => {
    if (!detailActive) {
      setLoadingChildren(false);
      return;
    }
    void loadChildren();
    return () => {
      catalogGeneration.current += 1;
    };
  }, [detailActive, loadChildren]);

  const selectedStatus = children.find((child) => child.engineSessionId === selectedId)?.status;
  const selectedRunning = !!selectedId && (selectedStatus ? selectedStatus === "active" : running);

  const refresh = useCallback(async () => {
    if (!activeRef.current) return;
    const request = ++generation.current;
    if (!selectedId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const items = await window.codeshell.getSessionTranscript(selectedId);
      if (!activeRef.current || generation.current !== request) return;
      setState(foldTranscript(items, { live: selectedRunning }));
      setError(null);
    } catch (cause) {
      if (!activeRef.current || generation.current !== request) return;
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (activeRef.current && generation.current === request) setLoading(false);
    }
  }, [selectedId, selectedRunning]);

  useEffect(() => {
    setState(null);
    setError(null);
  }, [selectedId]);

  useEffect(() => {
    if (!detailActive) {
      setLoading(false);
      return;
    }
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [detailActive, refresh]);

  const refreshAll = useCallback(() => {
    void loadChildren();
    void refresh();
  }, [loadChildren, refresh]);

  useEffect(() => {
    if (!detailActive) return;
    const onChanged = refreshAll;
    window.addEventListener("codeshell:files-changed", onChanged);
    const timer = selectedRunning
      ? setInterval(() => {
          if (document.visibilityState === "visible") refreshAll();
        }, 3000)
      : undefined;
    return () => {
      window.removeEventListener("codeshell:files-changed", onChanged);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [detailActive, refreshAll, selectedRunning]);

  return (
    <section
      aria-label={t("msg.agent.transcript")}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("msg.agent.back")}
            className="rounded p-1 text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {children.find((child) => child.engineSessionId === selectedId)?.title ||
              label ||
              t("msg.agent.transcript")}
          </div>
          <div className="text-xs text-muted-foreground">{t("msg.agent.transcript")}</div>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          disabled={!detailActive || loading || loadingChildren || !selectedId}
          aria-label={t("msg.agent.refresh")}
          className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`size-4${loading || loadingChildren ? " animate-spin" : ""}`} />
        </button>
      </div>
      {error && (
        <div role="alert" className="px-4 py-3 text-sm text-status-err">
          {t("msg.agent.transcriptError", { error })}
        </div>
      )}
      {!selectedId ? (
        <div className="p-4 text-sm text-muted-foreground">{t("msg.agent.openFromChat")}</div>
      ) : !state || state.messages.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          {loading || loadingChildren
            ? t("msg.agent.loadingTranscript")
            : t("msg.agent.emptyTranscript")}
        </div>
      ) : (
        <SubagentDetailActiveContext.Provider value={detailActive}>
          <MessageStream messages={state.messages} engineSessionId={selectedId} readOnly />
        </SubagentDetailActiveContext.Provider>
      )}
    </section>
  );
}
