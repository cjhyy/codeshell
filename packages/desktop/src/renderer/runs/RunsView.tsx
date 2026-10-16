import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { UsageSummary } from "@cjhyy/code-shell-core";
import type { RunSummary, RunDetail } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { UsageSummaryView } from "./UsageSummaryView";
import { RunDetailView } from "./RunDetailView";
import { filterRunHistory } from "./runTrace";
import { formatRunTime, RUN_STATUSES, RunPlaceholder, RunStatus } from "./runPresentation";

const RUNS_PAGE_SIZE = 50;

type DetailState =
  | { kind: "idle" }
  | { kind: "loading"; runId: string }
  | {
      kind: "ready";
      runId: string;
      detail: RunDetail;
      refreshing?: boolean;
      refreshError?: string;
    }
  | { kind: "missing"; runId: string }
  | { kind: "error"; runId: string; message: string };

export function RunsView({ initialRunId }: { initialRunId?: string | null } = {}) {
  const { t, lang } = useT();
  const detailId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const listInFlight = useRef(true);
  const revealDeepLink = useRef(initialRunId ?? null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(initialRunId ?? null);
  const [detail, setDetail] = useState<DetailState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [detailAttempt, setDetailAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listInFlight.current = true;
    setListLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await window.codeshell.listRuns({ includeSessions: true });
        if (!cancelled) setRuns(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          listInFlight.current = false;
          setListLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  useEffect(() => {
    let cancelled = false;
    setUsageFailed(false);
    void (async () => {
      try {
        if (!window.codeshell.getUsageSummary) return;
        const summary = await window.codeshell.getUsageSummary({ scope: "store" });
        if (!cancelled) setUsageSummary(summary);
      } catch {
        if (!cancelled) setUsageFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  // A deep link can target a run outside the default list page.
  useEffect(() => {
    if (initialRunId) {
      revealDeepLink.current = initialRunId;
      setSelected(initialRunId);
      setFilter("all");
      setQuery("");
      setPage(0);
    }
  }, [initialRunId]);

  useEffect(() => {
    if (!selected) {
      setDetail({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setDetail((previous) =>
      previous.kind === "ready" && previous.runId === selected
        ? { ...previous, refreshing: true, refreshError: undefined }
        : { kind: "loading", runId: selected },
    );
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
          setDetail((previous) => {
            const message = e instanceof Error ? e.message : String(e);
            return previous.kind === "ready" && previous.runId === selected
              ? { ...previous, refreshing: false, refreshError: message }
              : { kind: "error", runId: selected, message };
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, revision, detailAttempt]);

  const filtered = useMemo(
    () => filterRunHistory(runs ?? [], filter, query),
    [runs, filter, query],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / RUNS_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRuns = filtered.slice(
    currentPage * RUNS_PAGE_SIZE,
    (currentPage + 1) * RUNS_PAGE_SIZE,
  );
  const hasFilters = filter !== "all" || query.trim().length > 0;
  const selectionFilteredOut =
    hasFilters &&
    runs?.some((run) => run.runId === selected) &&
    !filtered.some((run) => run.runId === selected);
  useEffect(() => {
    if (!runs || !selected || revealDeepLink.current !== selected) return;
    const index = filtered.findIndex((run) => run.runId === selected);
    if (index >= 0) setPage(Math.floor(index / RUNS_PAGE_SIZE));
    revealDeepLink.current = null;
  }, [runs, selected, filtered]);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [currentPage, filter, query]);
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);
  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [selected]);
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, currentPage]);
  const visibleDetail: DetailState =
    selected && (detail.kind === "idle" || detail.runId !== selected)
      ? { kind: "loading", runId: selected }
      : detail;
  const refresh = () => {
    if (listInFlight.current) return;
    listInFlight.current = true;
    refreshRef.current?.focus({ preventScroll: true });
    setRevision((value) => value + 1);
  };
  const retryDetail = () => {
    detailRef.current?.focus({ preventScroll: true });
    setDetailAttempt((value) => value + 1);
  };
  const clearFilters = () => {
    setFilter("all");
    setQuery("");
    setPage(0);
    searchRef.current?.focus({ preventScroll: true });
  };

  return (
    <div
      role="region"
      aria-labelledby={`${detailId}-title`}
      tabIndex={0}
      className="@container/runs flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-5 @min-[760px]/runs:px-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 id={`${detailId}-title`} className="text-xl font-semibold tracking-tight">
              {t("auto.runs.title")}
            </h1>
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
      <div className="mx-4 mb-3 shrink-0 @min-[760px]/runs:mx-6">
        {usageSummary && (
          <UsageSummaryView summary={usageSummary} title={t("auto.runs.hostUsage")} scrollable />
        )}
        {usageFailed && (
          <p role="status" className="text-xs text-status-warn">
            {t(usageSummary ? "activityRuns.usageRefreshFailed" : "auto.runs.usageUnavailable")}
          </p>
        )}
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
      <div className="grid min-h-[32rem] min-w-0 flex-1 grid-rows-[minmax(240px,0.6fr)_minmax(240px,1fr)] gap-4 px-4 pb-4 @min-[760px]/runs:min-h-80 @min-[760px]/runs:grid-cols-[minmax(260px,320px)_minmax(0,1fr)] @min-[760px]/runs:grid-rows-1 @min-[760px]/runs:px-6 @min-[760px]/runs:pb-6">
        <section
          aria-label={t("auto.runs.list")}
          className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/70"
        >
          <div className="shrink-0 space-y-2 border-b border-border/70 px-3 py-2.5">
            <div className="relative min-w-0">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                ref={searchRef}
                type="search"
                aria-label={t("activityRuns.search")}
                placeholder={t("activityRuns.search")}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                className="h-8 rounded-lg pl-8 pr-8 text-xs [&::-webkit-search-cancel-button]:appearance-none"
              />
              {query && (
                <button
                  type="button"
                  aria-label={t("activityRuns.clearSearch")}
                  className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setQuery("");
                    setPage(0);
                    searchRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <X size={12} aria-hidden />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={filter}
                onValueChange={(value) => {
                  setFilter(value);
                  setPage(0);
                }}
              >
                <SelectTrigger
                  ref={filterRef}
                  aria-label={t("auto.runs.filterLabel")}
                  className="h-8 min-w-0 flex-1 rounded-lg text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("auto.runs.filterAll")}</SelectItem>
                  {Object.entries(RUN_STATUSES).map(([status, { label }]) => (
                    <SelectItem key={status} value={status}>
                      {t(label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {runs && (
                <span role="status" className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {filtered.length}
                </span>
              )}
            </div>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={listLoading}>
            {!runs && listLoading ? (
              <RunPlaceholder loading>{t("auto.runs.loading")}</RunPlaceholder>
            ) : !runs && error ? (
              <RunPlaceholder>{t("auto.runs.listUnavailable")}</RunPlaceholder>
            ) : filtered.length === 0 ? (
              <RunPlaceholder>
                <strong className="font-medium text-foreground">
                  {t(hasFilters ? "activityRuns.noMatch" : "auto.runs.emptyTitle")}
                </strong>
                {!hasFilters ? (
                  <p>{t("auto.runs.emptyHint")}</p>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 rounded-lg"
                    onClick={clearFilters}
                  >
                    {t("activityRuns.clearFilters")}
                  </Button>
                )}
              </RunPlaceholder>
            ) : (
              <ul className="space-y-1">
                {visibleRuns.map((run) => (
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
                          title={formatRunTime(run.updatedAt, lang)}
                        >
                          {formatRunTime(run.updatedAt, lang, true)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {pageCount > 1 && (
            <nav
              aria-label={t("auto.runs.list")}
              className="flex shrink-0 items-center justify-between gap-1 border-t border-border/70 p-2"
            >
              <Button
                size="icon"
                className="size-7"
                variant="ghost"
                aria-label={t("activityRuns.previousPage")}
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft size={14} aria-hidden />
              </Button>
              <span
                role="status"
                className="text-center text-[11px] tabular-nums text-muted-foreground"
              >
                {t("activityRuns.page", {
                  page: currentPage + 1,
                  pages: pageCount,
                  count: filtered.length,
                })}
              </span>
              <Button
                size="icon"
                className="size-7"
                variant="ghost"
                aria-label={t("activityRuns.nextPage")}
                disabled={currentPage === pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                <ChevronRight size={14} aria-hidden />
              </Button>
            </nav>
          )}
        </section>
        <div
          ref={detailRef}
          id={detailId}
          role="region"
          aria-label={t("auto.runs.details")}
          aria-busy={
            visibleDetail.kind === "loading" ||
            (visibleDetail.kind === "ready" && !!visibleDetail.refreshing)
          }
          tabIndex={0}
          className="@container/run-detail min-h-0 min-w-0 overflow-y-auto rounded-2xl border border-border/70 bg-card/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {selectionFilteredOut && (
            <p className="border-b border-border/70 bg-muted/30 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {t("activityRuns.selectionHidden")}
            </p>
          )}
          {visibleDetail.kind === "ready" ? (
            <>
              {visibleDetail.refreshing && (
                <p
                  role="status"
                  className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5 text-xs text-muted-foreground"
                >
                  <Loader2
                    size={12}
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                  {t("activityRuns.refreshingDetail")}
                </p>
              )}
              {visibleDetail.refreshError && (
                <div className="flex flex-wrap items-center gap-2 border-b border-status-err/20 bg-status-err/5 px-4 py-2.5">
                  <p role="alert" className="min-w-0 flex-1 break-words text-xs text-status-err">
                    {t("activityRuns.refreshFailed", { message: visibleDetail.refreshError })}
                  </p>
                  <Button size="sm" variant="outline" onClick={retryDetail}>
                    {t("auto.runs.retryDetail")}
                  </Button>
                </div>
              )}
              <RunDetailView
                key={visibleDetail.runId}
                detail={visibleDetail.detail}
                t={t}
                lang={lang}
              />
            </>
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
