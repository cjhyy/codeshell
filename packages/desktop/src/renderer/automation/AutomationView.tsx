import React, { useEffect, useState } from "react";
import type { AutomationSummary, AutomationPermissionLevel, RunSummary } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Clock3, History, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";
import {
  parseSchedule,
  buildSchedule,
  describeSchedule,
  WEEKDAY_LABELS,
  type Schedule,
} from "./scheduleModel";

const PERMISSION_OPTIONS = [
  { value: "read-only", label: "只读" },
  { value: "workspace-write", label: "可写工作区" },
  { value: "full", label: "完全(可提 PR)" },
];

// Cadence types for the "pick a cadence → pick a time" frequency control. The
// raw cron string is derived from this + a time/weekday via scheduleModel.
const CADENCE_OPTIONS: { value: Schedule["kind"]; label: string }[] = [
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日" },
  { value: "weekly", label: "每周" },
  { value: "hourly", label: "按小时" },
  { value: "custom", label: "自定义 cron…" },
];

const HOURLY_OPTIONS = [1, 2, 3, 4, 6, 8, 12];

const DEFAULT_TIME = "09:00";

// Timezone choices. Default is UTC; the system-local zone is appended with a
// "()" note so the user can recognise their own offset without IANA fluency.
// Only the system zone carries that note — the rest are plain IANA ids.
function systemTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** "(UTC+8)" style offset note for a zone, or "" if it can't be computed. */
function offsetNote(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date(0));
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    return name.replace("GMT", "UTC");
  } catch {
    return "";
  }
}

const BASE_TIMEZONES = [
  "UTC",
  "Asia/Shanghai",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Tokyo",
];

function timezoneOptions(current: string): { value: string; label: string }[] {
  const sys = systemTimezone();
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  const add = (tz: string, note?: string) => {
    if (seen.has(tz)) return;
    seen.add(tz);
    out.push({ value: tz, label: note ? `${tz} (${note})` : tz });
  };
  // System zone first, with its offset note — the only entry that gets one.
  if (sys) add(sys, offsetNote(sys) || undefined);
  for (const tz of BASE_TIMEZONES) add(tz);
  add(current); // keep a previously-saved zone selectable even if exotic
  return out;
}

function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString();
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function runStatusLabel(status?: string): string {
  switch (status) {
    case "completed":
      return "完成";
    case "running":
      return "运行中";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "queued":
      return "排队中";
    default:
      return status || "session";
  }
}

type AutomationSessionLink = {
  repoId: string | null;
  session: SessionSummary;
  run?: RunSummary;
};

function automationSessionLinks(
  job: AutomationSummary,
  sessionIndices: Record<string, SessionIndex>,
  runs: RunSummary[],
): AutomationSessionLink[] {
  const runsById = new Map(runs.map((r) => [r.runId, r]));
  const runsBySessionId = new Map(
    runs
      .filter((r) => r.sessionId)
      .map((r) => [r.sessionId as string, r]),
  );
  const matchingRunIds = new Set(
    runs
      .filter(
        (r) =>
          r.source === "automation" &&
          (r.cronJobName === job.name || r.runId === job.lastRunId),
      )
      .map((r) => r.runId),
  );

  const out: AutomationSessionLink[] = [];
  for (const [repoKey, idx] of Object.entries(sessionIndices)) {
    const repoId = repoKey === NO_REPO_KEY ? null : repoKey;
    for (const session of idx.sessions) {
      if (session.source !== "automation" || session.archived) continue;
      const run = session.runId ? runsById.get(session.runId) : runsBySessionId.get(session.engineSessionId ?? session.id);
      const matches =
        session.title === job.name ||
        (session.runId ? matchingRunIds.has(session.runId) : false) ||
        run?.cronJobName === job.name ||
        run?.runId === job.lastRunId;
      if (matches) out.push({ repoId, session, run });
    }
  }

  return out.sort((a, b) => {
    const at = a.run?.updatedAt ?? a.session.updatedAt;
    const bt = b.run?.updatedAt ?? b.session.updatedAt;
    return bt - at;
  });
}

