import React, { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { Clock3, Link2, Loader2, PackageOpen, Play, Plus, Repeat2, Trash2 } from "lucide-react";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "../transcripts";
import {
  parseSchedule,
  buildSchedule,
  describeSchedule,
  weekdayLabels,
  type Schedule,
} from "./scheduleModel";
import type { DiskSessionMeta } from "./rebuildFromDisk";
import type { TrackedProject } from "../projects";
import { buildProjectOptions, selectedProjectValue, cwdFromSelection } from "./projectOptions";
import { Combobox } from "@/components/ui/combobox";
import {
  allTimezones,
  offsetLabel,
  offsetBucket,
  uniqueOffsetBuckets,
  bucketLabel,
} from "./timezones";
import { cn } from "@/lib/utils";
import { fmtRelative } from "./relativeTime";
import { AutomationExecutionSettings } from "./AutomationExecutionSettings";
import { buildAutomationConversations, type AutomationConversation } from "./sessionOptions";
import { isCaseInsensitivePlatform } from "./pathMatch";
import { useT, type TFunction } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";

export const PERMISSION_OPTIONS: {
  value: string;
  labelKey: TranslationKey;
  tone: "ok" | "warn" | "err";
}[] = [
  { value: "read-only", labelKey: "auto.permission.readOnly", tone: "ok" },
  { value: "workspace-write", labelKey: "auto.permission.workspaceWrite", tone: "warn" },
  { value: "full", labelKey: "auto.permission.full", tone: "err" },
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
      return status || t("auto.runStatus.session");
  }
}

function scheduleLabel(job: AutomationSummary, t: TFunction): string {
  return job.once
    ? job.nextRun
      ? t("auto.schedule.onceAt", { time: new Date(job.nextRun).toLocaleString() })
      : t("auto.schedule.once")
    : describeSchedule(job.schedule);
}

function RunStatus({ status, t }: { status?: string; t: TFunction }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        status === "failed"
          ? "bg-status-err/10 text-status-err"
          : status === "completed"
            ? "bg-status-ok/10 text-status-ok"
            : status === "running" || status === "queued"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
      )}
    >
      {runStatusLabel(t, status)}
    </span>
  );
}

