import React, { useMemo, useState } from "react";
import { ArchiveRestore, Trash2 } from "lucide-react";
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

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">已归档对话</h3>
      <p className="settings-section-help">
        归档后从侧栏隐藏的会话集中在这里。可以恢复到侧栏，或永久删除。
      </p>

      {rows.length === 0 ? (
        <div className="approvals-empty">还没有任何归档对话。</div>
      ) : (
        <ul className="archived-list">
          {rows.map((row) => (
            <li key={`${row.repoId ?? NO_REPO_KEY}:${row.session.id}`} className="archived-row">
              <div className="archived-row-main">
                <span className="archived-row-title">{row.session.title}</span>
                <span className="archived-row-meta">
                  <span className="archived-row-repo">{row.repoName}</span>
                  <span className="archived-row-dot">·</span>
                  <span className="archived-row-time">{formatTime(row.session.updatedAt)}</span>
                </span>
              </div>
              <div className="archived-row-actions">
                <button
                  className="archived-action"
                  onClick={() => restore(row)}
                  title="恢复到侧栏"
                  aria-label="恢复到侧栏"
                >
                  <ArchiveRestore size={13} />
                  <span>恢复</span>
                </button>
                <button
                  className="archived-action archived-action-danger"
                  onClick={() => remove(row)}
                  title="永久删除"
                  aria-label="永久删除"
                >
                  <Trash2 size={13} />
                  <span>删除</span>
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
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
