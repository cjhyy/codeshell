import React, { useEffect, useMemo, useState } from "react";
import { Activity, Check, ChevronDown, Clock3, Coins, Copy, Wrench } from "lucide-react";
import type { UsageSummary } from "@cjhyy/code-shell-core";
import type { RunDetail } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT, type TFunction } from "../i18n/I18nProvider";
import type { TranslationKey } from "../i18n/dict";
import { useCopyFeedback } from "../ui/useCopyFeedback";
import { UsageSummaryView } from "./UsageSummaryView";
import { buildToolTraces, formatRunDuration, keyRunEvents } from "./runTrace";
import { formatRunTime, RunStatus, statusLabel } from "./runPresentation";

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

function traceJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function eventDetailTitle(event: RunDetail["events"][number], t: TFunction): string {
  const base = EVENT_LABELS[event.type] ? t(EVENT_LABELS[event.type]) : event.type;
  const toolName = typeof event.data.toolName === "string" ? event.data.toolName : null;
  const role = typeof event.data.role === "string" ? event.data.role : null;
  return toolName ? `${base} · ${toolName}` : role ? `${base} · ${role}` : base;
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

function TracePayload({ value }: { value: unknown }) {
  const { t } = useT();
  const text = useMemo(() => traceJson(value), [value]);
  return (
    <div className="min-w-0 rounded-lg bg-muted/50">
      <div className="flex justify-end px-1.5 pt-1">
        <CopyValue value={text} label={t("activityRuns.payload")} />
      </div>
      <pre
        tabIndex={0}
        className="max-h-96 min-w-0 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-[11px] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {text}
      </pre>
    </div>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const { t } = useT();
  const { copied, copy } = useCopyFeedback(value);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [value]);
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Button
        size="icon"
        variant="ghost"
        className="size-7 text-muted-foreground"
        title={t(copied ? "misc.toast.copied" : "activityRuns.copyValue", { label })}
        aria-label={t(copied ? "misc.toast.copied" : "activityRuns.copyValue", { label })}
        onClick={async () => {
          setFailed(false);
          setFailed(!(await copy(value)));
        }}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      </Button>
      {failed && (
        <span role="status" className="text-xs text-status-err">
          {t("misc.toast.copyFailed")}
        </span>
      )}
    </span>
  );
}

/** Native disclosure semantics, without mounting closed JSON payloads. */
function TraceDisclosure({
  title,
  aside,
  children,
}: {
  title: React.ReactNode;
  aside: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-xs marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <ChevronDown
          size={12}
          aria-hidden
          className={cn("shrink-0 transition-transform", open && "rotate-180")}
        />
        <span className="min-w-0 flex-1 break-all">{title}</span>
        <span className="ml-auto max-w-full break-words tabular-nums text-muted-foreground">
          {aside}
        </span>
      </summary>
      {open && <div className="space-y-3 border-t border-border/60 p-3">{children}</div>}
    </details>
  );
}

