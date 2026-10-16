import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelTraceAttempt,
  ModelTraceEvent,
  ModelTracePage,
  ModelTraceRecord,
  ModelTraceSummary,
  RemoteModelTraceApi,
} from "../model-trace-api.js";

const labels = {
  zh: {
    title: "执行观测",
    description: "查看当前工作区实际记录的 Prompt、响应、重试和工具事件。",
    refresh: "刷新",
    search: "搜索模型、用途、来源或编号",
    session: "会话 ID",
    model: "模型",
    purpose: "用途",
    filters: "筛选调用",
    all: "全部状态",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    empty: "没有符合条件的模型调用",
    select: "选择执行，展开模型调用和工具事件",
    calls: "调用与事件",
    back: "返回",
    next: "下一页",
    previous: "上一页",
    more: "加载更多调用",
    loading: "读取中…",
    input: "输入",
    output: "输出",
    attempts: "重试与请求",
    events: "工具与生命周期",
    attempt: "尝试",
    wire: "最终 Provider 请求",
    logical: "逻辑输入",
    external: "外部 CLI 入口输入，未覆盖 CLI 内部的模型请求",
    missing: "这条调用已过期或不再可用",
    unrecorded: "正文未采集",
    truncated: "正文已截断",
    redacted: "正文已脱敏",
    contentHint: "仅记录元数据。请在 Host 的执行观测设置中开启 Prompt 正文采集；历史内容不会补回。",
    disabled: "Host 已关闭调用记录",
    copy: "复制 JSON",
    copied: "已复制",
    copyFailed: "复制失败，请重试",
    open: "打开原会话",
    cost: "费用未记录",
    costEstimate: "估算费用",
    costPartial: "部分尝试费用未知",
    tokens: "Token",
    duration: "耗时",
    ttft: "首 Token",
    request: "模型调用",
  },
  en: {
    title: "Execution traces",
    description: "Inspect recorded prompts, responses, retries and tools in this workspace.",
    refresh: "Refresh",
    search: "Search model, purpose, source or ID",
    session: "Session ID",
    model: "Model",
    purpose: "Purpose",
    filters: "Filter calls",
    all: "All statuses",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    empty: "No matching model calls",
    select: "Select an execution to inspect its calls and events",
    calls: "Calls and events",
    back: "Back",
    next: "Next page",
    previous: "Previous page",
    more: "Load more calls",
    loading: "Loading…",
    input: "Input",
    output: "Output",
    attempts: "Attempts and requests",
    events: "Tools and lifecycle",
    attempt: "Attempt",
    wire: "Final Provider request",
    logical: "Logical input",
    external: "External CLI entry input; internal model requests are not covered",
    missing: "This call has expired or is unavailable",
    unrecorded: "Content was not recorded",
    truncated: "Content was truncated",
    redacted: "Content was redacted",
    contentHint:
      "Only metadata is recorded. Enable Prompt content recording in the Host’s execution trace settings. Earlier content cannot be recovered.",
    disabled: "The Host disabled call recording",
    copy: "Copy JSON",
    copied: "Copied",
    copyFailed: "Copy failed. Please retry",
    open: "Open conversation",
    cost: "Cost not recorded",
    costEstimate: "Estimated cost",
    costPartial: "Some attempt costs are unknown",
    tokens: "Tokens",
    duration: "Duration",
    ttft: "First token",
    request: "Model call",
  },
} as const;

