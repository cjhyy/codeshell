import React, { useEffect, useId, useRef, useState } from "react";
import { Activity, FileClock, Loader2, RefreshCw } from "lucide-react";
import type { RunSummary, RunDetail } from "../../preload/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT, type TFunction } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";

const STATUSES: Record<string, { tone: string; label: TranslationKey }> = {
  queued: { tone: "text-muted-foreground", label: "auto.runs.statusQueued" },
  running: { tone: "text-status-running", label: "auto.runs.statusRunning" },
  waiting_input: { tone: "text-status-warn", label: "auto.runs.statusWaitingInput" },
  waiting_approval: { tone: "text-status-warn", label: "auto.runs.statusWaitingApproval" },
  blocked: { tone: "text-status-warn", label: "auto.runs.statusBlocked" },
  completed: { tone: "text-status-ok", label: "auto.runs.statusCompleted" },
  failed: { tone: "text-status-err", label: "auto.runs.statusFailed" },
  cancelled: { tone: "text-muted-foreground", label: "auto.runs.statusCancelled" },
  unknown: { tone: "text-muted-foreground", label: "auto.runs.statusUnknown" },
};

const EVENT_LABELS: Record<string, TranslationKey> = {
  run_created: "auto.runs.eventCreated",
  run_queued: "auto.runs.eventQueued",
  run_started: "auto.runs.eventStarted",
  session_linked: "auto.runs.eventSessionLinked",
  checkpoint_written: "auto.runs.eventCheckpoint",
  artifact_recorded: "auto.runs.eventArtifact",
  approval_requested: "auto.runs.eventApprovalRequested",
  approval_resolved: "auto.runs.eventApprovalResolved",
  run_blocked: "auto.runs.eventBlocked",
  run_resumed: "auto.runs.eventResumed",
  run_completed: "auto.runs.eventCompleted",
  run_failed: "auto.runs.eventFailed",
  run_cancelled: "auto.runs.eventCancelled",
  run_result: "auto.runs.eventResult",
  message: "auto.runs.eventMessage",
  tool_use: "auto.runs.eventToolUse",
  tool_result: "auto.runs.eventToolResult",
  turn_boundary: "auto.runs.eventTurnBoundary",
  turn_stopped: "auto.runs.eventCancelled",
};

type DetailState =
  | { kind: "idle" }
  | { kind: "loading"; runId: string }
  | { kind: "ready"; runId: string; detail: RunDetail }
  | { kind: "missing"; runId: string }
  | { kind: "error"; runId: string; message: string };

function statusLabel(status: string, t: TFunction): string {
  return STATUSES[status] ? t(STATUSES[status].label) : status || t("auto.runs.none");
}

function RunStatus({ status, t }: { status: string; t: TFunction }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        STATUSES[status]?.tone ?? "text-muted-foreground",
      )}
      title={status}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {statusLabel(status, t)}
    </span>
  );
}

function formatTime(timestamp: number, lang: string, compact = false): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString(
    lang === "zh" ? "zh-CN" : "en-US",
    compact
      ? {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }
      : undefined,
  );
}

