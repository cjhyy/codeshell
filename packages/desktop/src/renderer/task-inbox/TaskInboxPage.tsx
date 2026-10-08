import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Inbox, Loader2, RefreshCw } from "lucide-react";
import type {
  TaskInboxRecordV1,
  TaskInboxListResult,
  TaskInboxAction,
  TaskSource,
  TaskStatus,
} from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "../i18n/I18nProvider";
import { useOptionalConfirm } from "../ui/DialogProvider";
import {
  TASK_INBOX_GROUPS,
  groupTaskInboxRecords,
  taskInboxProject,
  type TaskInboxFilters,
  type TaskInboxGroup,
} from "./taskInboxViewModel";

const SubagentSessionDetail = React.lazy(() =>
  import("../subagents/SubagentSessionDetail").then((module) => ({
    default: module.SubagentSessionDetail,
  })),
);

const SOURCES: TaskSource[] = [
  "session",
  "legacy-run",
  "automation",
  "mimi-delegation",
  "subagent",
  "background-shell",
  "background-job",
  "external-runtime",
];
const STATUSES: TaskStatus[] = [
  "queued",
  "running",
  "waiting",
  "paused",
  "done",
  "failed",
  "cancelled",
  "interrupted",
];
const EMPTY_FILTERS: TaskInboxFilters = { source: "", status: "", project: "", search: "" };
const PAGE_SIZE = 50;
function formatTaskTime(timestamp: number, lang: string): { iso?: string; label: string } {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return { label: "—" };
  return { iso: date.toISOString(), label: date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US") };
}
const initialCounts = (): Record<TaskInboxGroup, number> => ({
  waiting: PAGE_SIZE,
  running: PAGE_SIZE,
  failed: PAGE_SIZE,
  done: PAGE_SIZE,
});

export interface TaskInboxPageProps {
  onOpenTaskInboxRecord?: (record: TaskInboxRecordV1) => void | Promise<void>;
}

export function TaskInboxPage({ onOpenTaskInboxRecord }: TaskInboxPageProps = {}) {
  const { t, lang } = useT();
  const confirm = useOptionalConfirm();
  const id = useId();
  const [selectedSubagent, setSelectedSubagent] = useState<TaskInboxRecordV1 | null>(null);
  const [snapshot, setSnapshot] = useState<TaskInboxListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [visibleCounts, setVisibleCounts] = useState(initialCounts);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(new Set<string>());
  const currentVersionRef = useRef(-1);
  const notifiedVersionRef = useRef(-1);
  // Notifications queue behind the immutable paginated snapshot being read.
  // Cancelling that read on every source update could prevent the first render.
  const loadInFlightRef = useRef(true);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(
    () =>
      window.codeshell.taskInbox.onChanged((version) => {
        if (version > Math.max(currentVersionRef.current, notifiedVersionRef.current)) {
          notifiedVersionRef.current = version;
          if (!loadInFlightRef.current) {
            loadInFlightRef.current = true;
            refresh();
          }
        }
      }),
    [refresh],
  );

  useEffect(() => {
    let cancelled = false;
    let published = false;
    loadInFlightRef.current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // Read all bounded pages once, then filter locally without losing options
        // from other pages. An explicit refresh invalidates the request generation.
        const records = new Map<string, TaskInboxRecordV1>();
        let first: TaskInboxListResult | null = null;
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await window.codeshell.taskInbox.list({
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          if (cancelled) return;
          if (!first) first = page;
          if (page.version !== first.version) {
            // Mixed versions violate the immutable pagination contract. Start
            // a new snapshot rather than displaying inconsistent pages.
            refresh();
            return;
          }
          for (const record of page.records) records.set(record.taskKey, record);
          cursor = page.nextCursor;
          if (cursor) {
            if (cursors.has(cursor)) throw new Error("Task pagination did not advance");
            cursors.add(cursor);
          }
        } while (cursor);
        if (!cancelled && first) {
          currentVersionRef.current = first.version;
          setSnapshot({ ...first, records: [...records.values()], nextCursor: undefined });
          published = true;
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          loadInFlightRef.current = false;
          setLoading(false);
          // Publish this complete snapshot before following the newest queued
          // notification. A burst schedules only one subsequent load.
          if (published && notifiedVersionRef.current > currentVersionRef.current) {
            loadInFlightRef.current = true;
            refresh();
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision, refresh]);

  const grouped = useMemo(
    () => groupTaskInboxRecords(snapshot?.records ?? [], filters),
    [snapshot, filters],
  );
  const projects = useMemo(
    () => [...new Set((snapshot?.records ?? []).map(taskInboxProject).filter(Boolean))].sort(),
    [snapshot],
  );
  const filteredCount = TASK_INBOX_GROUPS.reduce(
    (count, group) => count + grouped[group].length,
    0,
  );
  const filter = (key: keyof TaskInboxFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setVisibleCounts(initialCounts());
  };
  const actOnTask = async (record: TaskInboxRecordV1, action: TaskInboxAction) => {
    if (pendingRef.current.has(record.taskKey)) return;
    pendingRef.current.add(record.taskKey);
    setPending(new Set(pendingRef.current));
    setActionError(null);
    try {
      if (
        (action === "cancel" || action === "retry") &&
        !(await confirm({
          message: t(action === "cancel" ? "taskInbox.cancelConfirm" : "taskInbox.retryConfirm", {
            title: record.title,
          }),
          confirmLabel: t("taskInbox.confirm"),
          destructive: true,
        }))
      )
        return;
      const result = await window.codeshell.taskInbox.act({
        taskKey: record.taskKey,
        action,
        expectedRevision: record.sourceRevision,
      });
      if (result.status === "ok") {
        if (action === "open") {
          if (record.source === "subagent") setSelectedSubagent(result.record ?? record);
          else if (onOpenTaskInboxRecord) await onOpenTaskInboxRecord(result.record ?? record);
          else setActionError(t("taskInbox.openUnavailable"));
        }
      } else {
        const fallback =
          result.status === "stale"
            ? t("taskInbox.actionStale")
            : result.status === "unavailable"
              ? t("taskInbox.actionUnavailable")
              : result.status === "rejected"
                ? t("taskInbox.actionRejected")
                : result.status;
        setActionError(t("taskInbox.actionFailed", { message: result.message ?? fallback }));
      }
      refresh();
    } catch (e) {
      setActionError(
        t("taskInbox.actionFailed", { message: e instanceof Error ? e.message : String(e) }),
      );
      refresh();
    } finally {
      pendingRef.current.delete(record.taskKey);
      setPending(new Set(pendingRef.current));
    }
  };

  if (selectedSubagent)
    return (
      <React.Suspense fallback={<p role="status">{t("taskInbox.loading")}</p>}>
        <SubagentSessionDetail
          agentId={selectedSubagent.sessionId ?? selectedSubagent.sourceId}
          parentSessionId={selectedSubagent.parentSessionId}
          label={selectedSubagent.title}
          running={selectedSubagent.status === "running"}
          onBack={() => setSelectedSubagent(null)}
        />
      </React.Suspense>
    );

  return (
    <main className="@container/tasks flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-5 @min-[760px]/tasks:px-6">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2.5 text-xl font-semibold tracking-tight">
            {t("taskInbox.title")}
            {snapshot && (
              <span className="rounded-full border border-border/70 px-2.5 py-0.5 text-xs font-normal tabular-nums text-muted-foreground">
                {t("taskInbox.total", { count: filteredCount })}
              </span>
            )}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{t("taskInbox.subtitle")}</p>
        </div>
        <Button
          type="button"
          ref={refreshRef}
          size="sm"
          variant="outline"
          aria-disabled={loading}
          className="gap-2 rounded-xl"
          onClick={() => {
            if (!loading) {
              refreshRef.current?.focus();
              refresh();
            }
          }}
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <RefreshCw size={14} aria-hidden />
          )}
          {t("taskInbox.refresh")}
        </Button>
      </header>
      <div className="grid shrink-0 grid-cols-1 gap-3 px-4 pb-4 @min-[600px]/tasks:grid-cols-2 @min-[1000px]/tasks:grid-cols-4 @min-[760px]/tasks:px-6">
        <label className="space-y-1.5 text-xs text-muted-foreground" htmlFor={`${id}-search`}>
          {t("taskInbox.search")}
          <Input
            id={`${id}-search`}
            value={filters.search}
            onChange={(event) => filter("search", event.target.value)}
            className="h-9 rounded-lg"
          />
        </label>
        <FilterSelect
          id={`${id}-source`}
          label={t("taskInbox.source")}
          all={t("taskInbox.all")}
          value={filters.source}
          onChange={(value) => filter("source", value)}
          options={SOURCES.map((source) => ({
            value: source,
            label: t(`taskInbox.sources.${source}`),
          }))}
        />
        <FilterSelect
          id={`${id}-project`}
          label={t("taskInbox.project")}
          all={t("taskInbox.all")}
          value={filters.project}
          onChange={(value) => filter("project", value)}
          options={projects.map((project) => ({ value: project, label: project }))}
        />
        <FilterSelect
          id={`${id}-status`}
          label={t("taskInbox.status")}
          all={t("taskInbox.all")}
          value={filters.status}
          onChange={(value) => filter("status", value)}
          options={STATUSES.map((status) => ({
            value: status,
            label: t(`taskInbox.statuses.${status}`),
          }))}
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 @min-[760px]/tasks:px-6"
        aria-busy={loading}
      >
        {error && (
          <p
            role="alert"
            className="mb-3 rounded-xl border border-status-err/20 bg-status-err/5 p-3 text-sm text-status-err"
          >
            {t("taskInbox.listFailed", { message: error })}
          </p>
        )}
        {actionError && (
          <p
            role="alert"
            className="mb-3 rounded-xl border border-status-warn/20 bg-status-warn/5 p-3 text-sm"
          >
            {actionError}
          </p>
        )}
        {snapshot?.errors.map((entry) => (
          <p
            role="alert"
            key={entry.source}
            className="mb-3 rounded-xl border border-status-warn/20 bg-status-warn/5 p-3 text-sm"
          >
            {t("taskInbox.partialError", {
              source: t(`taskInbox.sources.${entry.source}`),
              message: entry.message,
            })}
          </p>
        ))}
        {!snapshot && loading ? (
          <p role="status" className="py-10 text-center text-sm text-muted-foreground">
            {t("taskInbox.loading")}
          </p>
        ) : filteredCount === 0 ? (
          <div
            role="status"
            className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground"
          >
            <Inbox size={24} aria-hidden />
            {t(snapshot?.records.length ? "taskInbox.noMatches" : "taskInbox.empty")}
          </div>
        ) : (
          <div className="space-y-5">
            {TASK_INBOX_GROUPS.map(
              (group) =>
                grouped[group].length > 0 && (
                  <section key={group} aria-labelledby={`${id}-${group}`}>
                    <h2 id={`${id}-${group}`} className="mb-2.5 flex gap-2 text-sm font-semibold">
                      {t(`taskInbox.groups.${group}`)}
                      <span className="font-normal tabular-nums text-muted-foreground">
                        {grouped[group].length}
                      </span>
                    </h2>
                    <ul className="grid gap-3 @min-[1000px]/tasks:grid-cols-2">
                      {grouped[group].slice(0, visibleCounts[group]).map((record) => (
                        <li key={record.taskKey}>
                          <article
                            aria-label={record.title}
                            data-task-key={record.taskKey}
                            className="flex h-full min-w-0 flex-col gap-3 rounded-2xl border border-border/70 bg-card/70 p-4"
                          >
                            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                              <h3 className="min-w-0 flex-1 break-words text-sm font-semibold">
                                {record.title}
                              </h3>
                              <span
                                className={`text-xs ${group === "failed" ? "text-status-err" : group === "waiting" ? "text-status-warn" : "text-muted-foreground"}`}
                              >
                                {t(`taskInbox.statuses.${record.status}`)}
                              </span>
                            </div>
                            <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span>{t(`taskInbox.sources.${record.source}`)}</span>
                              {taskInboxProject(record) && (
                                <span
                                  title={record.workspacePath ?? record.projectId}
                                  className="min-w-0 break-all"
                                >
                                  {record.workspacePath ?? record.projectId}
                                </span>
                              )}
                              <time
                                dateTime={formatTaskTime(record.updatedAt, lang).iso}
                                title={t("taskInbox.updated")}
                              >
                                {formatTaskTime(record.updatedAt, lang).label}
                              </time>
                            </div>
                            {record.summary && (
                              <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed">
                                {record.summary}
                              </p>
                            )}
                            {record.error && (
                              <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs text-status-err">
                                {record.error}
                              </p>
                            )}
                            {record.artifacts.length > 0 && (
                              <ul
                                aria-label={t("auto.runs.artifacts")}
                                className="space-y-1 text-xs text-muted-foreground"
                              >
                                {record.artifacts.slice(0, 8).map((artifact, index) => (
                                  <li
                                    key={`${artifact.uri}:${index}`}
                                    className="break-all"
                                    title={artifact.uri}
                                  >
                                    {artifact.label}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {record.stale && (
                              <p role="status" className="text-xs text-status-warn">
                                {t("taskInbox.stale")}
                              </p>
                            )}
                            <div className="mt-auto flex flex-wrap items-center gap-2">
                              {record.capabilities.map((action) => (
                                <Button
                                  type="button"
                                  key={action}
                                  size="sm"
                                  variant={action === "cancel" ? "destructive" : "outline"}
                                  disabled={
                                    pending.has(record.taskKey) ||
                                    (record.stale && action !== "open")
                                  }
                                  aria-label={t("taskInbox.actionLabel", {
                                    action: t(`taskInbox.actions.${action}`),
                                    title: record.title,
                                  })}
                                  onClick={() => void actOnTask(record, action)}
                                >
                                  {t(`taskInbox.actions.${action}`)}
                                </Button>
                              ))}
                              {!record.capabilities.some((action) => action !== "open") && (
                                <span className="text-xs text-muted-foreground">
                                  {t("taskInbox.readonly")}
                                </span>
                              )}
                            </div>
                          </article>
                        </li>
                      ))}
                    </ul>
                    {grouped[group].length > visibleCounts[group] && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-3"
                        onClick={() =>
                          setVisibleCounts((counts) => ({
                            ...counts,
                            [group]: counts[group] + PAGE_SIZE,
                          }))
                        }
                        aria-label={`${t("taskInbox.loadMore")}：${t(`taskInbox.groups.${group}`)}`}
                      >
                        {t("taskInbox.loadMore")}
                      </Button>
                    )}
                  </section>
                ),
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function FilterSelect({
  id,
  label,
  all,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  all: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="flex h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">{all}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
