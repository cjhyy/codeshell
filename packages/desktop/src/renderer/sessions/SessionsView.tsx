import React, { useEffect, useState } from "react";
import type { DesktopSessionSummary } from "../../preload/types";

interface Props {
  onNewSession?: () => void;
}

export function SessionsView({ onNewSession }: Props) {
  const [sessions, setSessions] = useState<DesktopSessionSummary[] | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const refresh = async () => {
    try {
      const [list, titleMap] = await Promise.all([
        window.codeshell.listSessions(),
        window.codeshell.listSessionTitles(),
      ]);
      setSessions(list);
      setTitles(titleMap);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (error) return <div className="view-error">无法读取会话: {error}</div>;
  if (!sessions) return <div className="view-loading">加载中…</div>;

  const filtered = filter
    ? sessions.filter(
        (s) =>
          s.id.toLowerCase().includes(filter.toLowerCase()) ||
          (titles[s.id] ?? "").toLowerCase().includes(filter.toLowerCase()),
      )
    : sessions;

  const startEdit = (s: DesktopSessionSummary) => {
    setEditing(s.id);
    setEditDraft(titles[s.id] ?? "");
  };

  const commitEdit = async () => {
    if (!editing) return;
    try {
      await window.codeshell.renameSession(editing, editDraft.trim());
    } catch (err) {
      console.error("renameSession failed", err);
    }
    setEditing(null);
    setEditDraft("");
    void refresh();
  };

  return (
    <div className="sessions-view">
      <div className="sessions-toolbar">
        <input
          className="sessions-filter"
          placeholder="搜索会话 id 或标题…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="approval-btn approve" onClick={onNewSession}>
          新会话
        </button>
        <button className="approval-btn deny" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="approvals-empty">暂无匹配的会话</div>
      ) : (
        <ul className="sessions-list">
          {filtered.map((s) => {
            const title = titles[s.id];
            const isEditing = editing === s.id;
            return (
              <li key={s.id} className="session-row">
                {isEditing ? (
                  <input
                    autoFocus
                    className="sessions-filter"
                    style={{ flex: 1 }}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitEdit();
                      else if (e.key === "Escape") {
                        setEditing(null);
                        setEditDraft("");
                      }
                    }}
                    onBlur={() => void commitEdit()}
                    placeholder="会话标题"
                  />
                ) : (
                  <>
                    <span className="session-id" onDoubleClick={() => startEdit(s)}>
                      {title ? (
                        <>
                          <strong>{title}</strong>{" "}
                          <span className="session-meta">{s.id.slice(0, 8)}</span>
                        </>
                      ) : (
                        s.id
                      )}
                    </span>
                    <button
                      className="session-delete"
                      style={{ color: "var(--fg-muted)" }}
                      onClick={() => startEdit(s)}
                    >
                      重命名
                    </button>
                  </>
                )}
                <span className="session-meta">{formatBytes(s.size)}</span>
                <span className="session-meta">{new Date(s.updatedAt).toLocaleString()}</span>
                <button
                  className="session-delete"
                  onClick={async () => {
                    try {
                      await window.codeshell.deleteSession(s.id);
                    } catch (err) {
                      console.error("deleteSession failed", err);
                    }
                    void refresh();
                  }}
                >
                  删除
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
