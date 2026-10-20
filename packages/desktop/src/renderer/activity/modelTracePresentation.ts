import type { ModelTraceEvent, ModelTraceSummary } from "../../preload/model-trace-api";
import type { TFunction } from "../i18n/I18nProvider";

export function traceStatusLabel(status: string, t: TFunction): string {
  switch (status) {
    case "running":
      return t("observability.running");
    case "completed":
      return t("observability.completed");
    case "failed":
      return t("observability.failed");
    case "cancelled":
      return t("observability.cancelled");
    default:
      return status;
  }
}

export function traceCoverageLabel(coverage: string, t: TFunction): string {
  if (coverage === "provider-wire") return t("observability.wire");
  if (coverage === "external-cli-input") return t("observability.externalInput");
  return t("observability.logical");
}

export function traceDuration(start?: number, end?: number): string {
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end))
    return "—";
  const ms = Math.max(0, end - start);
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function traceTime(value: number | undefined, lang: string): string {
  if (value === undefined || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Date(value).toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
}

export function groupModelTraces(items: readonly ModelTraceSummary[]) {
  const groups = new Map<string, ModelTraceSummary[]>();
  for (const item of items) {
    const group = groups.get(item.traceId) ?? [];
    group.push(item);
    groups.set(item.traceId, group);
  }
  return [...groups].map(([traceId, requests]) => ({
    traceId,
    requests,
    startedAt: Math.min(...requests.map((item) => item.startedAt)),
  }));
}

export function mergeTraceCalls(previous: ModelTraceSummary[], incoming: ModelTraceSummary[]) {
  const calls = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) calls.set(item.id, item);
  return [...calls.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/** Unknown/malformed parent links stay visible; cycles never recurse. */
export function eventIndent(event: ModelTraceEvent, events: readonly ModelTraceEvent[]): number {
  const byId = new Map(events.map((item) => [item.id, item]));
  const seen = new Set([event.id]);
  let parent = event.parentId;
  let depth = 0;
  while (parent && byId.has(parent) && !seen.has(parent) && depth < 4) {
    seen.add(parent);
    depth++;
    parent = byId.get(parent)?.parentId;
  }
  return depth;
}

/** Only explicit parent links associate a tool span with a model call. */
export function eventRequestId(
  event: ModelTraceEvent,
  events: readonly ModelTraceEvent[],
  requestIds: ReadonlySet<string>,
): string | undefined {
  const byId = new Map(events.map((item) => [item.id, item]));
  const seen = new Set([event.id]);
  let parent = event.parentId;
  while (parent && !seen.has(parent)) {
    if (requestIds.has(parent)) return parent;
    seen.add(parent);
    parent = byId.get(parent)?.parentId;
  }
  return undefined;
}
