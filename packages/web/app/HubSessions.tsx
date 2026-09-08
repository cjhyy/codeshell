import React from "react";
import { api, ApiError } from "./auth.js";
import { apiUrl } from "./api-context.js";
import "./hub-library.css";

export interface ManagedSession {
  cwd: string;
  sessionId: string;
  title: string;
  customTitle: string;
  startedAt: number;
  lastActiveAt: number;
  model: string;
  status: string;
  turnCount: number;
  archivedAt: number | null;
  running: boolean;
  preview?: string;
}
interface TitleDraft {
  id: string;
  title: string;
  originalTitle: string;
  expectedTitle: string;
  error?: string;
  conflict?: boolean;
  unavailable?: boolean;
  reviewedTitle?: string;
}

export interface ManagedSessions {
  sessions: ManagedSession[];
  nextCursor: string | null;
}

export async function readManagedSessions(
  options: { query?: string; archived?: string; cursor?: string; signal?: AbortSignal } = {},
): Promise<ManagedSessions> {
  const query = new URLSearchParams({ archived: options.archived ?? "false", limit: "50" });
  if (options.query) query.set("query", options.query);
  if (options.cursor) query.set("cursor", options.cursor);
  return api(`/api/v1/sessions?${query}`, { signal: options.signal });
}

export function sessionExportUrl(id: string, format: "markdown" | "json" = "markdown") {
  return apiUrl(`/api/v1/sessions/${encodeURIComponent(id)}/export?format=${format}`);
}

