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

const PERMISSION_OPTIONS = [
  { value: "read-only", label: "只读" },
  { value: "workspace-write", label: "可写工作区" },
  { value: "full", label: "完全(可提 PR)" },
];

// Common schedule presets (cron expressions / intervals). "__custom__" reveals
// an inline input for anything not in the list.
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
  "Asia/Shanghai",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Tokyo",
];

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
                <span className="font-mono text-xs text-muted-foreground">{j.schedule}</span>
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
          <Badge variant={job.enabled ? "secondary" : "outline"}>
            {job.enabled ? "活跃" : "已暂停"}
          </Badge>
        </FieldRow>

        <FieldRow label="频率">
          <div className="flex items-center gap-2">
            <Select
              value={showCustomSchedule ? "__custom__" : job.schedule}
              onValueChange={(v) => {
                if (v === "__custom__") {
                  setShowCustomSchedule(true);
                } else {
                  setShowCustomSchedule(false);
                  if (v !== job.schedule) props.onSave({ schedule: v });
                }
              }}
            >
              <SelectTrigger className="h-8 w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showCustomSchedule && (
              <Input
                className="h-8 w-[160px] font-mono"
                value={customSchedule}
                placeholder="0 9 * * 1-5 或 1h"
                onChange={(e) => setCustomSchedule(e.target.value)}
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
            <SelectTrigger className="h-8 w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TIMEZONE_OPTIONS.map((tz) => (
                <SelectItem key={tz} value={tz}>{tz}</SelectItem>
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