type AutomationSessionLink = {
  projectId: string | null;
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
    runs.filter((r) => r.sessionId).map((r) => [r.sessionId as string, r]),
  );
  // Matched by job NAME only. `lastRunId` used to be part of this, but nothing
  // in production sets it (see the note at the detail header), so it only ever
  // widened the predicate with a null.
  const matchingRunIds = new Set(
    runs.filter((r) => r.source === "automation" && r.cronJobName === job.name).map((r) => r.runId),
  );

  const out: AutomationSessionLink[] = [];
  const seenRunIds = new Set<string>();
  const seenSessionIds = new Set<string>();
  for (const [projectBucketSegment, idx] of Object.entries(sessionIndices)) {
    const projectId = projectBucketSegment === NO_REPO_KEY ? null : projectBucketSegment;
    for (const session of idx.sessions) {
      if (session.source !== "automation" || session.archived) continue;
      const run = session.runId
        ? runsById.get(session.runId)
        : runsBySessionId.get(session.engineSessionId ?? session.id);
      const matches =
        session.title === job.name ||
        (session.runId ? matchingRunIds.has(session.runId) : false) ||
        run?.cronJobName === job.name;
      if (matches) {
        // Locally-present session (found in a repo's session index) → already
        // imported, so never flag it for import. Set explicitly so the render
        // site can trust `link.needsImport` instead of re-deriving it.
        out.push({ projectId, session, run, needsImport: false });
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
      run.cronJobName !== job.name
    ) {
      continue;
    }
    out.push({
      projectId: null,
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
      job.lastRun != null && Math.abs(disk.updatedAt - job.lastRun) < 24 * 60 * 60 * 1000;
    if (!promptMatches && !timeMatches) continue;
    out.push({
      projectId: null,
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
  onOpenRunSession,
  onOpenDiskSession,
  onOpenSession,
  sessionIndices,
  projects,
}: {
  onCreateConversational: () => void;
  onOpenRunSession: (run: RunSummary) => void;
  onOpenDiskSession: (session: DiskSessionMeta) => void;
  onOpenSession: (projectId: string | null, sessionId: string) => void;
  sessionIndices: Record<string, SessionIndex>;
  projects: TrackedProject[];
}) {
  const { t } = useT();
  const detailId = useId();
  const [jobs, setJobs] = useState<AutomationSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [diskSessions, setDiskSessions] = useState<DiskSessionMeta[]>([]);
  const [diskCursor, setDiskCursor] = useState<string | null>(null);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const conversationsLoadingRef = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  /** Per-action in-flight flags, keyed by "<action>:<jobId>". */
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const pendingKeys = useRef(new Set<string>());

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

  const loadConversations = async (cursor?: string) => {
    if (conversationsLoadingRef.current) return;
    conversationsLoadingRef.current = true;
    setLoadingConversations(true);
    setError(null);
    try {
      const page = await window.codeshell.listDiskSessions({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      setDiskSessions((previous) => (cursor ? [...previous, ...page.sessions] : page.sessions));
      setDiskCursor(page.nextCursor ?? null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      conversationsLoadingRef.current = false;
      setLoadingConversations(false);
    }
  };

  useEffect(() => {
    void refresh();
    void loadConversations();
  }, []);

  const conversations = useMemo(
    () =>
      buildAutomationConversations(sessionIndices, diskSessions, projects, {
        includeArchived: true,
        caseInsensitive: isCaseInsensitivePlatform(),
        noProjectLabel: t("auto.projectOptions.noProject"),
        unknownProjectLabel: t("auto.detail.unknownProject"),
      }),
    [sessionIndices, diskSessions, projects, t],
  );

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
  const act = async (key: string, fn: () => Promise<unknown>, binding = false) => {
    if (pendingKeys.current.has(key)) return;
    pendingKeys.current.add(key);
    setPending((p) => ({ ...p, [key]: true }));
    setError(null);
    setBindingError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      (binding ? setBindingError : setError)(String(e instanceof Error ? e.message : e));
    } finally {
      pendingKeys.current.delete(key);
      setPending((p) => ({ ...p, [key]: false }));
    }
  };

  if (error && !jobs) {
    return (
      <div className="m-4 flex min-w-0 flex-col items-start gap-3 rounded-2xl border border-status-err/20 bg-status-err/5 p-5 text-sm">
        <p role="alert" className="break-words text-status-err">
          {error}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null);
            void refresh();
          }}
        >
          {t("auto.view.retry")}
        </Button>
      </div>
    );
  }
  if (!jobs)
    return (
      <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        {t("auto.view.loading")}
      </div>
    );

  return (
    <div className="@container/automation flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-5 @min-[760px]/automation:px-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              {t("auto.view.title")}
            </h1>
            <span className="rounded-full border border-border/70 bg-card px-2.5 py-0.5 text-xs tabular-nums text-muted-foreground">
              {t("auto.view.jobCount", { count: jobs.length })}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">{t("auto.view.subtitle")}</p>
        </div>
        {jobs.length > 0 && (
          <Button className="rounded-xl" onClick={onCreateConversational}>
            <Plus size={14} />
            {t("auto.view.create")}
          </Button>
        )}
      </div>

      {jobs.length === 0 ? (
        <div className="mx-4 mb-4 flex min-h-0 flex-1 items-center justify-center overflow-y-auto rounded-2xl border border-border/70 bg-card/70 p-6 @min-[760px]/automation:mx-6">
          <div className="max-w-sm text-center">
            <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Repeat2 size={22} aria-hidden="true" />
            </span>
            <h2 className="text-base font-semibold text-foreground">{t("auto.view.emptyTitle")}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {t("auto.view.empty")}
            </p>
            <Button className="mt-5 rounded-xl" onClick={onCreateConversational}>
              <Plus size={16} aria-hidden="true" />
              {t("auto.view.create")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(112px,0.35fr)_minmax(0,1fr)] gap-4 px-4 pb-4 @min-[760px]/automation:grid-cols-[minmax(220px,280px)_minmax(0,1fr)] @min-[760px]/automation:grid-rows-1 @min-[760px]/automation:px-6 @min-[760px]/automation:pb-6">
          <ul
            aria-label={t("auto.view.jobList")}
            className="min-h-0 min-w-0 space-y-1 overflow-y-auto rounded-2xl border border-border/70 bg-card/70 p-2"
          >
            {jobs.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  aria-pressed={selected === j.id}
                  aria-controls={detailId}
                  onClick={() => {
                    setSelected(j.id);
                    setError(null);
                    setBindingError(null);
                  }}
                  className={cn(
                    "flex w-full min-w-0 flex-col gap-2 rounded-xl border px-3 py-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    selected === j.id
                      ? "border-primary/20 bg-primary/8 text-foreground"
                      : "border-transparent hover:bg-accent",
                  )}
                >
                  <span className="w-full min-w-0">
                    <span className="block truncate font-medium" title={j.name}>
                      {j.name}
                    </span>
                    <span
                      className="mt-1 block truncate text-xs text-muted-foreground"
                      title={scheduleLabel(j, t)}
                    >
                      {scheduleLabel(j, t)}
                    </span>
                  </span>
                  <span className="flex w-full flex-wrap items-center justify-between gap-2 text-xs">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5",
                        j.enabled ? "text-status-ok" : "text-muted-foreground",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 rounded-full",
                          j.enabled ? "bg-status-ok" : "bg-muted-foreground",
                        )}
                      />
                      {j.enabled ? t("auto.view.active") : t("auto.view.paused")}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {t("auto.view.runCount", { count: j.runCount })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div
            id={detailId}
            role="region"
            aria-label={detail?.name ?? t("auto.view.selectJob")}
            className="min-h-0 min-w-0 overflow-y-auto rounded-2xl"
          >
            {error && (
              <p
                role="alert"
                className="mb-3 break-words rounded-xl border border-status-err/20 bg-status-err/5 p-3 text-sm text-status-err [overflow-wrap:anywhere]"
              >
                {error}
              </p>
            )}
            {detail ? (
              <AutomationDetail
                t={t}
                job={detail}
                projects={projects}
                sessions={automationSessionLinks(detail, sessionIndices, runs, diskSessions)}
                conversations={conversations}
                bindingError={bindingError}
                onClearBindingError={() => setBindingError(null)}
                conversationsLoading={loadingConversations}
                onRefreshConversations={() => void loadConversations()}
                onLoadMoreConversations={
                  diskCursor ? () => void loadConversations(diskCursor) : undefined
                }
                onToggleEnabled={(next) =>
                  act("toggle:" + detail.id, () =>
                    next
                      ? window.codeshell.resumeAutomation(detail.id)
                      : window.codeshell.pauseAutomation(detail.id),
                  )
                }
                onDelete={() =>
                  act("delete:" + detail.id, () => window.codeshell.deleteAutomation(detail.id))
                }
                onRunNow={() =>
                  act("runNow:" + detail.id, () => window.codeshell.runAutomationNow(detail.id))
                }
                onSave={(patch) =>
                  act(
                    "save:" + detail.id,
                    () => window.codeshell.updateAutomation(detail.id, patch),
                    patch.resumeSessionId !== undefined,
                  )
                }
                runNowBusy={!!pending["runNow:" + detail.id]}
                deleteBusy={!!pending["delete:" + detail.id]}
                toggleBusy={!!pending["toggle:" + detail.id]}
                saveBusy={!!pending["save:" + detail.id]}
                onOpenRunSession={onOpenRunSession}
                onOpenDiskSession={onOpenDiskSession}
                onOpenSession={onOpenSession}
              />
            ) : (
              <div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">
                {t("auto.view.selectJob")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid min-w-0 items-start gap-2 border-b border-border/70 py-3 text-sm last:border-b-0 @min-[520px]/automation-detail:grid-cols-[100px_minmax(0,1fr)] @min-[520px]/automation-detail:items-center"
    >
      <span aria-hidden="true" className="text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-2 font-medium">{children}</div>
    </div>
  );
}

export function AutomationDetail(props: {
  t?: TFunction;
  job: AutomationSummary;
  projects: TrackedProject[];
  onToggleEnabled: (next: boolean) => void;
  onDelete: () => void;
  onRunNow: () => void;
  onSave: (patch: {
    name?: string;
    schedule?: string;
    prompt?: string;
    timezone?: string;
    cwd?: string;
    projectId?: string | null;
    rootId?: string | null;
    permissionLevel?: AutomationPermissionLevel;
    resumeSessionId?: string | null;
  }) => void | Promise<unknown>;
  sessions: AutomationSessionLink[];
  conversations?: AutomationConversation[];
  bindingError?: string | null;
  onClearBindingError?: () => void;
  conversationsLoading?: boolean;
  onRefreshConversations?: () => void;
  onLoadMoreConversations?: () => void;
  runNowBusy: boolean;
  deleteBusy: boolean;
  toggleBusy: boolean;
  saveBusy: boolean;
  onOpenRunSession: (run: RunSummary) => void;
  onOpenDiskSession: (session: DiskSessionMeta) => void;
  onOpenSession: (projectId: string | null, sessionId: string) => void;
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
  const conversations = props.conversations ?? [];
  const boundConversation = conversations.find(
    (conversation) => conversation.sessionId === job.resumeSessionId,
  );

  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(job.prompt);
  const promptHeadingId = useId();
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const editPromptRef = useRef<HTMLButtonElement>(null);
  const restorePromptFocus = useRef<string | null>(null);

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

  useEffect(() => {
    if (editingPrompt) promptInputRef.current?.focus();
    else {
      if (restorePromptFocus.current === job.id) editPromptRef.current?.focus();
      restorePromptFocus.current = null;
    }
  }, [editingPrompt]);

  const closePromptEditor = () => {
    restorePromptFocus.current = job.id;
    setEditingPrompt(false);
  };

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
    <div className="@container/automation-detail flex min-w-0 flex-col gap-4">
      <div className="rounded-2xl border border-border/70 bg-card p-4 @min-[520px]/automation-detail:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 basis-52 items-start gap-3">
            <div className="flex min-w-0 flex-col">
              <h2 className="break-words text-lg font-semibold leading-snug tracking-tight text-foreground [overflow-wrap:anywhere]">
                {job.name}
              </h2>
              <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                {scheduleLabel(job, t)} · {job.timezone ?? "UTC"}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span
                  className={cn(
                    "inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                    job.enabled
                      ? "bg-status-ok/10 text-status-ok"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      job.enabled ? "bg-status-ok" : "bg-muted-foreground",
                    )}
                  />
                  {job.enabled ? t("auto.detail.statusActive") : t("auto.detail.statusPaused")}
                </span>
                {job.resumeSessionId && (
                  <span className="inline-flex w-fit items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    <Link2 size={11} aria-hidden="true" />
                    {t("auto.detail.resumeBadge")}
                  </span>
                )}
                {job.templateSource && (
                  <span className="inline-flex w-fit items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    <PackageOpen size={11} aria-hidden="true" />
                    {t("auto.detail.pluginTemplateBadge")}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Switch
              checked={job.enabled}
              onCheckedChange={(v) => props.onToggleEnabled(v)}
              disabled={props.toggleBusy || props.saveBusy}
              aria-label={t("auto.detail.enableAutomation")}
            />
            <Button
              size="sm"
              className="rounded-lg"
              onClick={props.onRunNow}
              disabled={props.runNowBusy || props.saveBusy || props.deleteBusy}
            >
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
              className="size-8 rounded-lg p-0 text-muted-foreground hover:bg-status-err/10 hover:text-status-err"
              onClick={props.onDelete}
              disabled={props.deleteBusy || props.saveBusy}
              aria-label={t("auto.detail.delete")}
              title={t("auto.detail.delete")}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-3 @min-[520px]/automation-detail:grid-cols-3">
        <div className="min-w-0 rounded-2xl border border-border/70 bg-card p-3">
          <span className="text-xs text-muted-foreground">{t("auto.detail.nextRun")}</span>
          <strong className="mt-1 block text-sm text-foreground">
            {fmtRelative(job.nextRun, t)}
          </strong>
          {job.nextRun != null && (
            <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
              {fmtTime(job.nextRun)}
            </span>
          )}
        </div>
        <div className="min-w-0 rounded-2xl border border-border/70 bg-card p-3">
          <span className="text-xs text-muted-foreground">{t("auto.detail.lastRun")}</span>
          <strong className="mt-1 block text-sm text-foreground">
            {fmtRelative(job.lastRun, t)}
          </strong>
          {job.lastRun != null && (
            <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
              {fmtTime(job.lastRun)}
            </span>
          )}
        </div>
        <div className="col-span-2 min-w-0 rounded-2xl border border-border/70 bg-card p-3 @min-[520px]/automation-detail:col-span-1">
          <span className="text-xs text-muted-foreground">{t("auto.detail.runTimes")}</span>
          <strong className="mt-1 block text-sm text-foreground tabular-nums">
            {job.runCount}
          </strong>
        </div>
      </div>

      {/* Prompt — edit button reveals an inline textarea (long text). */}
      <section
        aria-labelledby={promptHeadingId}
        className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={promptHeadingId} className="text-sm font-semibold text-foreground">
            {t("auto.detail.prompt")}
          </h3>
          <Button
            ref={editPromptRef}
            size="sm"
            variant="ghost"
            className="rounded-lg"
            disabled={editingPrompt}
            onClick={() => setEditingPrompt(true)}
          >
            {t("auto.detail.edit")}
          </Button>
        </div>
        {editingPrompt ? (
          <>
            <Textarea
              ref={promptInputRef}
              aria-labelledby={promptHeadingId}
              className="min-h-36 rounded-xl leading-relaxed"
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={5}
            />
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  closePromptEditor();
                  setPromptDraft(job.prompt);
                }}
              >
                {t("auto.detail.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={props.saveBusy || !promptDraft.trim()}
                onClick={() => {
                  if (promptDraft.trim() !== job.prompt)
                    props.onSave({ prompt: promptDraft.trim() });
                  closePromptEditor();
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
          </>
        ) : (
          <pre
            tabIndex={0}
            aria-labelledby={promptHeadingId}
            className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 font-sans text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
          >
            {job.prompt}
          </pre>
        )}
      </section>

      <AutomationExecutionSettings
        key={job.id}
        resumeSessionId={job.resumeSessionId}
        conversations={conversations}
        busy={props.saveBusy || props.runNowBusy}
        error={props.bindingError}
        onClearError={props.onClearBindingError}
        loading={props.conversationsLoading}
        onRefresh={props.onRefreshConversations}
        onLoadMore={props.onLoadMoreConversations}
        t={t}
        onSave={props.onSave}
        onOpen={(conversation) => {
          if (conversation.session)
            props.onOpenSession(conversation.projectId, conversation.session.id);
          else if (conversation.disk) props.onOpenDiskSession(conversation.disk);
        }}
      />

      <div className="min-w-0 rounded-2xl border border-border/70 bg-card p-4">
        <h3 className="mb-1 text-sm font-semibold text-foreground">
          {t("auto.detail.configSection")}
        </h3>

        <FieldRow label={t("auto.detail.frequency")}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Step 1: cadence type. */}
            <Select
              disabled={props.saveBusy}
              value={sched.kind}
              onValueChange={(v) => onCadenceChange(v as Schedule["kind"])}
            >
              <SelectTrigger
                aria-label={t("auto.detail.frequency")}
                className="h-9 w-[140px] max-w-full rounded-lg"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCE_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {t(c.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Step 2: per-cadence detail. */}
            {sched.kind === "weekly" && (
              <Select
                disabled={props.saveBusy}
                value={String(sched.weekday)}
                onValueChange={(v) => commitSchedule({ ...sched, weekday: Number(v) })}
              >
                <SelectTrigger
                  aria-label={t("auto.detail.weekday")}
                  className="h-9 w-[110px] max-w-full rounded-lg"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {weekdayLabels().map((label, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {(sched.kind === "daily" || sched.kind === "weekdays" || sched.kind === "weekly") && (
              <Input
                disabled={props.saveBusy}
                type="time"
                aria-label={t("auto.detail.time")}
                className="h-9 w-[130px] max-w-full rounded-lg"
                value={sched.time}
                onChange={(e) => {
                  if (e.target.value) commitSchedule({ ...sched, time: e.target.value });
                }}
              />
            )}

            {sched.kind === "hourly" && (
              <Select
                disabled={props.saveBusy}
                value={String(sched.everyHours)}
                onValueChange={(v) => commitSchedule({ kind: "hourly", everyHours: Number(v) })}
              >
                <SelectTrigger
                  aria-label={t("auto.detail.interval")}
                  className="h-9 w-[140px] max-w-full rounded-lg"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURLY_OPTIONS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {t("auto.cadence.everyHours", { hours: h })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {sched.kind === "custom" && (
              <Input
                disabled={props.saveBusy}
                aria-label={t("auto.detail.customSchedule")}
                className="h-9 w-[200px] max-w-full rounded-lg font-mono"
                value={customDraft}
                placeholder={t("auto.detail.cronPlaceholder")}
                onChange={(e) => setCustomDraft(e.target.value)}
                onBlur={applyCustomSchedule}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCustomSchedule();
                }}
              />
            )}
          </div>
        </FieldRow>

        <FieldRow label={t("auto.detail.timezone")}>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
            <Combobox
              disabled={props.saveBusy}
              options={offsetOptions}
              value={tzOffsetFilter === "all" ? "all" : String(tzOffsetFilter)}
              onChange={(v) => setTzOffsetFilter(v === "all" ? "all" : Number(v))}
              triggerClassName="h-9 w-[130px] max-w-full rounded-lg"
              searchPlaceholder={t("auto.detail.tzSearch")}
            />
            <Combobox
              disabled={props.saveBusy}
              options={tzCityOptions}
              value={job.timezone ?? "UTC"}
              onChange={(v) => {
                if (v !== job.timezone) props.onSave({ timezone: v });
              }}
              triggerClassName="h-9 w-[220px] min-w-0 max-w-full rounded-lg"
              searchPlaceholder={t("auto.detail.tzSearch")}
              emptyText={t("auto.detail.tzEmpty")}
            />
          </div>
        </FieldRow>

        <FieldRow label={t("auto.detail.permission")}>
          {job.resumeSessionId ? (
            <span className="text-sm text-muted-foreground">
              {t("auto.detail.inheritedPermission")}
            </span>
          ) : (
            <Select
              disabled={props.saveBusy}
              value={job.permissionLevel ?? "read-only"}
              onValueChange={(v) => {
                if (v !== (job.permissionLevel ?? "read-only")) {
                  props.onSave({ permissionLevel: v as AutomationPermissionLevel });
                }
              }}
            >
              <SelectTrigger
                aria-label={t("auto.detail.permission")}
                className="h-9 w-full max-w-[360px] min-w-0 rounded-lg"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-block h-2 w-2 rounded-full",
                          p.tone === "ok"
                            ? "bg-status-ok"
                            : p.tone === "warn"
                              ? "bg-status-warn"
                              : "bg-status-err",
                        )}
                      />
                      {t(p.labelKey)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FieldRow>

        <FieldRow label={t("auto.detail.project")}>
          {job.resumeSessionId ? (
            <div className="min-w-0">
              <span className="block break-words text-sm [overflow-wrap:anywhere]">
                {boundConversation?.projectLabel ??
                  buildProjectOptions(props.projects, job.cwd).find(
                    (option) => option.value === selectedProjectValue(job.cwd),
                  )?.label}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("auto.detail.inheritedProject")}
              </span>
            </div>
          ) : (
            <Select
              disabled={props.saveBusy}
              value={selectedProjectValue(job.cwd)}
              onValueChange={(v) => {
                const nextCwd = cwdFromSelection(v);
                const project = props.projects.find(
                  (candidate) =>
                    candidate.path === nextCwd ||
                    candidate.roots.some((root) => root.path === nextCwd),
                );
                const root = project?.roots.find((candidate) => candidate.path === nextCwd);
                if (project && root) {
                  if (
                    nextCwd !== (job.cwd ?? "") ||
                    project.id !== job.projectId ||
                    root.id !== job.rootId
                  ) {
                    props.onSave({
                      cwd: root.path,
                      projectId: project.id,
                      rootId: root.id,
                    });
                  }
                } else if (nextCwd !== (job.cwd ?? "") || job.projectId || job.rootId) {
                  props.onSave({
                    cwd: nextCwd,
                    ...(nextCwd ? {} : { projectId: null, rootId: null }),
                  });
                }
              }}
            >
              <SelectTrigger
                aria-label={t("auto.detail.project")}
                className="h-9 w-full max-w-[360px] min-w-0 rounded-lg"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {buildProjectOptions(props.projects, job.cwd).map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FieldRow>

        {job.templateSource && (
          <FieldRow label={t("auto.detail.templateSource")}>
            <span
              className="min-w-0 break-words font-mono text-xs [overflow-wrap:anywhere]"
              title={`${job.templateSource.installKey}/${job.templateSource.templateId}\n${job.templateSource.revision}`}
            >
              {job.templateSource.installKey}/{job.templateSource.templateId} ·{" "}
              {job.templateSource.revision.slice(0, 8)}
            </span>
          </FieldRow>
        )}
      </div>

      {!job.resumeSessionId && (
        <div className="min-w-0 rounded-2xl border border-border/70 bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {t("auto.detail.runSession")}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {lastSession
                  ? t("auto.detail.recentAt", {
                      when: shortDate(lastSession.run?.updatedAt ?? lastSession.session.updatedAt),
                    })
                  : t("auto.detail.noSession")}
              </p>
            </div>
            {/* The "view last run" button is gone: `lastRunId` is only ever set
                by bindCronToRunManager, and production automation runs through
                startAutomation({ runner }) — a plain Engine Session, never
                RunManager. So the field was permanently null and this button
                never rendered. Automation history IS the session list below. */}
          </div>
          {sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm leading-relaxed text-muted-foreground">
              {t("auto.detail.noJumpableSession")}
            </div>
          ) : (
            <ul className="space-y-1">
              {sessions.map(({ projectId, session, run, disk, needsImport }) => {
                // Trust the flag set at link synthesis (automationSessionLinks):
                // local-present links carry needsImport=false, disk/run-only links
                // carry true. The old per-row `props.sessions.find()` was O(rows²)
                // and used a different predicate, risking re-import of an
                // already-local session.
                const status = run?.status ?? session.runStatus;
                const when = run?.updatedAt ?? session.updatedAt;
                return (
                  <li key={`${projectId ?? NO_REPO_KEY}:${session.id}`}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto min-w-0 w-full flex-wrap justify-start gap-2 whitespace-normal rounded-xl px-3 py-3 text-left"
                      onClick={() => {
                        if (needsImport && run) props.onOpenRunSession(run);
                        else if (disk) props.onOpenDiskSession(disk);
                        else props.onOpenSession(projectId, session.id);
                      }}
                    >
                      <Clock3 size={16} aria-hidden="true" className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 basis-40">
                        <span className="block truncate text-sm font-medium">{session.title}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-2">
                          <small className="text-xs text-muted-foreground tabular-nums">
                            {shortDate(when)}
                          </small>
                          <RunStatus status={status} t={t} />
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-primary">
                        {t("auto.detail.sessionView")}
                      </span>
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
