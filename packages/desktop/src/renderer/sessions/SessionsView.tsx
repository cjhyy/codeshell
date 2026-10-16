import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Check,
  Clock3,
  Eye,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { DesktopSessionSummary } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/utils";
import { OperationBatchForm } from "../task-inbox/OperationBatchForm";
import { useT } from "../i18n/I18nProvider";

interface Props {
  onOpenTrace?: (sessionId?: string, traceId?: string) => void;
  onNewSession?: () => void;
  onOpenSession?: (id: string) => void | boolean | Promise<void | boolean>;
  onSessionRenamed?: (id: string, title: string) => void;
  onSessionDeleted?: (id: string) => void;
}

type TitleEdit = { id: string; draft: string; error: string | null };
const SessionHistoryDetail = React.lazy(() =>
  import("./SessionHistoryDetail").then((module) => ({ default: module.SessionHistoryDetail })),
);
type FocusRestore =
  | { kind: "rename" | "delete"; id: string; source: HTMLElement | null }
  | { kind: "search"; source: HTMLElement };
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const PAGE_SIZE = 50;
type SessionSort = "newest" | "oldest" | "title";
const validUpdatedAt = (session: DesktopSessionSummary) => {
  const time = new Date(session.updatedAt).getTime();
  return Number.isFinite(time) ? time : 0;
};

