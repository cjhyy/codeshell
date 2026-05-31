import React, { useEffect, useState } from "react";
import type { AutomationSummary, AutomationPermissionLevel } from "../../preload/types";

const PERMISSION_LABELS: Record<AutomationPermissionLevel, string> = {
  "read-only": "只读",
  "workspace-write": "可写工作区",
  full: "完全(可提 PR)",
};

function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString();
}

export function AutomationView({ onCreateConversational }: { onCreateConversational: () => void }) {
  const [jobs, setJobs] = useState<AutomationSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await window.codeshell.listAutomations();
      setJobs(list);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const detail = jobs?.find((j) => j.id === selected) ?? null;

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  if (error) {
    return (
      <div className="view-error">
        {error}
        <button onClick={() => { setError(null); void refresh(); }}>重试</button>
      </div>
    );
  }
  if (!jobs) return <div className="view-loading">加载中…</div>;

  return (
    <div className="automation-view">
      <div className="automation-toolbar">
        <h2 className="automation-title">自动化</h2>
        <button className="automation-new-btn" onClick={onCreateConversational}>
          + 新建自动化
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="automation-empty">
          还没有自动化任务。点击「新建自动化」,用对话告诉它你想定时做什么、何时运行 —— 不用填 cron 语法。
        </div>
      ) : (
        <div className="automation-body">
          <ul className="automation-list">
            {jobs.map((j) => (
              <li
                key={j.id}
                className={`automation-row${selected === j.id ? " selected" : ""}`}
                onClick={() => setSelected(j.id)}
              >
                <span className={`automation-dot ${j.enabled ? "active" : "paused"}`} />
                <span className="automation-row-name">{j.name}</span>
                <span className="automation-row-sched">{j.schedule}</span>
                <span className="automation-row-next">下次 {fmtTime(j.nextRun)}</span>
              </li>
            ))}
          </ul>

          <div className="automation-detail">
            {detail ? (
              <AutomationDetail
                job={detail}
                onToggleEnabled={(next) =>
                  act(() =>
                    next
                      ? window.codeshell.resumeAutomation(detail.id)
                      : window.codeshell.pauseAutomation(detail.id),
                  )
                }
                onDelete={() => act(() => window.codeshell.deleteAutomation(detail.id))}
                onRunNow={() => act(() => window.codeshell.runAutomationNow(detail.id))}
                onSave={(patch) => act(() => window.codeshell.updateAutomation(detail.id, patch))}
              />
            ) : (
              <div className="automation-detail-empty">选择一个任务查看详情</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AutomationDetail(props: {
  job: AutomationSummary;
  onToggleEnabled: (next: boolean) => void;
  onDelete: () => void;
  onRunNow: () => void;
  onSave: (patch: {
    name?: string;
    schedule?: string;
    prompt?: string;
    timezone?: string;
  }) => void;
}) {
  const { job } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(job.name);
  const [schedule, setSchedule] = useState(job.schedule);
  const [timezone, setTimezone] = useState(job.timezone ?? "");
  const [prompt, setPrompt] = useState(job.prompt);

  // Re-sync the edit fields whenever a different job is selected.
  useEffect(() => {
    setEditing(false);
    setName(job.name);
    setSchedule(job.schedule);
    setTimezone(job.timezone ?? "");
    setPrompt(job.prompt);
  }, [job.id, job.name, job.schedule, job.timezone, job.prompt]);

  if (editing) {
    return (
      <div className="automation-detail-card">
        <div className="automation-detail-header">
          <h3>编辑自动化</h3>
        </div>
        <label className="automation-edit-label">名称<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="automation-edit-label">
          频率(cron 表达式或间隔)
          <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 9 * * 1-5 或 1h" />
        </label>
        <label className="automation-edit-label">时区<input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Shanghai" /></label>
        <label className="automation-edit-label">任务提示<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} /></label>
        <div className="automation-detail-actions">
          <button onClick={() => setEditing(false)}>取消</button>
          <button
            disabled={!name.trim() || !schedule.trim() || !prompt.trim()}
            onClick={() => {
              props.onSave({
                name: name.trim(),
                schedule: schedule.trim(),
                prompt: prompt.trim(),
                timezone: timezone.trim() || undefined,
              });
              setEditing(false);
            }}
          >
            保存
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="automation-detail-card">
      <div className="automation-detail-header">
        <h3>{job.name}</h3>
        <div className="automation-detail-actions">
          {/* enable/disable as a switch toggle (not a button) */}
          <button
            type="button"
            role="switch"
            aria-checked={job.enabled}
            title={job.enabled ? "已启用 — 点击暂停" : "已暂停 — 点击启用"}
            className={`settings-git-switch${job.enabled ? " on" : ""}`}
            onClick={() => props.onToggleEnabled(!job.enabled)}
          >
            <span className="settings-git-switch-thumb" />
          </button>
          <button onClick={props.onRunNow}>立即运行</button>
          <button onClick={() => setEditing(true)}>编辑</button>
          <button className="danger" onClick={props.onDelete}>删除</button>
        </div>
      </div>
      <pre className="automation-prompt">{job.prompt}</pre>
      <dl className="automation-fields">
        <dt>状态</dt><dd>{job.enabled ? "🟢 活跃" : "⏸ 已暂停"}</dd>
        <dt>频率</dt><dd>{job.schedule}{job.timezone ? ` (${job.timezone})` : ""}</dd>
        <dt>下次运行</dt><dd>{fmtTime(job.nextRun)}</dd>
        <dt>上次运行</dt><dd>{fmtTime(job.lastRun)}</dd>
        <dt>运行次数</dt><dd>{job.runCount}</dd>
        <dt>项目</dt><dd>{job.cwd ?? "—"}</dd>
        <dt>权限</dt><dd>{job.permissionLevel ? PERMISSION_LABELS[job.permissionLevel] : "只读(默认)"}</dd>
        <dt>最近运行</dt><dd>{job.lastRunId ?? "—"}</dd>
      </dl>
    </div>
  );
}
