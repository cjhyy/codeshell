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

export function AutomationView() {
  const [jobs, setJobs] = useState<AutomationSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
        <button className="automation-new-btn" onClick={() => setCreating(true)}>
          + 新建自动化
        </button>
      </div>

      {jobs.length === 0 && !creating ? (
        <div className="automation-empty">
          还没有自动化任务。点击「新建自动化」创建一个定时任务。
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
                onPause={() => act(() => window.codeshell.pauseAutomation(detail.id))}
                onResume={() => act(() => window.codeshell.resumeAutomation(detail.id))}
                onDelete={() => act(() => window.codeshell.deleteAutomation(detail.id))}
                onRunNow={() => act(() => window.codeshell.runAutomationNow(detail.id))}
              />
            ) : (
              <div className="automation-detail-empty">选择一个任务查看详情</div>
            )}
          </div>
        </div>
      )}

      {creating && (
        <CreateAutomationForm
          onCancel={() => setCreating(false)}
          onCreate={async (input) => {
            await act(() => window.codeshell.createAutomation(input));
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function AutomationDetail(props: {
  job: AutomationSummary;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onRunNow: () => void;
}) {
  const { job } = props;
  return (
    <div className="automation-detail-card">
      <div className="automation-detail-header">
        <h3>{job.name}</h3>
        <div className="automation-detail-actions">
          <button onClick={props.onRunNow}>立即运行</button>
          {job.enabled ? (
            <button onClick={props.onPause}>暂停</button>
          ) : (
            <button onClick={props.onResume}>启用</button>
          )}
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

function CreateAutomationForm(props: {
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    schedule: string;
    prompt: string;
    cwd?: string;
    timezone?: string;
    permissionLevel?: AutomationPermissionLevel;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * 1-5");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [timezone, setTimezone] = useState("Asia/Shanghai");

  const canSubmit = name.trim() && schedule.trim() && prompt.trim();

  return (
    <div className="automation-modal-backdrop" onClick={props.onCancel}>
      <div className="automation-modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建自动化</h3>
        <label>名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder="工作日晨间简报" /></label>
        <label>频率(cron 表达式或间隔)<input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 9 * * 1-5 或 1h" /></label>
        <label>时区<input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Shanghai" /></label>
        <label>项目目录(可选)<input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/proj" /></label>
        <label>任务提示<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="检查今天的 git 变更并总结…" /></label>
        <div className="automation-modal-actions">
          <button onClick={props.onCancel}>取消</button>
          <button
            disabled={!canSubmit}
            onClick={() =>
              props.onCreate({
                name: name.trim(),
                schedule: schedule.trim(),
                prompt: prompt.trim(),
                ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
                ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
              })
            }
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