export function SessionsView({
  onNewSession,
  onOpenTrace,
  onOpenSession,
  onSessionRenamed,
  onSessionDeleted,
}: Props) {
  const { t, lang } = useT();
  const pageId = useId();
  const [sessions, setSessions] = useState<DesktopSessionSummary[] | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SessionSort>("newest");
  const [page, setPage] = useState(1);
  const [readError, setReadError] = useState<string | null>(null);
  const [titlesError, setTitlesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<TitleEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ id: string; message: string } | null>(null);
  const [viewing, setViewing] = useState<{ id: string; title: string } | null>(null);
  const returnToList = useRef(false);
  const mounted = useRef(true);
  const readVersion = useRef(0);
  const readPending = useRef(false);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const openingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const renameRefs = useRef(new Map<string, HTMLButtonElement>());
  const deleteRefs = useRef(new Map<string, HTMLButtonElement>());
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<FocusRestore | null>(null);
  useLayoutEffect(() => {
    if (!viewing && returnToList.current) {
      returnToList.current = false;
      searchRef.current?.focus({ preventScroll: true });
    }
  }, [viewing]);

  const refresh = useCallback(async (retrySource?: HTMLElement) => {
    const version = ++readVersion.current;
    readPending.current = true;
    setRefreshing(true);
    try {
      const [listResult, titlesResult] = await Promise.allSettled([
        window.codeshell.listSessions(),
        window.codeshell.listSessionTitles(),
      ]);
      if (!mounted.current || version !== readVersion.current) return;
      if (listResult.status === "rejected") throw listResult.reason;
      const list = listResult.value;
      if (retrySource && document.activeElement === retrySource) {
        restoreFocus.current = { kind: "search", source: retrySource };
      }
      setSessions(list);
      setTitles((current) => ({
        ...Object.fromEntries(list.map((session) => [session.id, session.title ?? ""])),
        ...(titlesResult.status === "fulfilled" ? titlesResult.value : current),
      }));
      setTitlesError(titlesResult.status === "rejected" ? errorMessage(titlesResult.reason) : null);
      setReadError(null);
    } catch (error) {
      if (mounted.current && version === readVersion.current) setReadError(errorMessage(error));
    } finally {
      if (mounted.current && version === readVersion.current) {
        readPending.current = false;
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      readVersion.current += 1;
    };
  }, [refresh]);

  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing?.id]);

  useLayoutEffect(() => {
    if (pendingDelete) cancelDeleteRef.current?.focus();
  }, [pendingDelete]);

  useLayoutEffect(() => {
    const request = restoreFocus.current;
    if (editing || pendingDelete || !request) return;
    restoreFocus.current = null;
    if (document.activeElement !== document.body && document.activeElement !== request.source) {
      return;
    }
    const target =
      request.kind !== "search"
        ? ((request.kind === "rename" ? renameRefs : deleteRefs).current.get(request.id) ??
          searchRef.current)
        : searchRef.current;
    target?.focus();
  }, [editing, pendingDelete, sessions, deleting, readError]);

  const requestRefresh = (retrySource?: HTMLElement) => {
    if (
      readPending.current ||
      editing ||
      pendingDelete ||
      deletingRef.current ||
      openingRef.current
    )
      return;
    void refresh(retrySource);
  };

  const query = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    const tokens = query.split(/\s+/).filter(Boolean);
    return (sessions ?? [])
      .filter((session) => {
        const text = `${session.id} ${titles[session.id] ?? ""}`.toLowerCase();
        return tokens.every((token) => text.includes(token));
      })
      .sort((left, right) => {
        if (sort === "title") {
          const titleOrder = (titles[left.id] || left.id).localeCompare(
            titles[right.id] || right.id,
            lang,
          );
          if (titleOrder) return titleOrder;
        } else {
          const dateOrder = validUpdatedAt(left) - validUpdatedAt(right);
          if (dateOrder) return sort === "newest" ? -dateOrder : dateOrder;
        }
        return left.id.localeCompare(right.id);
      });
  }, [sessions, titles, query, sort, lang]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  useEffect(() => {
    setPage((current) => Math.min(current, pages));
  }, [pages]);
  const visibleSessions = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const locked = !!editing || !!pendingDelete || !!opening;
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [lang],
  );

  const openSession = async (id: string) => {
    if (!onOpenSession || locked || openingRef.current || readPending.current) return;
    openingRef.current = true;
    setOpening(id);
    setOpenError(null);
    try {
      const opened = await onOpenSession(id);
      if (opened === false && mounted.current) {
        setViewing({ id, title: titles[id] || t("auto.sessions.untitled") });
      }
    } catch (error) {
      if (mounted.current) setOpenError({ id, message: errorMessage(error) });
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(null);
    }
  };

  const startEdit = (session: DesktopSessionSummary) => {
    if (locked || readPending.current || deletingRef.current) return;
    setEditing({ id: session.id, draft: titles[session.id] ?? "", error: null });
  };

  const closeEditor = (id: string) => {
    // A save may finish after focus has moved elsewhere. Only restore focus
    // when this editor still owns it.
    if (editorRef.current?.contains(document.activeElement)) {
      restoreFocus.current = {
        kind: "rename",
        id,
        source: document.activeElement as HTMLElement,
      };
    }
    setEditing(null);
  };

  const commitEdit = async () => {
    if (!editing || savingRef.current) return;
    const { id, draft } = editing;
    const title = draft.trim();
    if (title === (titles[id] ?? "")) {
      closeEditor(id);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setEditing((current) => current && { ...current, error: null });
    try {
      await window.codeshell.renameSession(id, title);
      // An empty title removes the UI override; show the durable title now,
      // just as the next refresh will, and keep the sidebar in sync.
      const displayTitle = title || sessions?.find((session) => session.id === id)?.title || "";
      onSessionRenamed?.(id, displayTitle);
      if (!mounted.current) return;
      setTitles((current) => ({ ...current, [id]: displayTitle }));
      closeEditor(id);
    } catch (error) {
      if (!mounted.current) return;
      setEditing((current) =>
        current?.id === id ? { ...current, error: errorMessage(error) } : current,
      );
      if (editorRef.current?.contains(document.activeElement)) {
        inputRef.current?.focus();
      }
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const removeSession = async (session: DesktopSessionSummary, row: HTMLElement | null) => {
    if (
      pendingDelete !== session.id ||
      deletingRef.current ||
      editing ||
      savingRef.current ||
      readPending.current
    )
      return;
    deletingRef.current = true;
    setDeleting(session.id);
    // Keep a retry action mounted while its request is pending so keyboard
    // focus survives both another failure and the eventual successful removal.
    setDeleteError((current) => (current?.id === session.id ? current : null));
    try {
      await window.codeshell.deleteSession(session.id);
      onSessionDeleted?.(session.id);
      if (!mounted.current) return;
      if (row?.contains(document.activeElement))
        restoreFocus.current = { kind: "search", source: document.activeElement as HTMLElement };
      setSessions((current) => current?.filter((item) => item.id !== session.id) ?? null);
      setPendingDelete(null);
      setDeleteError(null);
    } catch (error) {
      if (mounted.current) setDeleteError({ id: session.id, message: errorMessage(error) });
    } finally {
      deletingRef.current = false;
      if (mounted.current) setDeleting(null);
    }
  };

  const clearFilter = () => {
    setFilter("");
    setPage(1);
    searchRef.current?.focus();
  };

  const cancelDelete = (id: string) => {
    if (deletingRef.current) return;
    restoreFocus.current = { kind: "delete", id, source: document.activeElement as HTMLElement };
    setPendingDelete(null);
    setDeleteError(null);
  };

  if (viewing)
    return (
      <React.Suspense
        fallback={
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {t("auto.sessions.loading")}
          </p>
        }
      >
        <SessionHistoryDetail
          sessionId={viewing.id}
          title={viewing.title}
          onBack={() => {
            returnToList.current = true;
            setViewing(null);
          }}
        />
      </React.Suspense>
    );

  return (
    <div
      role="region"
      aria-labelledby={`${pageId}-title`}
      tabIndex={0}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain bg-muted/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      data-sessions-page
    >
      <div className="mx-auto flex w-full max-w-5xl shrink-0 flex-wrap items-center justify-between gap-3 px-4 pt-6 sm:px-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-card text-primary">
            <MessageSquare size={20} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1
              id={`${pageId}-title`}
              className="text-xl font-semibold tracking-tight text-foreground"
            >
              {t("activity.conversations")}
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {t("auto.sessions.description")}
            </p>
          </div>
        </div>
        {onNewSession && (
          <Button type="button" className="rounded-xl" onClick={onNewSession}>
            <Plus size={16} aria-hidden />
            {t("auto.sessions.newSession")}
          </Button>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-5xl shrink-0 flex-col gap-4 px-4 py-5 sm:px-6">
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-border/70 bg-card p-2.5">
          <div role="search" className="relative min-w-0 flex-1 basis-48">
            <Search
              size={16}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              type="search"
              className="h-9 rounded-xl border-transparent bg-muted/40 pl-9 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
              placeholder={t("auto.sessions.searchPlaceholder")}
              aria-label={t("auto.sessions.searchPlaceholder")}
              value={filter}
              disabled={locked}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(1);
              }}
            />
            {filter && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-0.5 top-0.5 size-8 rounded-lg text-muted-foreground"
                disabled={locked}
                aria-label={t("auto.sessions.clearSearch")}
                onClick={clearFilter}
              >
                <X size={14} aria-hidden />
              </Button>
            )}
          </div>
          <select
            aria-label={t("activitySessions.sort")}
            value={sort}
            disabled={locked}
            className="h-9 max-w-full rounded-lg border border-border bg-background px-2 text-sm disabled:opacity-50"
            onChange={(event) => {
              setSort(event.target.value as SessionSort);
              setPage(1);
            }}
          >
            <option value="newest">{t("activitySessions.newest")}</option>
            <option value="oldest">{t("activitySessions.oldest")}</option>
            <option value="title">{t("activitySessions.title")}</option>
          </select>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="rounded-lg aria-disabled:cursor-wait aria-disabled:opacity-50"
            aria-disabled={refreshing || locked}
            onClick={() => requestRefresh()}
          >
            <RefreshCw size={14} aria-hidden className={refreshing ? "animate-spin" : undefined} />
            {t("auto.sessions.refresh")}
          </Button>
        </div>

        {(readError || titlesError) && (
          <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-status-err/25 bg-status-err/5 p-3 text-sm">
            <p
              role="alert"
              className="min-w-0 flex-1 break-words text-status-err [overflow-wrap:anywhere]"
            >
              {readError
                ? t("auto.sessions.readError", { error: readError })
                : t("activitySessions.titlesError", { error: titlesError ?? "" })}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="aria-disabled:cursor-wait aria-disabled:opacity-50"
              aria-disabled={refreshing || locked}
              onClick={(event) => requestRefresh(event.currentTarget)}
            >
              {t("auto.sessions.retry")}
            </Button>
          </div>
        )}

        {sessions === null ? (
          refreshing && (
            <div
              role="status"
              className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
            >
              <Loader2 size={16} className="animate-spin" aria-hidden />
              {t("auto.sessions.loading")}
            </div>
          )
        ) : (
          <>
            <p role="status" className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">
              {t("auto.sessions.resultCount", { count: filtered.length, total: sessions.length })}
            </p>
            {filtered.length === 0 ? (
              <div className="min-h-40 shrink-0 overflow-y-auto rounded-2xl border border-dashed border-border/80 bg-card/50 px-5 py-10 text-center">
                <MessageSquare size={24} aria-hidden className="mx-auto text-muted-foreground" />
                <h2 className="mt-3 text-base font-medium">
                  {t(query ? "auto.sessions.noMatch" : "auto.sessions.emptyTitle")}
                </h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                  {t(query ? "auto.sessions.noMatchHint" : "auto.sessions.emptyHint")}
                </p>
                {query && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-4 rounded-lg"
                    onClick={clearFilter}
                  >
                    {t("auto.sessions.clearSearch")}
                  </Button>
                )}
              </div>
            ) : (
              <ul
                aria-label={t("activity.conversations")}
                className="min-h-40 min-w-0 shrink-0 space-y-2 pb-1"
              >
                {visibleSessions.map((session) => {
                  const title = titles[session.id];
                  const isEditing = editing?.id === session.id;
                  const updatedAt = new Date(session.updatedAt);
                  const validDate = Number.isFinite(updatedAt.getTime());
                  return (
                    <li
                      key={session.id}
                      className="min-w-0 rounded-2xl border border-border/70 bg-card p-4"
                    >
                      {isEditing ? (
                        <div ref={editorRef} className="space-y-2">
                          <Input
                            ref={inputRef}
                            aria-label={t("auto.sessions.titlePlaceholder")}
                            aria-invalid={!!editing.error}
                            aria-describedby={
                              editing.error ? `${pageId}-edit-error` : `${pageId}-edit-hint`
                            }
                            className="h-9 rounded-xl"
                            value={editing.draft}
                            readOnly={saving}
                            onChange={(event) => {
                              if (!savingRef.current)
                                setEditing({ ...editing, draft: event.target.value });
                            }}
                            placeholder={t("auto.sessions.titlePlaceholder")}
                            onKeyDown={(event) => {
                              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                              if (event.key === "Enter") {
                                event.preventDefault();
                                event.stopPropagation();
                                void commitEdit();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                if (!savingRef.current) closeEditor(session.id);
                              }
                            }}
                          />
                          <p id={`${pageId}-edit-hint`} className="text-xs text-muted-foreground">
                            {t("auto.sessions.editHint")}
                          </p>
                          {editing.error && (
                            <p
                              id={`${pageId}-edit-error`}
                              role="alert"
                              className="break-words text-sm text-status-err [overflow-wrap:anywhere]"
                            >
                              {t("auto.sessions.renameError", { error: editing.error })}
                            </p>
                          )}
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="rounded-lg"
                              disabled={saving}
                              onClick={() => closeEditor(session.id)}
                            >
                              {t("auto.sessions.cancel")}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              className="rounded-lg aria-disabled:cursor-wait aria-disabled:opacity-50"
                              aria-disabled={saving}
                              onClick={() => void commitEdit()}
                            >
                              {saving ? (
                                <Loader2 size={14} className="animate-spin" aria-hidden />
                              ) : (
                                <Check size={14} aria-hidden />
                              )}
                              {t(saving ? "auto.sessions.saving" : "auto.sessions.save")}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1 basis-48">
                            <h2 className="break-words text-sm font-semibold leading-relaxed text-foreground [overflow-wrap:anywhere]">
                              {onOpenSession ? (
                                <button
                                  type="button"
                                  className="rounded text-left hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                  disabled={locked || refreshing}
                                  title={t("activitySessions.openNamed", {
                                    title: title || session.id,
                                  })}
                                  onClick={() => void openSession(session.id)}
                                >
                                  {title || t("auto.sessions.untitled")}
                                </button>
                              ) : (
                                title || t("auto.sessions.untitled")
                              )}
                            </h2>
                            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                              {session.id}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            <OperationBatchForm sessionId={session.id} />
                            {onOpenTrace && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => onOpenTrace(session.id)}
                              >
                                {t("activity.viewTrace")}
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="rounded-lg"
                              disabled={locked || refreshing}
                              onClick={() =>
                                setViewing({
                                  id: session.id,
                                  title: title || t("auto.sessions.untitled"),
                                })
                              }
                            >
                              <Eye size={13} aria-hidden />
                              {t("activitySessions.viewRecord")}
                            </Button>
                            {onOpenSession && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="rounded-lg aria-disabled:cursor-wait aria-disabled:opacity-50"
                                disabled={(locked && opening !== session.id) || refreshing}
                                aria-disabled={opening === session.id}
                                onClick={() => void openSession(session.id)}
                              >
                                {opening === session.id ? (
                                  <Loader2 size={13} className="animate-spin" aria-hidden />
                                ) : (
                                  <ArrowUpRight size={13} aria-hidden />
                                )}
                                {t(
                                  opening === session.id
                                    ? "activitySessions.opening"
                                    : "activitySessions.open",
                                )}
                              </Button>
                            )}
                            <Button
                              ref={(node) => {
                                if (node) renameRefs.current.set(session.id, node);
                                else renameRefs.current.delete(session.id);
                              }}
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="rounded-lg text-muted-foreground"
                              disabled={locked || refreshing}
                              onClick={() => startEdit(session)}
                            >
                              <Pencil size={13} aria-hidden />
                              {t("auto.sessions.rename")}
                            </Button>
                            <Button
                              ref={(node) => {
                                if (node) deleteRefs.current.set(session.id, node);
                                else deleteRefs.current.delete(session.id);
                              }}
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="rounded-lg text-muted-foreground hover:bg-status-err/10 hover:text-status-err aria-disabled:cursor-wait aria-disabled:opacity-50"
                              disabled={locked || refreshing}
                              aria-label={t("auto.sessions.deleteNamed", {
                                title: title || session.id,
                              })}
                              onClick={() => {
                                if (locked || readPending.current) return;
                                setDeleteError(null);
                                setPendingDelete(session.id);
                              }}
                            >
                              {deleting === session.id ? (
                                <Loader2 size={13} className="animate-spin" aria-hidden />
                              ) : (
                                <Trash2 size={13} aria-hidden />
                              )}
                              {t("auto.sessions.delete")}
                            </Button>
                          </div>
                        </div>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <Clock3 size={12} aria-hidden />
                          <time dateTime={validDate ? updatedAt.toISOString() : undefined}>
                            {validDate
                              ? dateFormatter.format(updatedAt)
                              : t("activitySessions.unknownDate")}
                          </time>
                        </span>
                        <span>{formatBytes(session.size)}</span>
                      </div>
                      {openError?.id === session.id && (
                        <p
                          role="alert"
                          className="mt-3 break-words text-sm text-status-err [overflow-wrap:anywhere]"
                        >
                          {t("activitySessions.openError", { error: openError.message })}
                        </p>
                      )}
                      {pendingDelete === session.id && (
                        <div
                          className="mt-3 space-y-3 rounded-xl border border-status-err/25 bg-status-err/5 p-3"
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.stopPropagation();
                              cancelDelete(session.id);
                            }
                          }}
                        >
                          <p className="break-words text-sm [overflow-wrap:anywhere]">
                            {t("activitySessions.deleteWarning", { title: title || session.id })}
                          </p>
                          {deleteError?.id === session.id && (
                            <p
                              role="alert"
                              className="min-w-0 flex-1 break-words text-sm text-status-err [overflow-wrap:anywhere]"
                            >
                              {t("auto.sessions.deleteError", { error: deleteError.message })}
                            </p>
                          )}
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              ref={cancelDeleteRef}
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!!deleting}
                              onClick={() => cancelDelete(session.id)}
                            >
                              {t("auto.sessions.cancel")}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="aria-disabled:cursor-wait aria-disabled:opacity-50"
                              aria-disabled={deleting === session.id || refreshing}
                              onClick={(event) =>
                                void removeSession(session, event.currentTarget.closest("li"))
                              }
                            >
                              {deleting === session.id && (
                                <Loader2 size={13} className="animate-spin" aria-hidden />
                              )}
                              {t(
                                deleteError?.id === session.id
                                  ? "auto.sessions.retry"
                                  : "activitySessions.confirmDelete",
                              )}
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {pages > 1 && (
              <nav
                aria-label={t("activity.conversations")}
                className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3"
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={locked || currentPage === 1}
                  onClick={() => {
                    setPage(currentPage - 1);
                    searchRef.current?.focus();
                  }}
                >
                  {t("activitySessions.previous")}
                </Button>
                <span role="status" className="text-xs tabular-nums text-muted-foreground">
                  {t("activitySessions.page", { page: currentPage, pages })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={locked || currentPage === pages}
                  onClick={() => {
                    setPage(currentPage + 1);
                    searchRef.current?.focus();
                  }}
                >
                  {t("activitySessions.next")}
                </Button>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  );
}