export function HubSessions({
  onAuthLost,
  onOpen,
  onChanged,
  version = 0,
  onDirtyChange,
}: {
  onAuthLost: () => void;
  onOpen: (id: string) => void;
  onChanged?: () => void;
  version?: number;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [archived, setArchived] = React.useState("false");
  const [entries, setEntries] = React.useState<ManagedSession[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [reload, setReload] = React.useState(0);
  const [busy, setBusy] = React.useState("");
  const [edit, setEdit] = React.useState<TitleDraft | null>(null);
  const titleInput = React.useRef<HTMLInputElement>(null);
  const titleError = React.useRef<HTMLDivElement>(null);
  const editTrigger = React.useRef<HTMLButtonElement | null>(null);
  const searchInput = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (edit?.id) titleInput.current?.focus();
  }, [edit?.id]);
  React.useEffect(() => {
    if (edit?.error) titleError.current?.focus();
  }, [edit?.error]);
  const finishEdit = () => {
    setEdit(null);
    requestAnimationFrame(() => {
      if (editTrigger.current?.isConnected) editTrigger.current.focus();
      else searchInput.current?.focus();
    });
  };
  React.useEffect(() => {
    onDirtyChange?.(!!edit || !!busy);
  }, [edit, busy, onDirtyChange]);
  React.useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const read = React.useRef<AbortController | null>(null);
  const write = React.useRef<AbortController | null>(null);
  const callbacks = React.useRef({ onAuthLost, onChanged, onOpen });
  callbacks.current = { onAuthLost, onChanged, onOpen };
  const report = React.useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) callbacks.current.onAuthLost();
    else setError(cause instanceof Error ? cause.message : "会话操作失败，请重试。");
  }, []);
  React.useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  React.useEffect(() => {
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setError("");
    void readManagedSessions({ query: search, archived, signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) {
          setEntries(data.sessions);
          setCursor(data.nextCursor);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) report(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [search, archived, version, reload, report]);
  React.useEffect(
    () => () => {
      read.current?.abort();
      write.current?.abort();
    },
    [],
  );

  const more = () => {
    if (!cursor || loadingMore || loading) return;
    const controller = new AbortController();
    read.current?.abort();
    read.current = controller;
    setLoadingMore(true);
    void readManagedSessions({ query: search, archived, cursor, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setEntries((current) => {
          const known = new Set(current.map((item) => item.sessionId));
          return [...current, ...data.sessions.filter((item) => !known.has(item.sessionId))];
        });
        setCursor(data.nextCursor);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) report(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
  };

  const mutate = async (
    id: string,
    patch: { title: string; expectedTitle: string } | { archived: boolean },
    open = false,
  ) => {
    if (write.current) return;
    const controller = new AbortController();
    write.current = controller;
    setBusy(id);
    setError("");
    setNotice("");
    if ("title" in patch) setEdit((current) => current && { ...current, error: "" });
    try {
      await api(`/api/v1/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if ("title" in patch) {
        finishEdit();
        setNotice(patch.title ? "标题已保存。" : "已恢复自动标题。");
      } else setNotice(patch.archived ? "对话已归档，可以在“已归档”中恢复。" : "对话已恢复。");
      setReload((value) => value + 1);
      callbacks.current.onChanged?.();
      if (open) callbacks.current.onOpen(id);
    } catch (cause) {
      if (!controller.signal.aborted) {
        if ("title" in patch && !(cause instanceof ApiError && cause.status === 401)) {
          setEdit((current) =>
            current?.id === id
              ? {
                  ...current,
                  error: cause instanceof Error ? cause.message : "标题保存失败，请重试。",
                  conflict: cause instanceof ApiError && cause.status === 409,
                  unavailable: cause instanceof ApiError && cause.status === 404,
                }
              : current,
          );
        } else report(cause);
      }
    } finally {
      if (write.current === controller) write.current = null;
      if (!controller.signal.aborted) setBusy("");
    }
  };
  const refreshTitle = async () => {
    if (!edit || write.current) return;
    const id = edit.id;
    const controller = new AbortController();
    write.current = controller;
    setBusy(id);
    setEdit((current) => current && { ...current, error: "" });
    try {
      const current = await api<ManagedSession>(`/api/v1/sessions/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      // Only an explicit read updates the compare-and-set baseline. Background
      // list refreshes must never silently authorize replacing another device's title.
      setEdit((draft) =>
        draft?.id === id
          ? {
              ...draft,
              expectedTitle: current.customTitle,
              reviewedTitle: current.title,
              conflict: false,
              unavailable: false,
              error: "",
            }
          : draft,
      );
      titleInput.current?.focus();
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 401) report(cause);
        else
          setEdit((draft) =>
            draft?.id === id
              ? {
                  ...draft,
                  error: cause instanceof Error ? cause.message : "无法读取最新标题，请重试。",
                  unavailable: cause instanceof ApiError && cause.status === 404,
                }
              : draft,
          );
      }
    } finally {
      if (write.current === controller) write.current = null;
      if (!controller.signal.aborted) setBusy("");
    }
  };
  const open = (entry: ManagedSession) =>
    entry.archivedAt
      ? void mutate(entry.sessionId, { archived: false }, true)
      : callbacks.current.onOpen(entry.sessionId);

  return (
    <section className="hub-library hub-sessions" aria-labelledby="hub-history-heading">
      <header className="library-heading">
        <div>
          <h1 id="hub-history-heading">历史对话</h1>
          <p>查找、整理并导出当前工作区的对话。</p>
        </div>
        <button className="library-button" onClick={() => setReload((value) => value + 1)}>
          刷新
        </button>
      </header>
      {error ? (
        <div className="library-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <p className="library-hint" role="status">
          {notice}
        </p>
      ) : null}
      <div className="session-toolbar">
        <label className="library-search">
          <span className="sr-only">搜索对话标题</span>
          <input
            ref={searchInput}
            type="search"
            placeholder="搜索对话标题…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">对话范围</span>
          <select value={archived} onChange={(event) => setArchived(event.target.value)}>
            <option value="false">当前对话</option>
            <option value="true">已归档</option>
            <option value="all">全部对话</option>
          </select>
        </label>
      </div>
      {edit ? (
        <form
          className="session-history-editor"
          aria-labelledby="session-title-editor-heading"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && !edit.conflict && !edit.unavailable)
              void mutate(edit.id, { title: edit.title, expectedTitle: edit.expectedTitle });
          }}
        >
          <div>
            <h2 id="session-title-editor-heading">重命名对话</h2>
            <p className="library-hint">正在编辑：{edit.originalTitle}</p>
            {!loading && !entries.some((entry) => entry.sessionId === edit.id) ? (
              <p className="library-hint">此对话已不在当前列表中，标题草稿仍保留在这里。</p>
            ) : null}
          </div>
          {edit.error ? (
            <div
              className="library-error"
              id="session-title-error"
              role="alert"
              tabIndex={-1}
              ref={titleError}
            >
              {edit.error}
            </div>
          ) : null}
          {edit.reviewedTitle ? (
            <p className="session-title-review" role="status">
              最新标题：<strong>{edit.reviewedTitle}</strong>。你的草稿仍保留，请核对后再保存。
            </p>
          ) : null}
          <label>
            <span>对话标题</span>
            <input
              ref={titleInput}
              className="library-title-input"
              value={edit.title}
              maxLength={1024}
              aria-describedby={edit.error ? "session-title-error" : undefined}
              onChange={(event) => {
                const title = event.target.value;
                setEdit((current) => current && { ...current, title });
              }}
              readOnly={!!busy}
            />
          </label>
          <div className="library-actions">
            <button
              type="submit"
              className="library-button primary"
              disabled={!!busy || edit.conflict || edit.unavailable}
            >
              {busy ? "处理中…" : edit.reviewedTitle ? "确认保存我的标题" : "保存标题"}
            </button>
            {edit.conflict || edit.unavailable ? (
              <button
                type="button"
                className="library-button"
                disabled={!!busy}
                onClick={() => void refreshTitle()}
              >
                读取最新标题
              </button>
            ) : null}
            <button type="button" className="library-button" disabled={!!busy} onClick={finishEdit}>
              取消
            </button>
            {edit.expectedTitle ? (
              <button
                type="button"
                className="library-button"
                disabled={!!busy || edit.conflict || edit.unavailable}
                onClick={() =>
                  void mutate(edit.id, { title: "", expectedTitle: edit.expectedTitle })
                }
              >
                使用自动标题
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      <div className="session-history-list" aria-busy={loading}>
        {loading ? (
          <p className="library-empty" role="status">
            正在读取对话…
          </p>
        ) : entries.length === 0 ? (
          <p className="library-empty">
            {search
              ? "没有找到匹配的对话。"
              : archived === "true"
                ? "还没有归档的对话。"
                : "还没有保存的对话，开始一条新对话后会显示在这里。"}
          </p>
        ) : (
          entries.map((entry) => (
            <article className="session-history-row" key={entry.sessionId}>
              <div className="session-history-info">
                <button className="session-history-title" onClick={() => open(entry)}>
                  {entry.title}
                </button>
                {entry.preview && entry.preview !== entry.title ? (
                  <p>{entry.preview.slice(0, 150)}</p>
                ) : null}
                <div className="session-history-meta">
                  <span>{new Date(entry.lastActiveAt || entry.startedAt).toLocaleString()}</span>
                  <span>{entry.turnCount} 轮</span>
                  {entry.running ? (
                    <span>正在运行</span>
                  ) : entry.archivedAt ? (
                    <span>已归档</span>
                  ) : null}
                </div>
              </div>
              <div className="library-actions">
                <button
                  className="library-button"
                  disabled={!!busy || !!edit}
                  onClick={(event) => {
                    editTrigger.current = event.currentTarget;
                    setNotice("");
                    setEdit({
                      id: entry.sessionId,
                      title: entry.title,
                      originalTitle: entry.title,
                      expectedTitle: entry.customTitle,
                    });
                  }}
                >
                  {edit?.id === entry.sessionId ? "正在编辑" : "重命名"}
                </button>
                <button
                  className="library-button"
                  disabled={!!busy || entry.running}
                  onClick={() => void mutate(entry.sessionId, { archived: !entry.archivedAt })}
                >
                  {busy === entry.sessionId ? "处理中…" : entry.archivedAt ? "恢复" : "归档"}
                </button>
                {entry.running ? (
                  <button className="library-button" disabled>
                    运行结束后导出
                  </button>
                ) : (
                  <details className="session-export">
                    <summary className="library-button">导出</summary>
                    <div>
                      <a href={sessionExportUrl(entry.sessionId)} download>
                        Markdown 文档
                      </a>
                      <a href={sessionExportUrl(entry.sessionId, "json")} download>
                        完整 JSON 记录
                      </a>
                    </div>
                  </details>
                )}
              </div>
            </article>
          ))
        )}
      </div>
      {cursor && !loading ? (
        <div className="session-load-more">
          <button className="library-button" disabled={loadingMore} onClick={more}>
            {loadingMore ? "读取中…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