export function RunDetailView({
  detail,
  t,
  lang,
}: {
  detail: RunDetail;
  t: TFunction;
  lang: string;
}) {
  const [sessionUsage, setSessionUsage] = useState<{
    sessionId: string;
    summary: UsageSummary;
  } | null>(null);
  const [sessionUsageFailed, setSessionUsageFailed] = useState<string | null>(null);
  const visibleUsage =
    sessionUsage && sessionUsage.sessionId === detail.sessionId ? sessionUsage.summary : null;
  useEffect(() => {
    let cancelled = false;
    setSessionUsageFailed(null);
    void (async () => {
      try {
        if (!detail.sessionId || !window.codeshell.getUsageSummary) return;
        const summary = await window.codeshell.getUsageSummary({
          scope: "session",
          sessionId: detail.sessionId,
          includeChildren: true,
        });
        if (!cancelled) setSessionUsage({ sessionId: detail.sessionId, summary });
      } catch {
        if (!cancelled) setSessionUsageFailed(detail.sessionId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail]);
  const tools = useMemo(() => buildToolTraces(detail.events), [detail.events]);
  const events = useMemo(() => keyRunEvents(detail.events), [detail.events]);
  const metadata = [
    { label: t("auto.runs.runId"), value: detail.runId, copyable: true },
    { label: t("activityRuns.createdAt"), value: formatRunTime(detail.createdAt, lang) },
    { label: t("auto.runs.updatedAt"), value: formatRunTime(detail.updatedAt, lang) },
    ...(detail.startedAt !== null
      ? [{ label: t("activityRuns.startedAt"), value: formatRunTime(detail.startedAt, lang) }]
      : []),
    ...(detail.finishedAt !== null
      ? [{ label: t("activityRuns.finishedAt"), value: formatRunTime(detail.finishedAt, lang) }]
      : []),
    { label: t("auto.runs.cwd"), value: detail.cwd, copyable: true },
    ...(detail.preset ? [{ label: t("auto.runs.preset"), value: detail.preset }] : []),
    ...(detail.sessionId
      ? [{ label: t("auto.runs.sessionId"), value: detail.sessionId, copyable: true }]
      : []),
    ...(detail.source ? [{ label: t("activityRuns.source"), value: detail.source }] : []),
    ...(detail.cronJobName
      ? [{ label: t("activityRuns.automation"), value: detail.cronJobName }]
      : []),
    ...(detail.model ? [{ label: t("auto.runs.model"), value: detail.model }] : []),
    ...(detail.provider ? [{ label: t("auto.runs.provider"), value: detail.provider }] : []),
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
        {metadata.map(({ label, value, copyable }) => (
          <div key={label} className="min-w-0">
            <dt className="mb-1 text-[11px] text-muted-foreground">{label}</dt>
            <dd className="flex items-start gap-1 text-xs leading-5 text-foreground">
              <span className="min-w-0 flex-1 break-all">{value || "—"}</span>
              {copyable && value && <CopyValue value={value} label={label} />}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid min-w-0 grid-cols-2 gap-2 @min-[520px]/run-detail:grid-cols-4">
        <TraceMetric
          icon={<Clock3 size={15} aria-hidden />}
          label={t("auto.runs.duration")}
          value={formatRunDuration(detail.durationMs)}
        />
        <TraceMetric
          icon={<Coins size={15} aria-hidden />}
          label={t("auto.runs.totalTokens")}
          value={detail.usage ? detail.usage.totalTokens.toLocaleString() : "—"}
        />
        <TraceMetric
          icon={<Coins size={15} aria-hidden />}
          label={t("auto.runs.inputOutputTokens")}
          value={
            detail.usage
              ? `${detail.usage.promptTokens.toLocaleString()} / ${detail.usage.completionTokens.toLocaleString()}`
              : "—"
          }
        />
        <TraceMetric
          icon={<Wrench size={15} aria-hidden />}
          label={t("auto.runs.toolCalls")}
          value={String(tools.length)}
        />
      </div>
      {visibleUsage && (
        <UsageSummaryView summary={visibleUsage} title={t("auto.runs.sessionUsage")} />
      )}
      {sessionUsageFailed && sessionUsageFailed === detail.sessionId && (
        <p role="status" className="text-xs text-status-warn">
          {t(visibleUsage ? "activityRuns.usageRefreshFailed" : "auto.runs.usageUnavailable")}
        </p>
      )}
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
      <Section title={t("auto.runs.prompt")}>
        {detail.prompt ? (
          <TracePayload value={detail.prompt} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("auto.runs.promptUnavailable")}</p>
        )}
      </Section>
      <Section title={t("auto.runs.tools")} count={tools.length}>
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("auto.runs.noToolCalls")}</p>
        ) : (
          <ol className="space-y-2">
            {tools.map(({ key, call: event, result }) => {
              return (
                <li key={key} className="min-w-0 rounded-xl border border-border/70">
                  <TraceDisclosure
                    title={
                      <span className="font-medium">
                        {String(event.data.toolName ?? t("auto.runs.unknownTool"))}
                      </span>
                    }
                    aside={
                      result?.data.error
                        ? t("auto.runs.toolError")
                        : result
                          ? t("auto.runs.toolDone")
                          : t("auto.runs.toolNoResult")
                    }
                  >
                    <TraceField label={t("auto.runs.toolInput")} value={event.data.args ?? {}} />
                    {result && (
                      <TraceField
                        label={
                          result.data.error ? t("auto.runs.toolError") : t("auto.runs.toolOutput")
                        }
                        value={
                          result.data.error ??
                          result.data.result ??
                          result.data.contentBlocks ??
                          null
                        }
                      />
                    )}
                  </TraceDisclosure>
                </li>
              );
            })}
          </ol>
        )}
      </Section>
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
                    {formatRunTime(checkpoint.createdAt, lang)}
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
          <>
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              {t("activityRuns.artifactsHint")}
            </p>
            <ul className="space-y-2">
              {detail.artifacts.map((artifact, index) => (
                <li
                  key={`${artifact}:${index}`}
                  className="flex min-w-0 items-start gap-2 rounded-lg bg-muted/40 px-3 py-2"
                >
                  <code className="min-w-0 flex-1 break-all text-xs leading-5">{artifact}</code>
                  <CopyValue value={artifact} label={t("activityRuns.artifact")} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
      <Section title={t("auto.runs.events")} count={detail.events.length}>
        {detail.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("auto.runs.none")}</p>
        ) : (
          <ol className="space-y-2">
            {events.map(({ event, key }) => (
              <li key={key} className="min-w-0 rounded-xl border border-border/70">
                <TraceDisclosure
                  title={<span title={event.type}>{eventDetailTitle(event, t)}</span>}
                  aside={formatRunTime(event.timestamp, lang)}
                >
                  <TracePayload value={event.data} />
                </TraceDisclosure>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}

function TraceMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-card px-3 py-2.5">
      <span className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </span>
      <strong className="block truncate text-sm font-semibold tabular-nums" title={value}>
        {value}
      </strong>
    </div>
  );
}

function TraceField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">{label}</h4>
      <TracePayload value={value} />
    </div>
  );
}
