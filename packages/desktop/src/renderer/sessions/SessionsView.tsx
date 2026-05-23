import React, { useEffect, useState } from "react";
import type { DesktopSessionSummary } from "../../preload/types";

export function SessionsView() {
  const [sessions, setSessions] = useState<DesktopSessionSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setSessions(await window.codeshell.listSessions());
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
    ? sessions.filter((s) => s.id.toLowerCase().includes(filter.toLowerCase()))
    : sessions;

  return (
    <div className="sessions-view">
      <div className="sessions-toolbar">
        <input
          className="sessions-filter"
          placeholder="搜索会话 id…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="approval-btn deny" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="approvals-empty">暂无匹配的会话</div>
      ) : (
        <ul className="sessions-list">
          {filtered.map((s) => (
            <li key={s.id} className="session-row">
              <span className="session-id">{s.id}</span>
              <span className="session-meta">{formatBytes(s.size)}</span>
              <span className="session-meta">{new Date(s.updatedAt).toLocaleString()}</span>
              <button
                className="session-delete"
                onClick={async () => {
                  await window.codeshell.deleteSession(s.id);
                  void refresh();
                }}
              >
                删除
              </button>
            </li>
          ))}
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
