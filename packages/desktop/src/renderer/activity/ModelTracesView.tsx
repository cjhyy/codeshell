import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  ModelTraceApi,
  ModelTracePage,
  ModelTraceStatus,
  ModelTraceSummary,
} from "../../preload/model-trace-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { ModelTraceDetail, type TraceSelection } from "./ModelTraceDetail";
import { ModelTraceRecording } from "./ModelTraceRecording";
import { ModelTraceEvents } from "./ModelTraceEvents";
import {
  eventRequestId,
  groupModelTraces,
  mergeTraceCalls,
  traceDuration,
  traceTime,
  traceStatusLabel,
  traceCoverageLabel,
} from "./modelTracePresentation";

type TraceDetail = NonNullable<Awaited<ReturnType<ModelTraceApi["get"]>>>;
type Filters = {
  search: string;
  model: string;
  provider: string;
  purpose: string;
  source: string;
  status: "" | ModelTraceStatus;
  sessionId: string;
  traceId: string;
};
const EMPTY_FILTERS: Filters = {
  search: "",
  model: "",
  provider: "",
  purpose: "",
  source: "",
  status: "",
  sessionId: "",
  traceId: "",
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const queueFocus = (ref: React.RefObject<HTMLHeadingElement | null>) => {
  const focus = () => ref.current?.focus();
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(focus);
  else focus();
};

export interface ModelTracesViewProps {
  initialSessionId?: string | null;
  initialTraceId?: string | null;
  initialRequestId?: string | null;
  onOpenSession?: (id: string) => void | boolean | Promise<void | boolean>;
}

export function ModelTracesView({
  initialSessionId,
  initialTraceId,
  initialRequestId,
  onOpenSession,
}: ModelTracesViewProps = {}) {
  const { t, lang } = useT();
  const id = useId();
  const [filters, setFilters] = useState<Filters>({
    ...EMPTY_FILTERS,
    sessionId: initialSessionId ?? "",
    traceId: initialTraceId ?? "",
  });
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [list, setList] = useState<ModelTracePage | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(initialTraceId ?? null);
  const [selectedRequest, setSelectedRequest] = useState<string | null>(initialRequestId ?? null);
  const [selection, setSelection] = useState<TraceSelection>({ kind: "request" });
  const [step, setStep] = useState<"list" | "tree" | "detail">(
    initialRequestId ? "detail" : initialTraceId ? "tree" : "list",
  );
  const [calls, setCalls] = useState<{
    traceId: string;
    items: ModelTraceSummary[];
    nextCursor?: string;
  }>({ traceId: "", items: [] });
  const [callsLoading, setCallsLoading] = useState(false);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, TraceDetail>>({});
  const [detailRead, setDetailRead] = useState<{
    id: string | null;
    loading: boolean;
    error: string | null;
    missing: boolean;
  }>({ id: null, loading: false, error: null, missing: false });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(initialRequestId ? [initialRequestId] : []),
  );
  const mounted = useRef(false);
  const listVersion = useRef(0);
  const callsVersion = useRef(0);
  const detailVersion = useRef(0);
  const listPending = useRef(true);
  const callsPending = useRef(false);
  const selectedTraceRef = useRef(selectedTrace);
  const selectedRequestRef = useRef(selectedRequest);
  const navigationTarget = useRef({ initialSessionId, initialTraceId, initialRequestId });
  selectedTraceRef.current = selectedTrace;
  selectedRequestRef.current = selectedRequest;
  const searchRef = useRef<HTMLInputElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const treeHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const listBodyRef = useRef<HTMLDivElement>(null);
  const callsBodyRef = useRef<HTMLDivElement>(null);
  const detailBodyRef = useRef<HTMLDivElement>(null);
  const cursor = cursors[cursors.length - 1];
  const query = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(filters)
          .map(([key, value]) => [key, value.trim()])
          .filter(([, value]) => value),
      ),
    [filters],
  );
  const groups = useMemo(() => groupModelTraces(list?.items ?? []), [list]);
  useEffect(() => {
    if (listBodyRef.current) listBodyRef.current.scrollTop = 0;
  }, [cursor, query]);
  useEffect(() => {
    if (callsBodyRef.current) callsBodyRef.current.scrollTop = 0;
  }, [selectedTrace]);
  useEffect(() => {
    if (detailBodyRef.current) detailBodyRef.current.scrollTop = 0;
  }, [selectedRequest, selection.kind, selection.kind === "request" ? null : selection.id]);
  const detail = selectedRequest && !detailRead.missing ? cache[selectedRequest] : undefined;
  const visibleCalls = useMemo(() => {
    const current = calls.traceId === selectedTrace ? calls.items : [];
    return detail?.record.traceId === selectedTrace &&
      !current.some((item) => item.id === detail.record.id)
      ? mergeTraceCalls(current, [
          { ...detail.record, attemptCount: detail.record.attempts.length },
        ])
      : current;
  }, [calls, selectedTrace, detail]);
  const eventGroups = useMemo(() => {
    const events = detail?.record.traceId === selectedTrace ? detail.events : [];
    const requestIds = new Set(visibleCalls.map((call) => call.id));
    const byRequest = new Map<string, typeof events>();
    const unlinked: typeof events = [];
    for (const event of events) {
      const requestId = eventRequestId(event, events, requestIds);
      if (requestId) {
        const group = byRequest.get(requestId) ?? [];
        group.push(event);
        byRequest.set(requestId, group);
      } else unlinked.push(event);
    }
    return { byRequest, unlinked };
  }, [detail, selectedTrace, visibleCalls]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listVersion.current++;
      callsVersion.current++;
      detailVersion.current++;
    };
  }, []);
  useEffect(() => {
    const previous = navigationTarget.current;
    if (
      previous.initialSessionId === initialSessionId &&
      previous.initialTraceId === initialTraceId &&
      previous.initialRequestId === initialRequestId
    )
      return;
    navigationTarget.current = { initialSessionId, initialTraceId, initialRequestId };
    setFilters((current) =>
      current.sessionId === (initialSessionId ?? "") && current.traceId === (initialTraceId ?? "")
        ? current
        : { ...current, sessionId: initialSessionId ?? "", traceId: initialTraceId ?? "" },
    );
    setCursors([undefined]);
    listVersion.current++;
    callsVersion.current++;
    detailVersion.current++;
    setRevision((value) => value + 1);
    setSelectedTrace(initialTraceId ?? null);
    setSelectedRequest(initialRequestId ?? null);
    setSelection({ kind: "request" });
    setStep(initialRequestId ? "detail" : initialTraceId ? "tree" : "list");
    if (initialRequestId) {
      setExpanded((current) => new Set([...current, initialRequestId]));
    }
  }, [initialSessionId, initialTraceId, initialRequestId]);

  useEffect(() => {
    const version = ++listVersion.current;
    listPending.current = true;
    setListLoading(true);
    setListError(null);
    void Promise.resolve()
      .then(() =>
        window.codeshell.modelTraces.list({ ...query, limit: 50, ...(cursor ? { cursor } : {}) }),
      )
      .then((page) => {
        if (!mounted.current || version !== listVersion.current) return;
        setList(page);
        if (!selectedTraceRef.current && !selectedRequestRef.current && page.items[0]) {
          setSelectedTrace(page.items[0].traceId);
          setSelectedRequest(page.items[0].id);
          setExpanded((current) => new Set([...current, page.items[0].id]));
        }
      })
      .catch((error) => {
        if (mounted.current && version === listVersion.current) setListError(errorText(error));
      })
      .finally(() => {
        if (mounted.current && version === listVersion.current) {
          listPending.current = false;
          setListLoading(false);
        }
      });
  }, [query, cursor, revision]);

  useEffect(() => {
    const version = ++callsVersion.current;
    if (!selectedTrace) {
      setCalls({ traceId: "", items: [] });
      setCallsLoading(false);
      callsPending.current = false;
      return;
    }
    callsPending.current = true;
    setCallsLoading(true);
    setCallsError(null);
    setCalls((current) =>
      current.traceId === selectedTrace ? current : { traceId: selectedTrace, items: [] },
    );
    void Promise.resolve()
      .then(() => window.codeshell.modelTraces.list({ traceId: selectedTrace, limit: 100 }))
      .then((page) => {
        if (!mounted.current || version !== callsVersion.current) return;
        setCalls({
          traceId: selectedTrace,
          items: mergeTraceCalls([], page.items),
          nextCursor: page.nextCursor,
        });
        if (!selectedRequestRef.current && page.items[0]) {
          setSelectedRequest(page.items[0].id);
          setExpanded((current) => new Set([...current, page.items[0].id]));
        }
      })
      .catch((error) => {
        if (mounted.current && version === callsVersion.current) setCallsError(errorText(error));
      })
      .finally(() => {
        if (mounted.current && version === callsVersion.current) {
          callsPending.current = false;
          setCallsLoading(false);
        }
      });
  }, [selectedTrace, revision]);

  useEffect(() => {
    const version = ++detailVersion.current;
    if (!selectedRequest) {
      setDetailRead({ id: null, loading: false, error: null, missing: false });
      return;
    }
    setDetailRead({ id: selectedRequest, loading: true, error: null, missing: false });
    void Promise.resolve()
      .then(() => window.codeshell.modelTraces.get(selectedRequest))
      .then((value) => {
        if (!mounted.current || version !== detailVersion.current) return;
        if (!value) {
          setDetailRead({ id: selectedRequest, loading: false, error: null, missing: true });
          setCache((current) => {
            const next = { ...current };
            delete next[selectedRequest];
            return next;
          });
          return;
        }
        setCache((current) => ({ ...current, [selectedRequest]: value }));
        setSelectedTrace(value.record.traceId);
      })
      .catch((error) => {
        if (mounted.current && version === detailVersion.current)
          setDetailRead({
            id: selectedRequest,
            loading: false,
            error: errorText(error),
            missing: false,
          });
      })
      .finally(() => {
        if (mounted.current && version === detailVersion.current)
          setDetailRead((current) => ({ ...current, loading: false }));
      });
  }, [selectedRequest, revision]);

  const loadMoreCalls = async () => {
    if (callsPending.current || !calls.nextCursor || !selectedTrace) return;
    callsPending.current = true;
    setCallsLoading(true);
    setCallsError(null);
    const version = callsVersion.current;
    try {
      const page = await window.codeshell.modelTraces.list({
        traceId: selectedTrace,
        limit: 100,
        cursor: calls.nextCursor,
      });
      if (mounted.current && version === callsVersion.current)
        setCalls((current) => ({
          traceId: selectedTrace,
          items: mergeTraceCalls(current.items, page.items),
          nextCursor: page.nextCursor,
        }));
    } catch (error) {
      if (mounted.current && version === callsVersion.current) setCallsError(errorText(error));
    } finally {
      if (mounted.current && version === callsVersion.current) {
        callsPending.current = false;
        setCallsLoading(false);
      }
    }
  };
  const changeFilter = (key: keyof Filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setCursors([undefined]);
  };
  const refresh = () => {
    if (listPending.current) return;
    listPending.current = true;
    setRevision((value) => value + 1);
  };
  const chooseRequest = (
    requestId: string,
    nextSelection: TraceSelection = { kind: "request" },
  ) => {
    setSelectedRequest(requestId);
    setSelection(nextSelection);
    setExpanded((current) => new Set([...current, requestId]));
    setStep("detail");
    queueFocus(detailHeadingRef);
  };
  const hasFilters = Object.values(filters).some((value) => value.trim());
  const selectClass =
    "h-9 min-w-0 max-w-full rounded-lg border border-border bg-background px-2 text-xs disabled:opacity-50";

  return (
    <section
      data-model-traces-page
      role="region"
      aria-labelledby={`${id}-title`}
      tabIndex={0}
      className="@container/traces flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain bg-muted/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-4 py-5 sm:px-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border bg-card text-primary">
            <Activity size={19} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 id={`${id}-title`} className="text-xl font-semibold">
              {t("observability.title")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t("observability.description")}
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-disabled={listLoading}
          onClick={refresh}
        >
          <RefreshCw size={14} aria-hidden className={listLoading ? "animate-spin" : undefined} />
          {t("observability.refresh")}
        </Button>
      </header>
      <div className="shrink-0 space-y-3 px-4 pb-4 sm:px-6">
        <ModelTraceRecording />
        <div role="search" className="relative">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute left-3 top-3 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            type="search"
            value={filters.search}
            onChange={(event) => changeFilter("search", event.target.value)}
            aria-label={t("observability.search")}
            placeholder={t("observability.search")}
            className="h-9 bg-card pl-9"
          />
        </div>
        <div
          className="grid grid-cols-2 gap-2 @min-[760px]/traces:grid-cols-5"
          aria-label={t("observability.filters")}
        >
          {(["model", "purpose", "source"] as const).map((key) => (
            <label key={key} className="min-w-0 space-y-1 text-[11px] text-muted-foreground">
              <span>{t(`observability.${key}`)}</span>
              <input
                className={`${selectClass} w-full`}
                value={filters[key]}
                onChange={(event) => changeFilter(key, event.target.value)}
              />
            </label>
          ))}
          <label className="min-w-0 space-y-1 text-[11px] text-muted-foreground">
            <span>{t("observability.status")}</span>
            <select
              className={`${selectClass} w-full`}
              value={filters.status}
              onChange={(event) => changeFilter("status", event.target.value)}
            >
              <option value="">{t("observability.all")}</option>
              {(["running", "completed", "failed", "cancelled"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`observability.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <details className="min-w-0 text-xs">
            <summary className="cursor-pointer rounded-lg border border-border/70 bg-card px-3 py-2.5 focus-visible:ring-2 focus-visible:ring-ring">
              {t("observability.moreFilters")}
            </summary>
            <div className="mt-2 space-y-2">
              {(["provider", "sessionId", "traceId"] as const).map((key) => (
                <label
                  key={key}
                  className="block min-w-0 space-y-1 text-[11px] text-muted-foreground"
                >
                  <span>
                    {t(
                      key === "sessionId"
                        ? "observability.session"
                        : key === "traceId"
                          ? "observability.trace"
                          : "observability.provider",
                    )}
                  </span>
                  <input
                    className={`${selectClass} w-full`}
                    value={filters[key]}
                    onChange={(event) => changeFilter(key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </details>
        </div>
        {hasFilters && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setCursors([undefined]);
              searchRef.current?.focus();
            }}
          >
            {t("observability.clearFilters")}
          </Button>
        )}
      </div>
      <div className="grid min-h-[28rem] min-w-0 flex-1 grid-cols-1 gap-3 px-4 pb-4 sm:px-6 @min-[1100px]/traces:grid-cols-[minmax(220px,0.85fr)_minmax(240px,0.95fr)_minmax(0,1.7fr)]">
        <section
          aria-labelledby={`${id}-executions`}
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card @min-[1100px]/traces:flex",
            step === "list" ? "flex" : "hidden",
          )}
        >
          <div className="shrink-0 border-b border-border/70 p-3">
            <h2
              ref={listHeadingRef}
              tabIndex={-1}
              id={`${id}-executions`}
              className="text-sm font-semibold outline-none"
            >
              {t("observability.executions")}
            </h2>
            {list && (
              <p role="status" className="mt-1 text-[11px] text-muted-foreground">
                {t("observability.count", { count: list.total, traces: groups.length })}
              </p>
            )}
            {list && selectedTrace && !groups.some((group) => group.traceId === selectedTrace) && (
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {t("observability.hiddenSelection")}
              </p>
            )}
          </div>
          <div
            ref={listBodyRef}
            className="min-h-40 flex-1 overflow-y-auto overscroll-contain p-2"
            aria-busy={listLoading}
          >
            {listError && (
              <p
                role="alert"
                className="mb-2 break-words rounded-lg bg-status-err/5 p-3 text-xs text-status-err [overflow-wrap:anywhere]"
              >
                {t(list ? "observability.staleList" : "observability.readError", {
                  error: listError,
                })}
              </p>
            )}
            {!list ? (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                {t(listLoading ? "observability.loading" : "observability.unavailable")}
              </p>
            ) : groups.length === 0 ? (
              <div role="status" className="space-y-2 p-4 text-sm">
                <p>{t(hasFilters ? "observability.noMatch" : "observability.empty")}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("observability.emptyHint")}
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {groups.map((group) => (
                  <li key={group.traceId}>
                    <button
                      type="button"
                      data-trace-group={group.traceId}
                      aria-pressed={selectedTrace === group.traceId}
                      className={cn(
                        "w-full min-w-0 rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedTrace === group.traceId
                          ? "border-primary/40 bg-primary/5"
                          : "border-transparent hover:bg-muted/40",
                      )}
                      onClick={() => {
                        setSelectedTrace(group.traceId);
                        setSelectedRequest(group.requests[0].id);
                        setSelection({ kind: "request" });
                        setExpanded((current) => new Set([...current, group.requests[0].id]));
                        setStep("tree");
                        queueFocus(treeHeadingRef);
                      }}
                    >
                      <span className="block break-all font-mono text-xs">{group.traceId}</span>
                      <span className="mt-1 block break-words text-[11px] text-muted-foreground">
                        {group.requests[0].source} · {group.requests[0].purpose} ·{" "}
                        {t("observability.groupCount", { count: group.requests.length })}
                      </span>
                      <span className="mt-1 block text-[10px] text-muted-foreground">
                        {t("observability.pageCallStatuses")}{" "}
                        {[...new Set(group.requests.map((item) => item.status))]
                          .map((status) => traceStatusLabel(status, t))
                          .join(" / ")}
                        {group.requests.every((item) => item.usage) &&
                          ` · ${group.requests.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0).toLocaleString()} Token`}
                      </span>
                      <time className="mt-1 block text-[10px] text-muted-foreground">
                        {traceTime(group.startedAt, lang)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t border-border/70 p-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={listLoading || cursors.length === 1}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              {t("observability.previous")}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {t("observability.page", { page: cursors.length })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={listLoading || !list?.nextCursor}
              onClick={() => setCursors((current) => [...current, list?.nextCursor])}
            >
              {t("observability.next")}
            </Button>
          </div>
        </section>
        <section
          aria-labelledby={`${id}-calls`}
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card @min-[1100px]/traces:flex",
            step === "tree" ? "flex" : "hidden",
          )}
        >
          <div className="shrink-0 border-b border-border/70 p-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mb-2 -ml-2 @min-[1100px]/traces:hidden"
              onClick={() => {
                setStep("list");
                queueFocus(listHeadingRef);
              }}
            >
              <ArrowLeft size={13} aria-hidden />
              {t("observability.backList")}
            </Button>
            <h2
              id={`${id}-calls`}
              ref={treeHeadingRef}
              tabIndex={-1}
              className="text-sm font-semibold outline-none"
            >
              {t("observability.calls")}
            </h2>
            {selectedTrace && (
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                {selectedTrace}
              </p>
            )}
          </div>
          <div
            ref={callsBodyRef}
            className="min-h-40 flex-1 overflow-y-auto overscroll-contain p-2"
            aria-busy={callsLoading}
          >
            {callsError && (
              <p
                role="alert"
                className="mb-2 break-words text-xs text-status-err [overflow-wrap:anywhere]"
              >
                {t("observability.readError", { error: callsError })}
              </p>
            )}
            {!selectedTrace ? (
              <p className="p-3 text-xs text-muted-foreground">{t("observability.selectTrace")}</p>
            ) : (
              <ul className="space-y-2">
                {visibleCalls.map((call) => (
                  <li key={call.id} className="min-w-0">
                    <div className="flex min-w-0 items-start">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mt-1 size-6 shrink-0"
                        aria-label={`${t("observability.attempts", { count: cache[call.id]?.record.attempts.length ?? call.attemptCount })} · ${call.id}`}
                        aria-expanded={expanded.has(call.id)}
                        onClick={() => {
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(call.id)) next.delete(call.id);
                            else next.add(call.id);
                            return next;
                          });
                          if (!cache[call.id]) {
                            setSelectedRequest(call.id);
                            setSelection({ kind: "request" });
                          }
                        }}
                      >
                        {expanded.has(call.id) ? (
                          <ChevronDown size={12} aria-hidden />
                        ) : (
                          <ChevronRight size={12} aria-hidden />
                        )}
                      </Button>
                      <button
                        type="button"
                        data-trace-request={call.id}
                        aria-pressed={selectedRequest === call.id && selection.kind === "request"}
                        className={cn(
                          "min-w-0 flex-1 rounded-lg border px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selectedRequest === call.id && selection.kind === "request"
                            ? "border-primary/40 bg-primary/5"
                            : "border-transparent hover:bg-muted/40",
                        )}
                        onClick={() => chooseRequest(call.id)}
                      >
                        <span className="block break-words text-xs font-medium [overflow-wrap:anywhere]">
                          {call.purpose} · {call.model}
                        </span>
                        <span className="mt-1 block break-words text-[10px] text-muted-foreground">
                          {call.provider} · {traceStatusLabel(call.status, t)} ·{" "}
                          {traceDuration(call.startedAt, call.endedAt)}
                        </span>
                        <span className="mt-1 block break-all font-mono text-[9px] text-muted-foreground">
                          {call.id}
                        </span>
                      </button>
                    </div>
                    {expanded.has(call.id) && cache[call.id] && (
                      <div className="ml-7 border-l border-border/70 pl-2">
                        <ul>
                          {cache[call.id].record.attempts.map((attempt) => (
                            <li key={attempt.id}>
                              <button
                                type="button"
                                data-trace-attempt={attempt.id}
                                aria-pressed={
                                  selectedRequest === call.id &&
                                  selection.kind === "attempt" &&
                                  selection.id === attempt.id
                                }
                                className="w-full rounded-lg px-2 py-2 text-left text-[11px] hover:bg-muted/40 aria-pressed:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() =>
                                  chooseRequest(call.id, { kind: "attempt", id: attempt.id })
                                }
                              >
                                <span className="block">
                                  {t("observability.attempt", { number: attempt.number })} ·{" "}
                                  {traceStatusLabel(attempt.status, t)}
                                </span>
                                <span className="mt-1 block text-[10px] text-muted-foreground">
                                  {traceDuration(attempt.startedAt, attempt.endedAt)} ·{" "}
                                  {traceCoverageLabel(attempt.coverage, t)}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                        {!!eventGroups.byRequest.get(call.id)?.length && (
                          <ModelTraceEvents
                            events={eventGroups.byRequest.get(call.id)!}
                            requestId={call.id}
                            selectedRequest={selectedRequest}
                            selection={selection}
                            onSelect={chooseRequest}
                          />
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {calls.nextCursor && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                disabled={callsLoading}
                onClick={() => void loadMoreCalls()}
              >
                {t("observability.moreCalls")}
              </Button>
            )}
            {detail && (eventGroups.unlinked.length > 0 || detail.events.length === 0) && (
              <div className="mt-4 border-t border-border/70 pt-3">
                <h3 className="px-2 text-[11px] font-medium text-muted-foreground">
                  {t("observability.events")}
                </h3>
                {eventGroups.unlinked.length === 0 ? (
                  <p className="p-2 text-[11px] text-muted-foreground">
                    {t("observability.noEvents")}
                  </p>
                ) : (
                  <ModelTraceEvents
                    events={eventGroups.unlinked}
                    requestId={detail.record.id}
                    selectedRequest={selectedRequest}
                    selection={selection}
                    onSelect={chooseRequest}
                  />
                )}
              </div>
            )}
            {callsLoading && (
              <p
                role="status"
                className="flex items-center gap-2 p-3 text-xs text-muted-foreground"
              >
                <Loader2 size={13} className="animate-spin" aria-hidden />
                {t("observability.loading")}
              </p>
            )}
          </div>
        </section>
        <section
          aria-labelledby={`${id}-detail`}
          className={cn(
            "@container/trace-detail min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card @min-[1100px]/traces:flex",
            step === "detail" ? "flex" : "hidden",
          )}
        >
          <div className="shrink-0 border-b border-border/70 p-3">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mb-2 -ml-2 @min-[1100px]/traces:hidden"
              onClick={() => {
                setStep("tree");
                queueFocus(treeHeadingRef);
              }}
            >
              <ArrowLeft size={13} aria-hidden />
              {t("observability.backTree")}
            </Button>
            <h2
              id={`${id}-detail`}
              ref={detailHeadingRef}
              tabIndex={-1}
              className="text-sm font-semibold outline-none"
            >
              {t("observability.details")}
            </h2>
          </div>
          <div
            ref={detailBodyRef}
            className="min-h-40 flex-1 overflow-y-auto overscroll-contain"
            aria-busy={detailRead.loading}
          >
            {detailRead.error && (
              <div className="p-3">
                <p
                  role="alert"
                  className="break-words text-xs text-status-err [overflow-wrap:anywhere]"
                >
                  {t(detail ? "observability.staleDetail" : "observability.readError", {
                    error: detailRead.error,
                  })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={refresh}
                >
                  {t("observability.retry")}
                </Button>
              </div>
            )}
            {detailRead.missing ? (
              <p role="status" className="p-4 text-xs text-muted-foreground">
                {t("observability.missing")}
              </p>
            ) : detail ? (
              <ModelTraceDetail
                record={detail.record}
                events={detail.events}
                selection={selection}
                onOpenSession={onOpenSession}
              />
            ) : (
              <p role="status" className="p-4 text-xs text-muted-foreground">
                {t(detailRead.loading ? "observability.loading" : "observability.selectRequest")}
              </p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