export function RunsView({ initialRunId }: { initialRunId?: string | null } = {}) {
  const { t, lang } = useT();
  const detailId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(initialRunId ?? null);
  const [detail, setDetail] = useState<DetailState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [revision, setRevision] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await window.codeshell.listRuns({ includeSessions: true });
        if (!cancelled) setRuns(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  // A deep link can target a run outside the default list page.
  useEffect(() => {
    if (initialRunId) {
      setSelected(initialRunId);
      setFilter("all");
    }
  }, [initialRunId]);

  useEffect(() => {
    if (!selected) {
      setDetail({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setDetail({ kind: "loading", runId: selected });
    void (async () => {
      try {
        const result = await window.codeshell.getRun(selected);
        if (!cancelled)
          setDetail(
            result
              ? { kind: "ready", runId: selected, detail: result }
              : { kind: "missing", runId: selected },
          );
      } catch (e) {
        if (!cancelled)
          setDetail({
            kind: "error",
            runId: selected,
            message: e instanceof Error ? e.message : String(e),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, revision, detailAttempt]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, runs, filter]);

  const filtered = (runs ?? []).filter((run) => filter === "all" || run.status === filter);
  const selectionFilteredOut =
    filter !== "all" &&
    runs?.some((run) => run.runId === selected) &&
    !filtered.some((run) => run.runId === selected);
  const visibleDetail: DetailState =
    selected && (detail.kind === "idle" || detail.runId !== selected)
      ? { kind: "loading", runId: selected }
      : detail;
  const refresh = () => {
    if (listLoading) return;
    refreshRef.current?.focus({ preventScroll: true });
    setRevision((value) => value + 1);
  };
  const retryDetail = () => {
    detailRef.current?.focus({ preventScroll: true });
    setDetailAttempt((value) => value + 1);
  };

  return (
    <div className="@container/runs flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-5 @min-[760px]/runs:px-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{t("auto.runs.title")}</h1>
            {runs && (
              <span className="rounded-full border border-border/70 bg-card px-2.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                {t("auto.runs.count", { count: runs.length })}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">{t("auto.runs.subtitle")}</p>
        </div>
        <Button
          ref={refreshRef}
          size="sm"
          variant="outline"
          className="h-9 gap-2 rounded-xl aria-disabled:cursor-wait aria-disabled:opacity-60"
          aria-disabled={listLoading}
          onClick={refresh}
        >
          {listLoading ? (
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <RefreshCw size={14} aria-hidden />
          )}
          {t("auto.runs.refresh")}
        </Button>
      </div>
      {error && (
        <div className="mx-4 mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-status-err/20 bg-status-err/5 p-3 @min-[760px]/runs:mx-6">
          <p role="alert" className="min-w-0 flex-1 break-words text-sm text-status-err">
            {t("auto.runs.listFailed", { message: error })}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="rounded-lg"
            disabled={listLoading}
            onClick={refresh}
          >
            {t("auto.runs.retry")}
          </Button>
        </div>
      )}
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(128px,0.4fr)_minmax(0,1fr)] gap-4 px-4 pb-4 @min-[760px]/runs:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] @min-[760px]/runs:grid-rows-1 @min-[760px]/runs:px-6 @min-[760px]/runs:pb-6">
        <section
          aria-label={t("auto.runs.list")}
          className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/70"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2.5">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger
                ref={filterRef}
                aria-label={t("auto.runs.filterLabel")}
                className="h-8 min-w-0 flex-1 rounded-lg text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("auto.runs.filterAll")}</SelectItem>
                {Object.entries(STATUSES).map(([status, { label }]) => (
                  <SelectItem key={status} value={status}>
                    {t(label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {runs && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {filtered.length}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={listLoading}>
            {!runs && listLoading ? (
              <RunPlaceholder loading>{t("auto.runs.loading")}</RunPlaceholder>
            ) : !runs && error ? (
              <RunPlaceholder>{t("auto.runs.listUnavailable")}</RunPlaceholder>
            ) : filtered.length === 0 ? (
              <RunPlaceholder>
                <strong className="font-medium text-foreground">
                  {t(filter === "all" ? "auto.runs.emptyTitle" : "auto.runs.noMatch")}
                </strong>
                {filter === "all" ? (
                  <p>{t("auto.runs.emptyHint")}</p>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 rounded-lg"
                    onClick={() => {
                      setFilter("all");
                      filterRef.current?.focus();
                    }}
                  >
                    {t("auto.runs.clearFilter")}
                  </Button>
                )}
              </RunPlaceholder>
            ) : (
              <ul className="space-y-1">
                {filtered.map((run) => (
                  <li key={run.runId}>
                    <button
                      ref={selected === run.runId ? selectedRef : undefined}
                      type="button"
                      aria-pressed={selected === run.runId}
                      aria-controls={detailId}
                      onClick={() => setSelected(run.runId)}
                      className={cn(
                        "flex w-full min-w-0 flex-col gap-2 rounded-xl border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        selected === run.runId
                          ? "border-primary/20 bg-primary/8"
                          : "border-transparent hover:bg-accent",
                      )}
                    >
                      <span
                        className="line-clamp-2 w-full break-words text-sm font-medium"
                        title={run.objective}
                      >
                        {run.objective || t("auto.runs.noObjective")}
                      </span>
                      <span className="flex w-full flex-wrap items-center justify-between gap-2">
                        <RunStatus status={run.status} t={t} />
                        <span
                          className="text-[11px] tabular-nums text-muted-foreground"
                          title={formatTime(run.updatedAt, lang)}
                        >
                          {formatTime(run.updatedAt, lang, true)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <div
          ref={detailRef}
          id={detailId}
          role="region"
          aria-label={t("auto.runs.details")}
          aria-busy={visibleDetail.kind === "loading"}
          tabIndex={0}
          className="@container/run-detail min-h-0 min-w-0 overflow-y-auto rounded-2xl border border-border/70 bg-card/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {selectionFilteredOut && (
            <p className="border-b border-border/70 bg-muted/30 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {t("auto.runs.selectionFilteredOut")}
            </p>
          )}
          {visibleDetail.kind === "ready" ? (
            <RunDetailView detail={visibleDetail.detail} t={t} lang={lang} />
          ) : visibleDetail.kind === "loading" ? (
            <RunPlaceholder loading>{t("auto.runs.detailLoading")}</RunPlaceholder>
          ) : visibleDetail.kind === "missing" || visibleDetail.kind === "error" ? (
            <RunPlaceholder>
              <p
                role={visibleDetail.kind === "error" ? "alert" : undefined}
                className={
                  visibleDetail.kind === "error" ? "break-words text-status-err" : undefined
                }
              >
                {visibleDetail.kind === "missing"
                  ? t("auto.runs.detailNotFound")
                  : t("auto.runs.detailFailed", { message: visibleDetail.message })}
              </p>
              <Button size="sm" variant="outline" className="mt-1 rounded-lg" onClick={retryDetail}>
                {t("auto.runs.retryDetail")}
              </Button>
            </RunPlaceholder>
          ) : (
            <RunPlaceholder>{t("auto.runs.selectRun")}</RunPlaceholder>
          )}
        </div>
      </div>
    </div>
  );
}

function RunPlaceholder({
  children,
  loading = false,
}: {
  children: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div
      role="status"
      className="flex min-w-0 flex-col items-center gap-3 px-4 py-8 text-center text-sm leading-relaxed text-muted-foreground"
    >
      {loading ? (
        <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <FileClock size={24} className="opacity-60" aria-hidden />
      )}
      {children}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 border-t border-border/70 pt-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {title}
        {count !== undefined && (
          <span className="text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function RunDetailView({ detail, t, lang }: { detail: RunDetail; t: TFunction; lang: string }) {
  const metadata = [
    { label: t("auto.runs.runId"), value: detail.runId },
    { label: t("auto.runs.updatedAt"), value: formatTime(detail.updatedAt, lang) },
    { label: t("auto.runs.cwd"), value: detail.cwd },
    ...(detail.preset ? [{ label: t("auto.runs.preset"), value: detail.preset }] : []),
    ...(detail.sessionId ? [{ label: t("auto.runs.sessionId"), value: detail.sessionId }] : []),
    { label: t("auto.runs.attempts"), value: String(detail.attemptCount) },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-5 p-4 @min-[520px]/run-detail:p-5">
      <div className="flex min-w-0 flex-col items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl border border-primary/15 bg-primary/5 text-primary">
          <Activity size={19} aria-hidden />
        </span>
        <h2 className="w-full break-words text-lg font-semibold leading-snug">
          {detail.objective || t("auto.runs.noObjective")}
        </h2>
        <RunStatus status={detail.status} t={t} />
      </div>
      <dl className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-3 rounded-xl bg-muted/40 p-3 @min-[520px]/run-detail:grid-cols-2">
        {metadata.map(({ label, value }) => (
          <div key={label} className="min-w-0">
            <dt className="mb-1 text-[11px] text-muted-foreground">{label}</dt>
            <dd className="break-all text-xs leading-5 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {detail.error && (
        <div
          role="alert"
          className="whitespace-pre-wrap break-words rounded-xl border border-status-err/20 bg-status-err/5 p-3 text-sm text-status-err"
        >
          {detail.error}
        </div>
      )}
      {detail.summary && (
        <Section title={t("auto.runs.summary")}>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {detail.summary}
          </p>
        </Section>
      )}
      <Section title={t("auto.runs.checkpoints")} count={detail.checkpoints.length}>
        {detail.checkpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("auto.runs.none")}</p>
        ) : (
          <ol className="space-y-2">
            {detail.checkpoints.map((checkpoint) => (
              <li
                key={checkpoint.checkpointId}
                className="min-w-0 rounded-xl border border-border/70 p-3 text-sm"
              >
                <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <strong className="break-all text-xs font-medium">
                    {statusLabel(checkpoint.phase, t)}
                  </strong>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {formatTime(checkpoint.createdAt, lang)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words leading-relaxed">
                  {checkpoint.summary}
                </p>
                {checkpoint.nextAction && (
                  <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">
                    {t("auto.runs.nextStep", { action: checkpoint.nextAction })}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title={t("auto.runs.artifacts")} count={detail.artifacts.length}>
        {detail.artifacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("auto.runs.none")}</p>
        ) : (
          <ul className="space-y-2">
            {detail.artifacts.map((artifact) => (
              <li key={artifact} className="min-w-0 rounded-lg bg-muted/40 px-3 py-2">
                <code className="break-all text-xs leading-5">{artifact}</code>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("auto.runs.events")} count={detail.events.length}>
        {detail.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("auto.runs.none")}</p>
        ) : (
          <ol className="divide-y divide-border/60">
            {detail.events
              .slice()
              .reverse()
              .map((event) => (
                <li
                  key={event.eventId}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-xs"
                >
                  <span className="min-w-0 break-all" title={event.type}>
                    {EVENT_LABELS[event.type] ? t(EVENT_LABELS[event.type]) : event.type}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatTime(event.timestamp, lang)}
                  </span>
                </li>
              ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