export function AutomationView({
  onCreateConversational,
  onViewRun,
  onOpenSession,
  sessionIndices,
}: {
  onCreateConversational: () => void;
  onViewRun: (runId: string) => void;
  onOpenSession: (repoId: string | null, sessionId: string) => void;
  sessionIndices: Record<string, SessionIndex>;
}) {
  const [jobs, setJobs] = useState<AutomationSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Per-action in-flight flags, keyed by "<action>:<jobId>". */
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const refresh = async () => {
    try {
      const [list, runList] = await Promise.all([
        window.codeshell.listAutomations(),
        window.codeshell.listRuns(),
      ]);
      setJobs(list);
      setRuns(runList);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const detail = jobs?.find((j) => j.id === selected) ?? null;

  useEffect(() => {
    if (!jobs || jobs.length === 0) return;
    if (!selected || !jobs.some((j) => j.id === selected)) setSelected(jobs[0].id);
  }, [jobs, selected]);

  // Per-action in-flight guard. Keyed by "<action>:<jobId>" so the same
  // button can't be re-fired while its request is pending (the bug that let
  // a quick double-click on 立即运行 submit multiple runs), while distinct
  // actions/jobs stay independent. The finally always clears the key so a
  // failed request can't leave a button stuck disabled.
  const act = async (key: string, fn: () => Promise<unknown>) => {
    if (pending[key]) return;
    setPending((p) => ({ ...p, [key]: true }));
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setPending((p) => ({ ...p, [key]: false }));
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-start gap-3 p-6 text-sm text-status-err">
        {error}
        <Button variant="outline" size="sm" onClick={() => { setError(null); void refresh(); }}>
          重试
        </Button>
      </div>
    );
  }
  if (!jobs) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;

  return (
    <div className="automation-view">
      <div className="automation-head">
        <div>
          <h2 className="automation-title">自动化</h2>
          <p className="automation-subtitle">{jobs.length} 个任务</p>
        </div>
        <Button size="sm" onClick={onCreateConversational}>
          <Plus size={14} />
          新建自动化
        </Button>
      </div>

      {jobs.length === 0 ? (
        <div className="automation-empty">
          还没有自动化任务。点击「新建自动化」,用对话告诉它你想定时做什么、何时运行 —— 不用填 cron 语法。
        </div>
      ) : (
        <div className="automation-layout">
          <ul className="automation-list">
            {jobs.map((j) => (
              <li
                key={j.id}
                onClick={() => setSelected(j.id)}
                className={
                  "automation-job-row " +
                  (selected === j.id ? "active" : "")
                }
              >
                <span
                  className={
                    "automation-status-dot " +
                    (j.enabled ? "enabled" : "paused")
                  }
                />
                <span className="automation-job-main">
                  <span className="automation-job-name">{j.name}</span>
                  <span className="automation-job-meta">
                    {j.enabled ? "活跃" : "暂停"} · {j.runCount} 次
                  </span>
                </span>
                <span className="automation-job-schedule">{describeSchedule(j.schedule)}</span>
              </li>
            ))}
          </ul>

          <div className="automation-detail-scroll">
            {detail ? (
              <AutomationDetail
                job={detail}
                sessions={automationSessionLinks(detail, sessionIndices, runs)}
                onToggleEnabled={(next) =>
                  act("toggle:" + detail.id, () =>
                    next
                      ? window.codeshell.resumeAutomation(detail.id)
                      : window.codeshell.pauseAutomation(detail.id),
                  )
                }
                onDelete={() => act("delete:" + detail.id, () => window.codeshell.deleteAutomation(detail.id))}
                onRunNow={() => act("runNow:" + detail.id, () => window.codeshell.runAutomationNow(detail.id))}
                onSave={(patch) => act("save:" + detail.id, () => window.codeshell.updateAutomation(detail.id, patch))}
                runNowBusy={!!pending["runNow:" + detail.id]}
                deleteBusy={!!pending["delete:" + detail.id]}
                toggleBusy={!!pending["toggle:" + detail.id]}
                saveBusy={!!pending["save:" + detail.id]}
                onViewRun={onViewRun}
                onOpenSession={onOpenSession}
              />
            ) : (
              <div className="automation-empty">选择一个任务查看详情</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 font-medium">{children}</div>
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
  sessions: AutomationSessionLink[];
  runNowBusy: boolean;
  deleteBusy: boolean;
  toggleBusy: boolean;
  saveBusy: boolean;
  onViewRun: (runId: string) => void;
  onOpenSession: (repoId: string | null, sessionId: string) => void;
}) {
  const { job } = props;
  const sessionCount = props.sessions.length;
  const lastSession = props.sessions[0];

  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(job.prompt);

  // Frequency UI model derived from the stored cron string. Edits rebuild the
  // cron and save it; the raw input only shows for the "custom" cadence.
  const [sched, setSched] = useState<Schedule>(() => parseSchedule(job.schedule));
  const [customDraft, setCustomDraft] = useState(job.schedule);

  useEffect(() => {
    setEditingPrompt(false);
    setPromptDraft(job.prompt);
    setSched(parseSchedule(job.schedule));
    setCustomDraft(job.schedule);
  }, [job.id, job.prompt, job.schedule]);

  // Apply a new schedule model: rebuild the cron string and save if changed.
  const commitSchedule = (next: Schedule) => {
    setSched(next);
    if (next.kind === "custom") return; // custom saves on blur/Enter, not on keystroke
    const cron = buildSchedule(next);
    if (cron !== job.schedule) props.onSave({ schedule: cron });
  };

  // Switching cadence: seed sensible defaults for the new kind.
  const onCadenceChange = (kind: Schedule["kind"]) => {
    const time = "time" in sched ? sched.time : DEFAULT_TIME;
    switch (kind) {
      case "daily":
        return commitSchedule({ kind, time });
      case "weekdays":
        return commitSchedule({ kind, time });
      case "weekly":
        return commitSchedule({
          kind,
          weekday: sched.kind === "weekly" ? sched.weekday : 1,
          time,
        });
      case "hourly":
        return commitSchedule({
          kind,
          everyHours: sched.kind === "hourly" ? sched.everyHours : 6,
        });
      case "custom":
        // Switch to the raw editor without saving yet; prime it with the
        // current cron so the user edits from where they are.
        setSched({ kind: "custom", raw: job.schedule });
        setCustomDraft(job.schedule);
        return;
    }
  };

  const applyCustomSchedule = () => {
    const v = customDraft.trim();
    if (v && v !== job.schedule) props.onSave({ schedule: v });
  };

  const tzOptions = timezoneOptions(job.timezone ?? "UTC");

  return (
    <div className="automation-detail">
      <div className="automation-detail-hero">
        <div className="automation-detail-title">
          <span
            className={
              "automation-status-dot " +
              (job.enabled ? "enabled" : "paused")
            }
          />
          <div>
            <h3>{job.name}</h3>
            <p>{describeSchedule(job.schedule)} · {job.timezone ?? "UTC"}</p>
          </div>
        </div>
        <div className="automation-actions">
          <Switch
            checked={job.enabled}
            onCheckedChange={(v) => props.onToggleEnabled(v)}
            disabled={props.toggleBusy}
            aria-label={job.enabled ? "已启用" : "已暂停"}
          />
          <Button size="sm" onClick={props.onRunNow} disabled={props.runNowBusy}>
            {props.runNowBusy ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                运行中…
              </>
            ) : (
              <>
                <Play size={14} />
                立即运行
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-status-err"
            onClick={props.onDelete}
            disabled={props.deleteBusy}
            aria-label="删除自动化"
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      <div className="automation-metrics">
        <div>
          <span>下次运行</span>
          <strong>{fmtTime(job.nextRun)}</strong>
        </div>
        <div>
          <span>上次运行</span>
          <strong>{fmtTime(job.lastRun)}</strong>
        </div>
        <div>
          <span>历史 session</span>
          <strong>{sessionCount}</strong>
        </div>
      </div>

      {/* Prompt — edit button reveals an inline textarea (long text). */}
      {editingPrompt ? (
        <div className="automation-panel">
          <Textarea value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)} rows={5} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => { setEditingPrompt(false); setPromptDraft(job.prompt); }}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={props.saveBusy || !promptDraft.trim()}
              onClick={() => {
                if (promptDraft.trim() !== job.prompt) props.onSave({ prompt: promptDraft.trim() });
                setEditingPrompt(false);
              }}
            >
              {props.saveBusy ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  保存中…
                </>
              ) : (
                "保存"
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="automation-prompt-panel">
          <pre>
            {job.prompt}
          </pre>
          <Button size="sm" variant="outline" onClick={() => setEditingPrompt(true)}>编辑</Button>
        </div>
      )}

      <div className="automation-panel">
        <FieldRow label="状态">
          <Badge
            variant="outline"
            className={
              job.enabled
                ? "border-status-ok/30 bg-status-ok/15 text-status-ok"
                : undefined
            }
          >
            {job.enabled ? "活跃" : "已暂停"}
          </Badge>
        </FieldRow>

        <FieldRow label="频率">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Step 1: cadence type. */}
            <Select value={sched.kind} onValueChange={(v) => onCadenceChange(v as Schedule["kind"])}>
              <SelectTrigger className="h-8 w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CADENCE_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Step 2: per-cadence detail. */}
            {sched.kind === "weekly" && (
              <Select
                value={String(sched.weekday)}
                onValueChange={(v) =>
                  commitSchedule({ ...sched, weekday: Number(v) })
                }
              >
                <SelectTrigger className="h-8 w-[96px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WEEKDAY_LABELS.map((label, i) => (
                    <SelectItem key={i} value={String(i)}>{`周${label.slice(1)}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {(sched.kind === "daily" || sched.kind === "weekdays" || sched.kind === "weekly") && (
              <Input
                type="time"
                className="h-8 w-[120px]"
                value={sched.time}
                onChange={(e) => {
                  if (e.target.value) commitSchedule({ ...sched, time: e.target.value });
                }}
              />
            )}

            {sched.kind === "hourly" && (
              <Select
                value={String(sched.everyHours)}
                onValueChange={(v) => commitSchedule({ kind: "hourly", everyHours: Number(v) })}
              >
                <SelectTrigger className="h-8 w-[120px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {HOURLY_OPTIONS.map((h) => (
                    <SelectItem key={h} value={String(h)}>{`每 ${h} 小时`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {sched.kind === "custom" && (
              <Input
                className="h-8 w-[180px] font-mono"
                value={customDraft}
                placeholder="0 9 * * 1-5 或 1h"
                onChange={(e) => setCustomDraft(e.target.value)}
                onBlur={applyCustomSchedule}
                onKeyDown={(e) => { if (e.key === "Enter") applyCustomSchedule(); }}
              />
            )}
          </div>
        </FieldRow>

        <FieldRow label="时区">
          <Select
            value={job.timezone ?? "UTC"}
            onValueChange={(v) => { if (v !== job.timezone) props.onSave({ timezone: v }); }}
          >
            <SelectTrigger className="h-8 w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {tzOptions.map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>

        <FieldRow label="权限">
          <Select
            value={job.permissionLevel ?? "read-only"}
            onValueChange={(v) => {
              if (v !== (job.permissionLevel ?? "read-only")) {
                props.onSave({ permissionLevel: v as AutomationPermissionLevel });
              }
            }}
          >
            <SelectTrigger className="h-8 w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERMISSION_OPTIONS.map((p) => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>

        <FieldRow label="下次运行">{fmtTime(job.nextRun)}</FieldRow>
        <FieldRow label="上次运行">{fmtTime(job.lastRun)}</FieldRow>
        <FieldRow label="运行次数">{job.runCount}</FieldRow>
        <FieldRow label="项目">{job.cwd ?? "—"}</FieldRow>
        <FieldRow label="最近运行">
          {job.lastRunId ? (
            <Button size="sm" variant="outline" onClick={() => props.onViewRun(job.lastRunId!)}>
              <History size={14} />
              查看
            </Button>
          ) : (
            "—"
          )}
        </FieldRow>
      </div>

      <div className="automation-run-history">
        <div className="automation-section-head">
          <div>
            <h4>运行 session</h4>
            <p>{lastSession ? `最近 ${shortDate(lastSession.run?.updatedAt ?? lastSession.session.updatedAt)}` : "暂无历史 session"}</p>
          </div>
          {job.lastRunId && (
            <Button size="sm" variant="outline" onClick={() => props.onViewRun(job.lastRunId!)}>
              <History size={14} />
              运行详情
            </Button>
          )}
        </div>
        {props.sessions.length === 0 ? (
          <div className="automation-history-empty">这个任务还没有可跳转的历史 session。</div>
        ) : (
          <ul>
            {props.sessions.map(({ repoId, session, run }) => {
              const status = run?.status ?? session.runStatus;
              const when = run?.updatedAt ?? session.updatedAt;
              return (
                <li key={`${repoId ?? NO_REPO_KEY}:${session.id}`}>
                  <button
                    className="automation-history-row"
                    onClick={() => props.onOpenSession(repoId, session.id)}
                  >
                    <Clock3 size={14} />
                    <span className="automation-history-main">
                      <span>{session.title}</span>
                      <small>{shortDate(when)} · {runStatusLabel(status)}</small>
                    </span>
                    <span className="automation-history-action">查看</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