const css = `
.cs-trace-explorer{display:flex;flex-direction:column;min-height:0;min-width:0;flex:1;height:auto;color:inherit;font:inherit;background:inherit;overflow:hidden}
.cs-trace-explorer *{box-sizing:border-box}.cs-trace-explorer header{padding:16px 20px 12px;border-bottom:1px solid #8884;flex-shrink:0}
.cs-trace-explorer h1{font-size:20px;margin:0}.cs-trace-explorer h2{font-size:14px;margin:0 0 12px}.cs-trace-explorer h3{font-size:13px;margin:12px 0 6px}
.cs-trace-explorer p{font-size:13px;line-height:1.6;margin:8px 0;overflow-wrap:anywhere}.cs-trace-explorer button,.cs-trace-explorer input,.cs-trace-explorer select{font:inherit;color:inherit;border:1px solid #8885;border-radius:7px;background:transparent;padding:7px 9px;min-width:0}
.cs-trace-explorer button{cursor:pointer}.cs-trace-explorer button:hover{background:#8882}.cs-trace-explorer button:disabled{opacity:.5;cursor:default}.cs-trace-explorer button:focus-visible{outline:2px solid #4c91ee;outline-offset:2px}
.cs-trace-explorer button[aria-pressed=true]{background:#4c91ee22;border-color:#4c91ee}.cs-trace-explorer .cs-t-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cs-trace-explorer .cs-t-filters{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:12px}.cs-trace-explorer .cs-t-filters label{font-size:12px;display:flex;flex-direction:column;gap:4px;min-width:0}
.cs-trace-explorer .cs-t-search{display:flex;gap:6px;flex-direction:column;margin-top:10px;font-size:12px}.cs-trace-explorer .cs-t-filter-fold{margin:8px 0 0}.cs-trace-explorer .cs-t-grid{min-height:0;flex:1;display:grid;grid-template-columns:minmax(180px,1fr) minmax(190px,1fr) minmax(300px,2fr)}
.cs-trace-explorer .cs-t-pane{overflow:auto;min-width:0;padding:16px;border-right:1px solid #8884}.cs-trace-explorer .cs-t-item{display:block;width:100%;text-align:left;margin-bottom:8px;overflow-wrap:anywhere;word-break:break-word;font-size:12px}
.cs-trace-explorer .cs-t-item strong{display:block;font-size:13px;margin-bottom:5px}.cs-trace-explorer .cs-t-muted{opacity:.7;font-size:12px}.cs-trace-explorer .cs-t-error{color:#c95252;white-space:pre-wrap}
.cs-trace-explorer pre{font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:65vh;overflow:auto;padding:12px;border:1px solid #8884;border-radius:8px;background:#8881}
.cs-trace-explorer details{margin:12px 0}.cs-trace-explorer summary{cursor:pointer;font-size:13px}.cs-trace-explorer .cs-t-back{display:none}.cs-trace-explorer dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;margin:12px 0}.cs-trace-explorer dd{margin:0;overflow-wrap:anywhere}.cs-trace-explorer footer{display:flex;gap:8px;align-items:center;justify-content:space-between;padding-top:12px}
@media(max-width:1000px){.cs-trace-explorer .cs-t-filters{grid-template-columns:1fr 1fr}.cs-trace-explorer .cs-t-grid{display:flex}.cs-trace-explorer .cs-t-pane{width:100%;border:0;display:none}.cs-trace-explorer .cs-t-pane[data-active=true]{display:block}.cs-trace-explorer .cs-t-back{display:inline-block;margin-bottom:12px}.cs-trace-explorer header{padding:10px;max-height:50%;overflow:auto}.cs-trace-explorer header>p{display:none}.cs-trace-explorer pre{max-height:none}}
`;

type Detail = { record: ModelTraceRecord; events: ModelTraceEvent[] };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ms = (start?: number, end?: number) =>
  start !== undefined && end !== undefined
    ? `${Math.max(0, end - start).toLocaleString()} ms`
    : "—";

