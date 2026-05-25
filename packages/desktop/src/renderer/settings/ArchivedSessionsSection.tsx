import React, { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  archiveSession,
  deleteSessionLocal,
  loadSessionIndex,
  NO_REPO_KEY,
  type SessionSummary,
} from "../transcripts";
import { loadRepos, repoLabel, type Repo } from "../repos";

interface Row {
  /** Repo id, or null for no-repo bucket. */
  repoId: string | null;
  repoName: string;
  session: SessionSummary;
}

/**
 * Lists every archived session across all repos + the no-repo bucket
 * and lets the user restore (unarchive) or permanently delete one.
 *
 * The Sidebar no longer surfaces archived sessions — this is the only
 * place they live now, so it must be self-sufficient.
 */
export function ArchivedSessionsSection() {
  const [bump, setBump] = useState(0);

  const rows = useMemo<Row[]>(() => {
    const repos = loadRepos();
    const buckets: Array<{ repoId: string | null; repoName: string }> = [
      ...repos.map((r: Repo) => ({ repoId: r.id, repoName: repoLabel(r) })),
      { repoId: null, repoName: "无项目对话" },
    ];
    const out: Row[] = [];
    for (const b of buckets) {
      const idx = loadSessionIndex(b.repoId);
      for (const s of idx.sessions) {
        if (s.archived) out.push({ repoId: b.repoId, repoName: b.repoName, session: s });
      }
    }
    // Most recent first — same ordering used elsewhere in the app.
    out.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    return out;
    // bump forces re-evaluation after restore/delete; the bucket data
    // lives in localStorage so React doesn't see it change otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump]);

  const restore = (row: Row): void => {
    archiveSession(row.repoId, row.session.id, false);
    setBump((b) => b + 1);
  };

  const remove = (row: Row): void => {
    const ok = window.confirm(`永久删除「${row.session.title}」？此操作不可撤销。`);
    if (!ok) return;
    deleteSessionLocal(row.repoId, row.session.id);
    setBump((b) => b + 1);
  };

  const removeAll = (): void => {
    if (rows.length === 0) return;
    const ok = window.confirm(`永久删除全部 ${rows.length} 条已归档对话？此操作不可撤销。`);
    if (!ok) return;
    for (const r of rows) deleteSessionLocal(r.repoId, r.session.id);
    setBump((b) => b + 1);
  };

  return (
    <section className="archived-section">
      <div className="archived-section-toolbar">
        <button
          type="button"
          className="archived-clear-all"
          onClick={removeAll}
          disabled={rows.length === 0}
        >
          全部删除
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="archived-empty">还没有任何归档对话。</div>
      ) : (
        <ul className="archived-list">
          {rows.map((row) => (
            <li key={`${row.repoId ?? NO_REPO_KEY}:${row.session.id}`} className="archived-row">
              <div className="archived-row-main">
                <span className="archived-row-title">{row.session.title}</span>
                <span className="archived-row-meta">
                  <span className="archived-row-time">{formatTime(row.session.updatedAt)}</span>
                  <span className="archived-row-dot">·</span>
                  <span className="archived-row-repo">{row.repoName}</span>
                </span>
              </div>
              <div className="archived-row-actions">
                <button
                  type="button"
                  className="archived-row-icon-btn"
                  onClick={() => remove(row)}
                  title="永久删除"
                  aria-label="永久删除"
                >
                  <Trash2 size={14} />
                </button>
                <button
                  type="button"
                  className="archived-row-link"
                  onClick={() => restore(row)}
                  title="取消归档"
                >
                  取消归档
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}年${m}月${day}日，${hh}:${mm}`;
}
