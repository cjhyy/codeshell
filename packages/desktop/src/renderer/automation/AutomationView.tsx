import React, { useEffect, useState } from "react";
import type { AutomationSummary, AutomationPermissionLevel } from "../../preload/types";
import { Select } from "../ui/Select";

const PERMISSION_OPTIONS = [
  { value: "read-only", label: "只读" },
  { value: "workspace-write", label: "可写工作区" },
  { value: "full", label: "完全(可提 PR)" },
];

// Common schedule presets (cron expressions / intervals). "custom" reveals an
// inline input for anything not in the list.
const SCHEDULE_PRESETS = [
  { value: "0 9 * * 1-5", label: "工作日 9:00" },
  { value: "0 8 * * 1-5", label: "工作日 8:00" },
  { value: "0 9 * * *", label: "每天 9:00" },
  { value: "0 */6 * * *", label: "每 6 小时" },
  { value: "0 * * * *", label: "每小时" },
  { value: "1h", label: "每 1 小时(间隔)" },
  { value: "1d", label: "每天(间隔)" },
  { value: "__custom__", label: "自定义…" },
];

const TIMEZONE_OPTIONS = [
  { value: "Asia/Shanghai", label: "Asia/Shanghai" },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "America/New_York" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles" },
  { value: "Europe/London", label: "Europe/London" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo" },
];

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
    permissionLevel?: AutomationPermissionLevel;
  }) => void;
}) {
  const { job } = props;

  // Prompt is long free text → edited via a button/textarea, not a dropdown.
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(job.prompt);

  // Frequency "custom" mode reveals a free-form cron/interval input.
  const scheduleIsPreset = SCHEDULE_PRESETS.some(
    (p) => p.value === job.schedule && p.value !== "__custom__",
  );
  const [customSchedule, setCustomSchedule] = useState(scheduleIsPreset ? "" : job.schedule);
  const [showCustomSchedule, setShowCustomSchedule] = useState(!scheduleIsPreset);

  useEffect(() => {
    setEditingPrompt(false);
    setPromptDraft(job.prompt);
    const preset = SCHEDULE_PRESETS.some((p) => p.value === job.schedule && p.value !== "__custom__");
    setShowCustomSchedule(!preset);
    setCustomSchedule(preset ? "" : job.schedule);
  }, [job.id, job.prompt, job.schedule]);

  const applyCustomSchedule = () => {
    const v = customSchedule.trim();
    if (v && v !== job.schedule) props.onSave({ schedule: v });
  };

  return (
    <div className="automation-detail-card">
      <div className="automation-detail-header">
        <h3>{job.name}</h3>
        <div className="automation-detail-actions">
          {/* enable/disable as a switch toggle */}
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
          <button className="danger" onClick={props.onDelete}>删除</button>
        </div>
      </div>

      {/* Prompt — edit button reveals an inline textarea (long text). */}
      {editingPrompt ? (
        <div className="automation-prompt-edit">
          <textarea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            rows={5}
          />
          <div className="automation-detail-actions">
            <button onClick={() => { setEditingPrompt(false); setPromptDraft(job.prompt); }}>取消</button>
            <button
              disabled={!promptDraft.trim()}
              onClick={() => {
                if (promptDraft.trim() !== job.prompt) props.onSave({ prompt: promptDraft.trim() });
                setEditingPrompt(false);
              }}
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="automation-prompt-row">
          <pre className="automation-prompt">{job.prompt}</pre>
          <button className="automation-prompt-edit-btn" onClick={() => setEditingPrompt(true)}>编辑</button>
        </div>
      )}

      {/* Everything else: inline dropdowns that apply immediately. */}
      <dl className="automation-fields">
        <dt>状态</dt><dd>{job.enabled ? "🟢 活跃" : "⏸ 已暂停"}</dd>

        <dt>频率</dt>
        <dd>
          <Select
            size="sm"
            ariaLabel="频率"
            value={showCustomSchedule ? "__custom__" : job.schedule}
            options={SCHEDULE_PRESETS}
            onChange={(v) => {
              if (v === "__custom__") {
                setShowCustomSchedule(true);
              } else {
                setShowCustomSchedule(false);
                if (v !== job.schedule) props.onSave({ schedule: v });
              }
            }}
          />
          {showCustomSchedule && (
            <input
              className="automation-inline-input"
              value={customSchedule}
              placeholder="0 9 * * 1-5 或 1h"
              onChange={(e) => setCustomSchedule(e.target.value)}
              onBlur={applyCustomSchedule}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustomSchedule();
              }}
            />
          )}
        </dd>

        <dt>时区</dt>
        <dd>
          <Select
            size="sm"
            ariaLabel="时区"
            value={job.timezone ?? "UTC"}
            options={TIMEZONE_OPTIONS}
            onChange={(v) => {
              if (v !== job.timezone) props.onSave({ timezone: v });
            }}
          />
        </dd>

        <dt>权限</dt>
        <dd>
          <Select
            size="sm"
            ariaLabel="权限"
            value={job.permissionLevel ?? "read-only"}
            options={PERMISSION_OPTIONS}
            onChange={(v) => {
              if (v !== (job.permissionLevel ?? "read-only")) {
                props.onSave({ permissionLevel: v as AutomationPermissionLevel });
              }
            }}
          />
        </dd>

        <dt>下次运行</dt><dd>{fmtTime(job.nextRun)}</dd>
        <dt>上次运行</dt><dd>{fmtTime(job.lastRun)}</dd>
        <dt>运行次数</dt><dd>{job.runCount}</dd>
        <dt>项目</dt><dd>{job.cwd ?? "—"}</dd>
        <dt>最近运行</dt><dd>{job.lastRunId ?? "—"}</dd>
      </dl>
    </div>
  );
}