/** Browser-only, read-only explorer shared by the Web workbench and paired mobile client. */
export function ModelTraceExplorer({
  api,
  lang = "zh",
  initialSessionId,
  onOpenSession,
}: {
  api: RemoteModelTraceApi;
  lang?: "zh" | "en";
  initialSessionId?: string;
  onOpenSession?: (id: string) => void;
}) {
  const l = labels[lang];
  const [search, setSearch] = useState("");
  const [model, setModel] = useState("");
  const [purpose, setPurpose] = useState("");
  const [sessionId, setSessionId] = useState(initialSessionId ?? "");
  const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<ModelTracePage>();
  const [traceId, setTraceId] = useState<string>();
  const [tracePage, setTracePage] = useState<ModelTracePage & { traceId: string }>();
  const [traceError, setTraceError] = useState("");
  const [requestId, setRequestId] = useState<string>();
  const [detail, setDetail] = useState<Detail | null>();
  const [node, setNode] = useState<{ kind: "request" | "attempt" | "event"; id?: string }>({
    kind: "request",
  });
  const [stage, setStage] = useState<"list" | "tree" | "detail">("list");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [configHint, setConfigHint] = useState("");
  const [copied, setCopied] = useState("");
  const traceGeneration = useRef(0);
  const [moreLoading, setMoreLoading] = useState(false);
  const filterKey = `${search}\u0000${model}\u0000${purpose}\u0000${sessionId}\u0000${status}`;
  useEffect(() => {
    setCursors([undefined]);
    setPageIndex(0);
  }, [filterKey]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void api
        .list({
          limit: 50,
          cursor: cursors[pageIndex],
          search,
          model,
          purpose,
          sessionId,
          status: status ? (status as ModelTraceRecord["status"]) : undefined,
        })
        .then((result) => {
          if (alive) setPage(result);
        })
        .catch((cause) => {
          if (alive) setError(errorText(cause));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, filterKey, cursors, pageIndex, revision]);
  useEffect(() => {
    let alive = true;
    void api
      .getConfig()
      .then((config) => {
        if (alive)
          setConfigHint(!config.enabled ? l.disabled : !config.captureContent ? l.contentHint : "");
      })
      .catch((cause) => {
        if (alive) setConfigHint(errorText(cause));
      });
    return () => {
      alive = false;
    };
  }, [api, revision, l]);
  useEffect(() => {
    const generation = ++traceGeneration.current;
    if (!traceId) return;
    setMoreLoading(false);
    setTraceError("");
    setTracePage((current) => (current?.traceId === traceId ? current : undefined));
    void api
      .list({ traceId, limit: 200 })
      .then((result) => {
        if (generation === traceGeneration.current) setTracePage({ ...result, traceId });
      })
      .catch((cause) => {
        if (generation === traceGeneration.current) setTraceError(errorText(cause));
      });
    return () => {
      traceGeneration.current++;
    };
  }, [api, traceId, revision]);
  useEffect(() => {
    let alive = true;
    if (!requestId) return;
    setDetailLoading(true);
    setDetailError("");
    setDetail((current) => (current?.record.id === requestId ? current : undefined));
    void api
      .get(requestId)
      .then((result) => {
        if (alive) setDetail(result);
      })
      .catch((cause) => {
        if (alive) setDetailError(errorText(cause));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, requestId, revision]);
  const groups = useMemo(() => {
    const result = new Map<string, ModelTraceSummary[]>();
    for (const item of page?.items ?? [])
      result.set(item.traceId, [...(result.get(item.traceId) ?? []), item]);
    return [...result];
  }, [page]);
  const visibleDetail =
    detail && detail.record.id === requestId && detail.record.traceId === traceId
      ? detail
      : undefined;
  const record = visibleDetail?.record;
  const selected: ModelTraceRecord | ModelTraceAttempt | ModelTraceEvent | undefined =
    node.kind === "attempt"
      ? record?.attempts.find((attempt) => attempt.id === node.id)
      : node.kind === "event"
        ? visibleDetail?.events.find((event) => event.id === node.id)
        : record;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
      setCopied(l.copied);
    } catch {
      setCopied(l.copyFailed);
    }
  };
  const selectRequest = (id: string) => {
    setRequestId(id);
    setNode({ kind: "request" });
    setStage("detail");
    setCopied("");
  };
  const more = async () => {
    if (!tracePage?.nextCursor || moreLoading || !traceId) return;
    const generation = traceGeneration.current;
    setMoreLoading(true);
    try {
      const result = await api.list({ traceId, cursor: tracePage.nextCursor, limit: 200 });
      if (generation === traceGeneration.current)
        setTracePage((current) => ({
          ...result,
          traceId,
          items: [...(current?.items ?? []), ...result.items],
        }));
    } catch (cause) {
      if (generation === traceGeneration.current) setTraceError(errorText(cause));
    } finally {
      if (generation === traceGeneration.current) setMoreLoading(false);
    }
  };
  const content = (value: unknown, state: string) => (
    <>
      {state !== "recorded" && (
        <p className="cs-t-muted">
          {state === "not-recorded"
            ? l.unrecorded
            : state === "truncated"
              ? l.truncated
              : l.redacted}
        </p>
      )}
      {value !== undefined && (
        <pre tabIndex={0}>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
      )}
    </>
  );
  return (
    <section className="cs-trace-explorer" aria-label={l.title}>
      <style>{css}</style>
      <header>
        <div className="cs-t-row">
          <h1>{l.title}</h1>
          <button
            type="button"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            {l.refresh}
          </button>
        </div>
        <p className="cs-t-muted">{l.description}</p>
        <label className="cs-t-search">
          <span className="cs-t-muted">{l.search}</span>
          <input
            aria-label={l.search}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <details className="cs-t-filter-fold">
          <summary>{l.filters}</summary>
          <div className="cs-t-filters">
            <label>
              {l.session}
              <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
            </label>
            <label>
              {l.model}
              <input value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label>
              {l.purpose}
              <input value={purpose} onChange={(event) => setPurpose(event.target.value)} />
            </label>
            <label>
              {l.all}
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">{l.all}</option>
                {(["running", "completed", "failed", "cancelled"] as const).map((value) => (
                  <option key={value} value={value}>
                    {l[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        {configHint && (
          <p role="status" className="cs-t-muted">
            {configHint}
          </p>
        )}
        {error && (
          <p role="alert" className="cs-t-error">
            {error}
          </p>
        )}
      </header>
      <div className="cs-t-grid">
        <div className="cs-t-pane" data-active={stage === "list"} aria-label={l.title}>
          <h2>
            {page?.total ?? "—"} {l.request} · {groups.length} traces
          </h2>
          {loading && <p role="status">{l.loading}</p>}
          {!loading && !groups.length && <p>{l.empty}</p>}
          {groups.map(([id, items]) => (
            <button
              type="button"
              className="cs-t-item"
              key={id}
              aria-pressed={traceId === id}
              onClick={() => {
                if (traceId === id) {
                  setStage("tree");
                  return;
                }
                traceGeneration.current++;
                setMoreLoading(false);
                setTracePage(undefined);
                setTraceError("");
                setDetail(undefined);
                setDetailError("");
                setCopied("");
                setTraceId(id);
                setRequestId(items[0].id);
                setNode({ kind: "request" });
                setStage("tree");
              }}
            >
              <strong>
                {items[0].purpose} · {items[0].model}
              </strong>
              <span>{id}</span>
              <p className="cs-t-muted">
                {new Date(items[0].startedAt).toLocaleString(lang)} · {items.length} {l.request}
              </p>
            </button>
          ))}
          <footer>
            <button
              type="button"
              disabled={pageIndex === 0 || loading}
              onClick={() => setPageIndex((value) => value - 1)}
            >
              {l.previous}
            </button>
            <span>{pageIndex + 1}</span>
            <button
              type="button"
              disabled={!page?.nextCursor || loading}
              onClick={() => {
                setCursors((current) => [...current.slice(0, pageIndex + 1), page?.nextCursor]);
                setPageIndex((value) => value + 1);
              }}
            >
              {l.next}
            </button>
          </footer>
        </div>
        <div className="cs-t-pane" data-active={stage === "tree"} aria-label={l.calls}>
          <button type="button" className="cs-t-back" onClick={() => setStage("list")}>
            {l.back}
          </button>
          <h2>{l.calls}</h2>
          {!traceId ? (
            <p>{l.select}</p>
          ) : (
            <>
              {traceError && (
                <div role="alert">
                  <p className="cs-t-error">{traceError}</p>
                  <button type="button" onClick={() => setRevision((value) => value + 1)}>
                    {l.refresh}
                  </button>
                </div>
              )}
              {!tracePage && !traceError && <p role="status">{l.loading}</p>}
              {tracePage?.items.map((call) => (
                <div key={call.id}>
                  <button
                    type="button"
                    className="cs-t-item"
                    aria-pressed={requestId === call.id && node.kind === "request"}
                    onClick={() => selectRequest(call.id)}
                  >
                    <strong>
                      {call.model} · {call.purpose}
                    </strong>
                    {call.source} · {call.status} · {ms(call.startedAt, call.endedAt)}
                  </button>
                  {record?.id === call.id &&
                    record.attempts.map((attempt) => (
                      <button
                        type="button"
                        key={attempt.id}
                        className="cs-t-item"
                        aria-pressed={node.kind === "attempt" && node.id === attempt.id}
                        onClick={() => {
                          setNode({ kind: "attempt", id: attempt.id });
                          setStage("detail");
                        }}
                      >
                        {l.attempt} {attempt.number} · {attempt.httpStatus ?? "—"} ·{" "}
                        {attempt.status}
                      </button>
                    ))}
                </div>
              ))}
              {tracePage?.nextCursor && (
                <button type="button" disabled={moreLoading} onClick={() => void more()}>
                  {l.more}
                </button>
              )}
              <h3>{l.events}</h3>
              {visibleDetail?.events
                .filter((event) => event.traceId === traceId)
                .map((event) => (
                  <button
                    type="button"
                    className="cs-t-item"
                    key={event.id}
                    aria-pressed={node.kind === "event" && node.id === event.id}
                    onClick={() => {
                      setNode({ kind: "event", id: event.id });
                      setStage("detail");
                    }}
                  >
                    {event.kind} · {event.name} · {event.status}
                  </button>
                ))}
            </>
          )}
        </div>
        <div className="cs-t-pane" data-active={stage === "detail"} aria-label={l.request}>
          <button type="button" className="cs-t-back" onClick={() => setStage("tree")}>
            {l.back}
          </button>
          {detailError && (
            <p role="alert" className="cs-t-error">
              {detailError}
            </p>
          )}
          {detailLoading && <p role="status">{l.loading}</p>}
          {detail === null && <p>{l.missing}</p>}
          {selected ? (
            <>
              <div className="cs-t-row">
                <h2>
                  {node.kind === "event" ? (selected as ModelTraceEvent).name : record?.model}
                </h2>
                <button type="button" onClick={() => void copy()}>
                  {l.copy}
                </button>
                {record?.sessionId && onOpenSession && (
                  <button type="button" onClick={() => onOpenSession(record.sessionId!)}>
                    {l.open}
                  </button>
                )}
              </div>
              {copied && <p role="status">{copied}</p>}
              <dl>
                <dt>ID</dt>
                <dd>{selected.id}</dd>
                <dt>{l.duration}</dt>
                <dd>{ms(selected.startedAt, selected.endedAt)}</dd>
                <dt>{l.ttft}</dt>
                <dd>
                  {"firstTokenAt" in selected ? ms(selected.startedAt, selected.firstTokenAt) : "—"}
                </dd>
                <dt>{l.tokens}</dt>
                <dd>
                  {"usage" in selected && selected.usage
                    ? `${selected.usage.promptTokens} / ${selected.usage.completionTokens}`
                    : "—"}
                </dd>
              </dl>
              <p className="cs-t-muted">
                {"estimatedCostUsd" in selected && typeof selected.estimatedCostUsd === "number"
                  ? `${l.costEstimate}: $${selected.estimatedCostUsd.toFixed(6)}${"unknownCostAttempts" in selected && selected.unknownCostAttempts ? ` · ${l.costPartial}` : ""}`
                  : l.cost}
              </p>
              {"coverage" in selected && (
                <p className="cs-t-muted">
                  {selected.coverage === "provider-wire"
                    ? l.wire
                    : selected.coverage === "logical-input"
                      ? l.logical
                      : l.external}
                </p>
              )}
              {selected.error && <p className="cs-t-error">{selected.error}</p>}
              <details open key={`${selected.id}:input`}>
                <summary>{l.input}</summary>
                {content(selected.input, selected.inputState)}
              </details>
              <details open key={`${selected.id}:output`}>
                <summary>{l.output}</summary>
                {content(selected.output, selected.outputState)}
              </details>
              {node.kind === "request" && record && (
                <details>
                  <summary>
                    {l.attempts} ({record.attempts.length})
                  </summary>
                  {record.attempts.map((attempt) => (
                    <button
                      type="button"
                      className="cs-t-item"
                      key={attempt.id}
                      onClick={() => setNode({ kind: "attempt", id: attempt.id })}
                    >
                      {l.attempt} {attempt.number} · {attempt.status} ·{" "}
                      {ms(attempt.startedAt, attempt.endedAt)}
                    </button>
                  ))}
                </details>
              )}
            </>
          ) : (
            !detailLoading && <p>{l.select}</p>
          )}
        </div>
      </div>
    </section>
  );
}
