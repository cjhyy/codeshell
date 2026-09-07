import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  Clock3,
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
import { useT } from "../i18n/I18nProvider";

interface Props {
  onNewSession?: () => void;
  onSessionRenamed?: (id: string, title: string) => void;
  onSessionDeleted?: (id: string) => void;
}

type TitleEdit = { id: string; draft: string; error: string | null };
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function SessionsView({ onNewSession, onSessionRenamed, onSessionDeleted }: Props) {
  const { t } = useT();
  const pageId = useId();
  const [sessions, setSessions] = useState<DesktopSessionSummary[] | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<TitleEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const mounted = useRef(true);
  const readVersion = useRef(0);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const renameRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const version = ++readVersion.current;
    setRefreshing(true);
    try {
      const [list, titleMap] = await Promise.all([
        window.codeshell.listSessions(),
        window.codeshell.listSessionTitles(),
      ]);
      if (!mounted.current || version !== readVersion.current) return;
      setSessions(list);
      setTitles({
        ...Object.fromEntries(list.map((session) => [session.id, session.title ?? ""])),
        ...titleMap,
      });
      setReadError(null);
    } catch (error) {
      if (mounted.current && version === readVersion.current) setReadError(errorMessage(error));
    } finally {
      if (mounted.current && version === readVersion.current) setRefreshing(false);
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
    if (editing || !restoreFocus.current) return;
    const target = renameRefs.current.get(restoreFocus.current) ?? searchRef.current;
    restoreFocus.current = null;
    target?.focus({ preventScroll: true });
  }, [editing, sessions, deleting]);

  const query = filter.trim().toLowerCase();
  const filtered = (sessions ?? []).filter(
    (session) =>
      !query ||
      session.id.toLowerCase().includes(query) ||
      (titles[session.id] ?? "").toLowerCase().includes(query),
  );

  const startEdit = (session: DesktopSessionSummary) => {
    if (editing || refreshing || deletingRef.current) return;
    setEditing({ id: session.id, draft: titles[session.id] ?? "", error: null });
  };

  const closeEditor = (id: string) => {
    // A save may finish after focus has moved elsewhere. Only restore focus
    // when this editor still owns it, or its pending button lost browser focus.
    if (
      document.activeElement === document.body ||
      editorRef.current?.contains(document.activeElement)
    ) {
      restoreFocus.current = id;
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
      if (
        document.activeElement === document.body ||
        editorRef.current?.contains(document.activeElement)
      ) {
        inputRef.current?.focus();
      }
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const removeSession = async (session: DesktopSessionSummary, row: HTMLElement | null) => {
    if (deletingRef.current || editing || savingRef.current) return;
    deletingRef.current = true;
    setDeleting(session.id);
    setDeleteError(null);
    try {
      await window.codeshell.deleteSession(session.id);
      onSessionDeleted?.(session.id);
      if (!mounted.current) return;
      if (document.activeElement === document.body || row?.contains(document.activeElement))
        restoreFocus.current = "search";
      setSessions((current) => current?.filter((item) => item.id !== session.id) ?? null);
    } catch (error) {
      if (mounted.current) setDeleteError({ id: session.id, message: errorMessage(error) });
    } finally {
      deletingRef.current = false;
      if (mounted.current) setDeleting(null);
    }
  };

  const clearFilter = () => {
    setFilter("");
    searchRef.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-muted/10" data-sessions-page>
      <div className="mx-auto flex w-full max-w-5xl shrink-0 flex-wrap items-center justify-between gap-3 px-4 pt-6 sm:px-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-card text-primary">
            <MessageSquare size={20} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {t("auto.sessions.title")}
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

      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-5 sm:px-6">
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
              disabled={!!editing}
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-0.5 top-0.5 size-8 rounded-lg text-muted-foreground"
                disabled={!!editing}
                aria-label={t("auto.sessions.clearSearch")}
                onClick={clearFilter}
              >
                <X size={14} aria-hidden />
              </Button>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="rounded-lg"
            disabled={refreshing || !!editing || !!deleting}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} aria-hidden className={refreshing ? "animate-spin" : undefined} />
            {t("auto.sessions.refresh")}
          </Button>
        </div>

        {readError && (
          <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-status-err/25 bg-status-err/5 p-3 text-sm">
            <p
              role="alert"
              className="min-w-0 flex-1 break-words text-status-err [overflow-wrap:anywhere]"
            >
              {t("auto.sessions.readError", { error: readError })}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={refreshing || !!editing || !!deleting}
              onClick={() => void refresh()}
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
              <div className="overflow-y-auto rounded-2xl border border-dashed border-border/80 bg-card/50 px-5 py-10 text-center">
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
                aria-label={t("auto.sessions.title")}
                className="min-h-0 min-w-0 space-y-2 overflow-y-auto pb-1"
              >
                {filtered.map((session) => {
                  const title = titles[session.id];
                  const isEditing = editing?.id === session.id;
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
                              className="rounded-lg"
                              disabled={saving}
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
                          <div
                            className="min-w-0 flex-1 basis-48"
                            onDoubleClick={() => startEdit(session)}
                          >
                            <h2 className="break-words text-sm font-semibold leading-relaxed text-foreground [overflow-wrap:anywhere]">
                              {title || t("auto.sessions.untitled")}
                            </h2>
                            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                              {session.id}
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button
                              ref={(node) => {
                                if (node) renameRefs.current.set(session.id, node);
                                else renameRefs.current.delete(session.id);
                              }}
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="rounded-lg text-muted-foreground"
                              disabled={!!editing || !!deleting || refreshing}
                              onClick={() => startEdit(session)}
                            >
                              <Pencil size={13} aria-hidden />
                              {t("auto.sessions.rename")}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="rounded-lg text-muted-foreground hover:bg-status-err/10 hover:text-status-err"
                              disabled={!!editing || !!deleting || refreshing}
                              aria-label={t("auto.sessions.deleteNamed", {
                                title: title || session.id,
                              })}
                              onClick={(event) =>
                                void removeSession(session, event.currentTarget.closest("li"))
                              }
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
                          <time dateTime={new Date(session.updatedAt).toISOString()}>
                            {new Date(session.updatedAt).toLocaleString()}
                          </time>
                        </span>
                        <span>{formatBytes(session.size)}</span>
                      </div>
                      {deleteError?.id === session.id && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                          <p
                            role="alert"
                            className="min-w-0 flex-1 break-words text-sm text-status-err [overflow-wrap:anywhere]"
                          >
                            {t("auto.sessions.deleteError", { error: deleteError.message })}
                          </p>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!!deleting || !!editing}
                            onClick={(event) =>
                              void removeSession(session, event.currentTarget.closest("li"))
                            }
                          >
                            {t("auto.sessions.retry")}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
