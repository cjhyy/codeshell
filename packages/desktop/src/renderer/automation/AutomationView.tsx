import React, { useEffect, useMemo, useState } from "react";
import type { AutomationSummary, AutomationPermissionLevel, RunSummary } from "../../preload/types";
import { Button } from "@/components/ui/button";
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
import { Clock3, History, Link2, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";
import {
  parseSchedule,
  buildSchedule,
  describeSchedule,
  weekdayLabels,
  type Schedule,
} from "./scheduleModel";
import type { DiskSessionMeta } from "./rebuildFromDisk";
import type { Repo } from "../repos";
import {
  buildProjectOptions,
  selectedProjectValue,
  cwdFromSelection,
} from "./projectOptions";
import { Combobox } from "@/components/ui/combobox";
import { allTimezones, offsetLabel, offsetBucket, uniqueOffsetBuckets, bucketLabel } from "./timezones";
import { cn } from "@/lib/utils";
import { fmtRelative } from "./relativeTime";
import { useT, type TFunction } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";

const PERMISSION_OPTIONS: { value: string; labelKey: TranslationKey }[] = [
  { value: "read-only", labelKey: "auto.permission.readOnly" },
  { value: "workspace-write", labelKey: "auto.permission.workspaceWrite" },
  { value: "full", labelKey: "auto.permission.full" },
];

// Cadence types for the "pick a cadence → pick a time" frequency control. The
// raw cron string is derived from this + a time/weekday via scheduleModel.
const CADENCE_OPTIONS: { value: Schedule["kind"]; labelKey: TranslationKey }[] = [
  { value: "daily", labelKey: "auto.cadence.daily" },
  { value: "weekdays", labelKey: "auto.cadence.weekdays" },
  { value: "weekly", labelKey: "auto.cadence.weekly" },
  { value: "hourly", labelKey: "auto.cadence.hourly" },
  { value: "custom", labelKey: "auto.cadence.custom" },
];

const HOURLY_OPTIONS = [1, 2, 3, 4, 6, 8, 12];

const DEFAULT_TIME = "09:00";

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

function runStatusLabel(t: TFunction, status?: string): string {
  switch (status) {
    case "completed":
      return t("auto.runStatus.completed");
    case "running":
      return t("auto.runStatus.running");
    case "failed":
      return t("auto.runStatus.failed");
    case "cancelled":
      return t("auto.runStatus.cancelled");
    case "queued":
      return t("auto.runStatus.queued");
    default:
      return status || "session";
  }
}

type AutomationSessionLink = {
  repoId: string | null;
  session: SessionSummary;
  run?: RunSummary;
  disk?: DiskSessionMeta;
  needsImport?: boolean;
};

function automationSessionLinks(
  job: AutomationSummary,
  sessionIndices: Record<string, SessionIndex>,
  runs: RunSummary[],
  diskSessions: DiskSessionMeta[],
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
  const seenRunIds = new Set<string>();
  const seenSessionIds = new Set<string>();
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
      if (matches) {
        // Locally-present session (found in a repo's session index) → already
        // imported, so never flag it for import. Set explicitly so the render
        // site can trust `link.needsImport` instead of re-deriving it.
        out.push({ repoId, session, run, needsImport: false });
        if (session.runId) seenRunIds.add(session.runId);
        if (session.engineSessionId) seenSessionIds.add(session.engineSessionId);
        seenSessionIds.add(session.id);
      }
    }
  }

  for (const run of runs) {
    if (
      run.source !== "automation" ||
      !run.sessionId ||
      seenRunIds.has(run.runId) ||
      seenSessionIds.has(run.sessionId) ||
      (run.cronJobName !== job.name && run.runId !== job.lastRunId)
    ) {
      continue;
    }
    out.push({
      repoId: null,
      run,
      needsImport: true,
      session: {
        id: run.sessionId,
        title: (run.cronJobName || run.objective || job.name || "automation").slice(0, 60),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        engineSessionId: run.sessionId,
        source: "automation",
        runId: run.runId,
        runStatus: run.status,
      },
    });
  }

  const promptNeedle = job.prompt.trim().slice(0, 36);
  for (const disk of diskSessions) {
    if (
      disk.origin !== "automation" ||
      seenSessionIds.has(disk.engineSessionId) ||
      (job.cwd && disk.cwd !== job.cwd)
    ) {
      continue;
    }
    const promptMatches = promptNeedle.length > 0 && disk.title.includes(promptNeedle);
    const timeMatches =
      job.lastRun != null &&
      Math.abs(disk.updatedAt - job.lastRun) < 24 * 60 * 60 * 1000;
    if (!promptMatches && !timeMatches) continue;
    out.push({
      repoId: null,
      disk,
      needsImport: true,
      session: {
        id: disk.id,
        title: (disk.title || job.name || "automation").slice(0, 60),
        createdAt: disk.updatedAt,
        updatedAt: disk.updatedAt,
        engineSessionId: disk.engineSessionId,
        source: "automation",
      },
    });
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
  onOpenRunSession,
  onOpenDiskSession,
  onOpenSession,
  sessionIndices,
  repos,
}: {
  onCreateConversational: () => void;
  onViewRun: (runId: string) => void;
  onOpenRunSession: (run: RunSummary) => void;
  onOpenDiskSession: (session: DiskSessionMeta) => void;
  onOpenSession: (repoId: string | null, sessionId: string) => void;
  sessionIndices: Record<string, SessionIndex>;
  repos: Repo[];
}) {
  const { t } = useT();
  const [jobs, setJobs] = useState<AutomationSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [diskSessions, setDiskSessions] = useState<DiskSessionMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Per-action in-flight flags, keyed by "<action>:<jobId>". */
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const refresh = async () => {
    try {
      const [list, runList, diskPage] = await Promise.all([
        window.codeshell.listAutomations(),
        window.codeshell.listRuns(),
        window.codeshell.listDiskSessions({ limit: 100 }),
      ]);
      setJobs(list);
      setRuns(runList);
      setDiskSessions(diskPage.sessions);
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
          {t("auto.view.retry")}
        </Button>
      </div>
    );
  }
  if (!jobs) return <div className="p-6 text-sm text-muted-foreground">{t("auto.view.loading")}</div>;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("auto.view.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("auto.view.jobCount", { count: jobs.length })}</p>
        </div>
        <Button size="sm" onClick={onCreateConversational}>
          <Plus size={14} />
          {t("auto.view.create")}
        </Button>
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          {t("auto.view.empty")}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,280px)_1fr] gap-4">
          <ul className="min-h-0 overflow-y-auto rounded-md border bg-card p-1">
            {jobs.map((j) => (
              <li
                key={j.id}
                onClick={() => setSelected(j.id)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent",
                  selected === j.id && "bg-accent text-accent-foreground",
                )}
              >
                <span
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    j.enabled ? "bg-status-ok" : "bg-muted-foreground",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{j.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {j.enabled ? t("auto.view.active") : t("auto.view.paused")} · {t("auto.view.runCount", { count: j.runCount })}
                  </span>
                </span>
                <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {j.once
                    ? j.nextRun
                      ? t("auto.schedule.onceAt", { time: new Date(j.nextRun).toLocaleString() })
                      : t("auto.schedule.once")
                    : describeSchedule(j.schedule)}
                </span>
              </li>
            ))}
          </ul>

          <div className="min-h-0 overflow-y-auto">
            {detail ? (
              <AutomationDetail
                t={t}
                job={detail}
                repos={repos}
                sessions={automationSessionLinks(detail, sessionIndices, runs, diskSessions)}
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
                onOpenRunSession={onOpenRunSession}
                onOpenDiskSession={onOpenDiskSession}
                onOpenSession={onOpenSession}
              />
            ) : (
              <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">{t("auto.view.selectJob")}</div>
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

export function AutomationDetail(props: {
  t?: TFunction;
  job: AutomationSummary;
  repos: Repo[];
  onToggleEnabled: (next: boolean) => void;
  onDelete: () => void;
  onRunNow: () => void;
  onSave: (patch: {
    name?: string;
    schedule?: string;
    prompt?: string;
    timezone?: string;
    cwd?: string;
    permissionLevel?: AutomationPermissionLevel;
  }) => void;
  sessions: AutomationSessionLink[];
  runNowBusy: boolean;
  deleteBusy: boolean;
  toggleBusy: boolean;
  saveBusy: boolean;
  onViewRun: (runId: string) => void;
  onOpenRunSession: (run: RunSummary) => void;
  onOpenDiskSession: (session: DiskSessionMeta) => void;
  onOpenSession: (repoId: string | null, sessionId: string) => void;
}) {
  const { job } = props;
  // `t` is normally supplied by the parent (which holds the provider-bound
  // translator). It is optional so the component can be rendered in isolation
  // (e.g. renderToStaticMarkup in unit tests); the provider-less `useT()`
  // fallback resolves real strings against the stored/default language.
  const fallback = useT();
  const t = props.t ?? fallback.t;
  const sessions = props.sessions ?? [];
  const lastSession = sessions[0];

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

  const [tzOffsetFilter, setTzOffsetFilter] = useState<number | "all">("all");
  const tzCityOptions = useMemo(
    () =>
      allTimezones()
        .filter((z) => tzOffsetFilter === "all" || offsetBucket(z) === tzOffsetFilter)
        .map((z) => ({ value: z, label: z, hint: offsetLabel(z) })),
    [tzOffsetFilter],
  );
  const offsetOptions = useMemo(
    () => [
      { value: "all", label: t("auto.detail.tzAllOffsets") },
      ...uniqueOffsetBuckets().map((b) => ({ value: String(b), label: bucketLabel(b) })),
    ],
    [t],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
              job.enabled ? "bg-status-ok" : "bg-muted-foreground",
            )}
          />
          <div className="flex min-w-0 flex-col">
            <h3 className="truncate text-base font-semibold text-foreground">{job.name}</h3>
            <p className="text-xs text-muted-foreground">{describeSchedule(job.schedule)} · {job.timezone ?? "UTC"}</p>
            {job.resumeSessionId && (
              <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                <Link2 size={11} />{t("auto.detail.resumeBadge")}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={job.enabled}
            onCheckedChange={(v) => props.onToggleEnabled(v)}
            disabled={props.toggleBusy}
            aria-label={job.enabled ? t("auto.detail.enabled") : t("auto.detail.pausedAria")}
          />
          <Button size="sm" onClick={props.onRunNow} disabled={props.runNowBusy}>
            {props.runNowBusy ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t("auto.detail.running")}
              </>
            ) : (
              <>
                <Play size={14} />
                {t("auto.detail.runNow")}
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-status-err"
            onClick={props.onDelete}
            disabled={props.deleteBusy}
            aria-label={t("auto.detail.delete")}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border bg-card p-3">
          <span className="text-xs text-muted-foreground">{t("auto.detail.nextRun")}</span>
          <strong className="mt-1 block text-sm text-foreground">{fmtRelative(job.nextRun, t)}</strong>
          {job.nextRun != null && <span className="block text-[10px] text-muted-foreground tabular-nums">{fmtTime(job.nextRun)}</span>}
        </div>
        <div className="rounded-md border bg-card p-3">
          <span className="text-xs text-muted-foreground">{t("auto.detail.lastRun")}</span>
          <strong className="mt-1 block text-sm text-foreground">{fmtRelative(job.lastRun, t)}</strong>
          {job.lastRun != null && <span className="block text-[10px] text-muted-foreground tabular-nums">{fmtTime(job.lastRun)}</span>}
        </div>
        <div className="rounded-md border bg-card p-3">
          <span className="text-xs text-muted-foreground">{t("auto.detail.runTimes")}</span>
          <strong className="mt-1 block text-sm text-foreground">{job.runCount}</strong>
        </div>
      </div>

      {/* Prompt — edit button reveals an inline textarea (long text). */}
      {editingPrompt ? (
        <div className="flex flex-col gap-3 rounded-md border bg-card p-3">
          <Textarea value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)} rows={5} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => { setEditingPrompt(false); setPromptDraft(job.prompt); }}>
              {t("auto.detail.cancel")}
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
                  {t("auto.detail.saving")}
                </>
              ) : (
                t("auto.detail.save")
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-md border bg-card p-3">
          <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm">
            {job.prompt}
          </pre>
          <Button size="sm" variant="outline" onClick={() => setEditingPrompt(true)}>{t("auto.detail.edit")}</Button>
        </div>
      )}

      <div className="rounded-md border bg-card p-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("auto.detail.configSection")}</p>

        <FieldRow label={t("auto.detail.frequency")}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Step 1: cadence type. */}
            <Select value={sched.kind} onValueChange={(v) => onCadenceChange(v as Schedule["kind"])}>
              <SelectTrigger className="h-8 w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CADENCE_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{t(c.labelKey)}</SelectItem>
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
                  {weekdayLabels().map((label, i) => (
                    <SelectItem key={i} value={String(i)}>{label}</SelectItem>
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
                    <SelectItem key={h} value={String(h)}>{t("auto.cadence.everyHours", { hours: h })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {sched.kind === "custom" && (
              <Input
                className="h-8 w-[180px] font-mono"
                value={customDraft}
                placeholder={t("auto.detail.cronPlaceholder")}
                onChange={(e) => setCustomDraft(e.target.value)}
                onBlur={applyCustomSchedule}
                onKeyDown={(e) => { if (e.key === "Enter") applyCustomSchedule(); }}
              />
            )}
          </div>
        </FieldRow>

        <FieldRow label={t("auto.detail.timezone")}>
          <div className="flex items-center gap-2">
            <Combobox
              options={offsetOptions}
              value={tzOffsetFilter === "all" ? "all" : String(tzOffsetFilter)}
              onChange={(v) => setTzOffsetFilter(v === "all" ? "all" : Number(v))}
              triggerClassName="w-[110px]"
              searchPlaceholder={t("auto.detail.tzSearch")}
            />
            <Combobox
              options={tzCityOptions}
              value={job.timezone ?? "UTC"}
              onChange={(v) => { if (v !== job.timezone) props.onSave({ timezone: v }); }}
              triggerClassName="w-[200px]"
              searchPlaceholder={t("auto.detail.tzSearch")}
              emptyText={t("auto.detail.tzEmpty")}
            />
          </div>
        </FieldRow>

        <FieldRow label={t("auto.detail.permission")}>
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
                <SelectItem key={p.value} value={p.value}>{t(p.labelKey)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>

        <FieldRow label={t("auto.detail.project")}>
          <Select
            value={selectedProjectValue(job.cwd)}
            onValueChange={(v) => {
              const nextCwd = cwdFromSelection(v);
              if (nextCwd !== (job.cwd ?? "")) props.onSave({ cwd: nextCwd });
            }}
          >
            <SelectTrigger className="h-8 w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {buildProjectOptions(props.repos, job.cwd).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
      </div>

      {job.resumeSessionId ? (
        <div className="rounded-md border bg-card p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("auto.detail.boundConversation")}</p>
          {(() => {
            const bound = sessions.find(
              (l) => (l.session.engineSessionId ?? l.session.id) === job.resumeSessionId,
            );
            if (!bound)
              return (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t("auto.detail.boundNotFound")}</div>
              );
            const status = bound.run?.status ?? bound.session.runStatus;
            const when = bound.run?.updatedAt ?? bound.session.updatedAt;
            return (
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
                onClick={() => {
                  if (bound.needsImport && bound.run) props.onOpenRunSession(bound.run);
                  else if (bound.disk) props.onOpenDiskSession(bound.disk);
                  else props.onOpenSession(bound.repoId, bound.session.id);
                }}
              >
                <Link2 size={14} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{bound.session.title || t("auto.detail.untitled")}</span>
                  <small className="block truncate text-xs text-muted-foreground">{shortDate(when)} · {runStatusLabel(t, status)}</small>
                </span>
                <span className="text-xs text-primary">{t("auto.detail.openConversation")} →</span>
              </Button>
            );
          })()}
        </div>
      ) : (
        <div className="rounded-md border bg-card p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-foreground">{t("auto.detail.runSession")}</h4>
              <p className="text-xs text-muted-foreground">{lastSession ? t("auto.detail.recentAt", { when: shortDate(lastSession.run?.updatedAt ?? lastSession.session.updatedAt) }) : t("auto.detail.noSession")}</p>
            </div>
            {job.lastRunId && (
              <Button size="sm" variant="outline" onClick={() => props.onViewRun(job.lastRunId!)}>
                <History size={14} />
                {t("auto.detail.runDetail")}
              </Button>
            )}
          </div>
          {sessions.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t("auto.detail.noJumpableSession")}</div>
          ) : (
            <ul className="space-y-1">
              {sessions.map(({ repoId, session, run, disk, needsImport }) => {
                // Trust the flag set at link synthesis (automationSessionLinks):
                // local-present links carry needsImport=false, disk/run-only links
                // carry true. The old per-row `props.sessions.find()` was O(rows²)
                // and used a different predicate, risking re-import of an
                // already-local session.
                const status = run?.status ?? session.runStatus;
                const when = run?.updatedAt ?? session.updatedAt;
                return (
                  <li key={`${repoId ?? NO_REPO_KEY}:${session.id}`}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
                      onClick={() => {
                        if (needsImport && run) props.onOpenRunSession(run);
                        else if (disk) props.onOpenDiskSession(disk);
                        else props.onOpenSession(repoId, session.id);
                      }}
                    >
                      <Clock3 size={14} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{session.title}</span>
                        <small className="block truncate text-xs text-muted-foreground">{shortDate(when)} · {runStatusLabel(t, status)}</small>
                      </span>
                      <span className="text-xs text-primary">{t("auto.detail.sessionView")}</span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
