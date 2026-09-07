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

/** Read the existing child transcript without registering it in the main session
 * index. One detail surface can navigate nested children through MessageStream. */
export function SubagentSessionDetail({
  agentId,
  parentSessionId,
  label,
  running = false,
  onBack,
}: SubagentSelection & { onBack: () => void }) {
  const { t } = useT();
  const [selectedId, setSelectedId] = useState(agentId);
  const [children, setChildren] = useState<ChildSession[]>([]);
  const [state, setState] = useState<MessagesReducerState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const generation = useRef(0);
  const catalogGeneration = useRef(0);

  const loadChildren = useCallback(async () => {
    if (!parentSessionId) return;
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
        if (request !== catalogGeneration.current) return;
        rows.push(...page.sessions);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      setChildren(rows);
      if (!agentId && rows.length === 1)
        setSelectedId((current) => current ?? rows[0].engineSessionId);
      setCatalogError(null);
    } catch (cause) {
      if (request === catalogGeneration.current && !agentId) {
        setCatalogError(String(cause instanceof Error ? cause.message : cause));
      }
    } finally {
      if (request === catalogGeneration.current) setLoadingChildren(false);
    }
  }, [agentId, parentSessionId]);

  useEffect(() => {
    setSelectedId(agentId);
    setChildren([]);
    void loadChildren();
    return () => {
      catalogGeneration.current += 1;
    };
  }, [agentId, loadChildren]);

  const selectedStatus = children.find((child) => child.engineSessionId === selectedId)?.status;
  const selectedRunning = selectedStatus ? selectedStatus === "active" : running;

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!selectedId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const items = await window.codeshell.getSessionTranscript(selectedId);
      if (generation.current !== request) return;
      setState(foldTranscript(items, { live: selectedRunning }));
      setError(null);
    } catch (cause) {
      if (generation.current !== request) return;
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [selectedId, selectedRunning]);

  useEffect(() => {
    setState(null);
    setError(null);
  }, [selectedId]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  const refreshAll = useCallback(() => {
    void loadChildren();
    void refresh();
  }, [loadChildren, refresh]);

  useEffect(() => {
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
  }, [refreshAll, selectedRunning]);

  return (
    <section
      aria-label={t("msg.agent.transcript")}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("msg.agent.back")}
          className="rounded p-1 text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" />
        </button>
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
          disabled={loading || loadingChildren || (!selectedId && !parentSessionId)}
          aria-label={t("msg.agent.refresh")}
          className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`size-4${loading || loadingChildren ? " animate-spin" : ""}`} />
        </button>
      </div>
      {children.length > 1 && (
        <select
          aria-label={t("msg.agent.chooseChild")}
          value={selectedId ?? ""}
          className="m-2 min-w-0 rounded border border-border bg-background p-2 text-sm"
          onChange={(event) => setSelectedId(event.target.value || undefined)}
        >
          <option value="">{t("msg.agent.chooseChild")}</option>
          {agentId && !children.some((child) => child.engineSessionId === agentId) && (
            <option value={agentId}>{label || agentId}</option>
          )}
          {children.map((child) => (
            <option key={child.engineSessionId} value={child.engineSessionId}>
              {child.title || child.engineSessionId}
            </option>
          ))}
        </select>
      )}
      {(error || catalogError) && (
        <div role="alert" className="px-4 py-3 text-sm text-status-err">
          {t("msg.agent.transcriptError", { error: error || catalogError || "" })}
        </div>
      )}
      {!state || state.messages.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          {loading || loadingChildren
            ? t("msg.agent.loadingTranscript")
            : !selectedId && children.length > 1
              ? t("msg.agent.chooseChild")
              : t("msg.agent.emptyTranscript")}
        </div>
      ) : (
        <MessageStream messages={state.messages} engineSessionId={selectedId} readOnly />
      )}
    </section>
  );
}
