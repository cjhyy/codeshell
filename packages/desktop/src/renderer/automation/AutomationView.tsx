import React, { useEffect, useState } from "react";
import type { AutomationSummary, AutomationPermissionLevel } from "../../preload/types";
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
import { Loader2 } from "lucide-react";
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

export function AutomationView({
  onCreateConversational,
  onViewRun,
}: {
  onCreateConversational: () => void;
  onViewRun: (runId: string) => void;
}) {
  const [jobs, setJobs] = useState<AutomationSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Per-action in-flight flags, keyed by "<action>:<jobId>". */
  const [pending, setPending] = useState<Record<string, boolean>>({});

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
    <div className="flex h-full flex-col gap-3 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">自动化</h2>
        <Button size="sm" onClick={onCreateConversational}>+ 新建自动化</Button>
      </div>

      {jobs.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground">
          还没有自动化任务。点击「新建自动化」,用对话告诉它你想定时做什么、何时运行 —— 不用填 cron 语法。
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-6">
          <ul className="w-72 shrink-0 space-y-1 overflow-y-auto">
            {jobs.map((j) => (
              <li
                key={j.id}
                onClick={() => setSelected(j.id)}
                className={
                  "flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-accent " +
                  (selected === j.id ? "bg-accent ring-1 ring-border" : "")
                }
              >
                <span
                  className={
                    "h-2 w-2 shrink-0 rounded-full " +
                    (j.enabled ? "bg-status-ok" : "bg-status-idle")
                  }
                />
                <span className="flex-1 truncate font-medium">{j.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{describeSchedule(j.schedule)}</span>
              </li>
            ))}
          </ul>

          <div className="min-w-0 flex-1 overflow-y-auto">
            {detail ? (
              <AutomationDetail
                job={detail}
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
              />
            ) : (
              <div className="p-6 text-sm text-muted-foreground">选择一个任务查看详情</div>
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
  runNowBusy: boolean;
  deleteBusy: boolean;
  toggleBusy: boolean;
  saveBusy: boolean;
  onViewRun: (runId: string) => void;
}) {
  const { job } = props;

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
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold tracking-tight">{job.name}</h3>
        <div className="flex items-center gap-2">
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
              "立即运行"
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-status-err"
            onClick={props.onDelete}
            disabled={props.deleteBusy}
          >
            删除
          </Button>
        </div>
      </div>

      {/* Prompt — edit button reveals an inline textarea (long text). */}
      {editingPrompt ? (
        <div className="flex flex-col gap-2">
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
        <div className="flex items-start gap-2">
          <pre className="flex-1 whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed">
            {job.prompt}
          </pre>
          <Button size="sm" variant="outline" onClick={() => setEditingPrompt(true)}>编辑</Button>
        </div>
      )}

      <div className="flex flex-col">
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
              查看
            </Button>
          ) : (
            "—"
          )}
        </FieldRow>
      </div>
    </div>
  );
}
