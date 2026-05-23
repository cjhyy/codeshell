import React, { useEffect, useState } from "react";
import type { RunSummary, RunDetail } from "../../preload/types";

const STATUS_TONES: Record<string, "ok" | "warn" | "err" | "running" | "idle"> = {
  queued: "idle",
  running: "running",
  waiting_input: "warn",
  waiting_approval: "warn",
  blocked: "warn",
  completed: "ok",
  failed: "err",
  cancelled: "warn",
};

export function RunsView() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const refresh = async () => {
    try {
      const list = await window.codeshell.listRuns();
      setRuns(list);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void window.codeshell.getRun(selected).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => { cancelled = true; };
  }, [selected]);

  if (error) return <div className="view-error">{error}</div>;
  if (!runs) return <div className="view-loading">加载中…</div>;

  const filtered =
    filter === "all" ? runs : runs.filter((r) => r.status === filter);

  return (
    <div className="runs-view">
      <div className="runs-toolbar">
        <select
          className="sessions-filter"
          style={{ maxWidth: 180 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部</option>
          {Object.keys(STATUS_TONES).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button className="approval-btn deny" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div className="runs-split">
        <ul className="runs-list">
          {filtered.length === 0 ? (
            <li className="approvals-empty">没有匹配的 run</li>
          ) : (
            filtered.map((r) => {
              const tone = STATUS_TONES[r.status] ?? "idle";
              return (
                <li
                  key={r.runId}
                  className={`run-row${selected === r.runId ? " selected" : ""}`}
                  onClick={() => setSelected(r.runId)}
                >
                  <span className={`status-dot status-${tone}`} title={r.status} />
                  <span className="run-objective">{r.objective || "(no objective)"}</span>
                  <span className="run-status">{r.status}</span>
                  <span className="run-when">{new Date(r.updatedAt).toLocaleString()}</span>
                </li>
              );
            })
          )}
        </ul>
        <div className="run-detail">
          {detail ? <RunDetailView detail={detail} /> : (
            <div className="approvals-empty">选一个 run 查看详情</div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetailView({ detail }: { detail: RunDetail }) {
  return (
    <div className="run-detail-inner">
      <div className="run-detail-head">
        <strong>{detail.objective}</strong>
        <span className="run-status">{detail.status}</span>
      </div>
      <div className="run-detail-meta">
        <span><span className="settings-section-label">runId</span> <code>{detail.runId}</code></span>
        <span><span className="settings-section-label">cwd</span> <code>{detail.cwd}</code></span>
        {detail.preset && <span><span className="settings-section-label">preset</span> <code>{detail.preset}</code></span>}
        {detail.sessionId && <span><span className="settings-section-label">session</span> <code>{detail.sessionId.slice(0, 12)}</code></span>}
        <span><span className="settings-section-label">attempts</span> {detail.attemptCount}</span>
      </div>
      {detail.error && <div className="view-error">{detail.error}</div>}
      {detail.summary && (
        <div className="settings-section">
          <h3 className="settings-section-title">摘要</h3>
          <div>{detail.summary}</div>
        </div>
      )}
      <div className="settings-section">
        <h3 className="settings-section-title">检查点 ({detail.checkpoints.length})</h3>
        {detail.checkpoints.length === 0 ? (
          <div className="approvals-empty">暂无</div>
        ) : (
          <ul className="run-checkpoints">
            {detail.checkpoints.map((c) => (
              <li key={c.checkpointId} className="run-checkpoint">
                <div className="run-checkpoint-head">
                  <strong>{c.phase}</strong>
                  <span className="session-meta">{new Date(c.createdAt).toLocaleString()}</span>
                </div>
                <div>{c.summary}</div>
                {c.nextAction && (
                  <div className="settings-section-help">下一步：{c.nextAction}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="settings-section">
        <h3 className="settings-section-title">产物 ({detail.artifacts.length})</h3>
        {detail.artifacts.length === 0 ? (
          <div className="approvals-empty">暂无</div>
        ) : (
          <ul className="run-artifacts">
            {detail.artifacts.map((a) => (
              <li key={a}><code>{a}</code></li>
            ))}
          </ul>
        )}
      </div>
      <div className="settings-section">
        <h3 className="settings-section-title">事件 (最近 {detail.events.length})</h3>
        {detail.events.length === 0 ? (
          <div className="approvals-empty">暂无</div>
        ) : (
          <ul className="run-events">
            {detail.events.slice().reverse().map((e) => (
              <li key={e.eventId} className="run-event">
                <span className="run-event-type">{e.type}</span>
                <span className="run-event-when">{new Date(e.timestamp).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
