import type { RunDetail, RunSummary } from "../../preload/types";

type RunEvent = RunDetail["events"][number];

export interface ToolTrace {
  key: string;
  call: RunEvent;
  result?: RunEvent;
}

/** IDs remain stable when the bounded trace window drops older events. */
export function keyRunEvents(events: RunEvent[]): Array<{ key: string; event: RunEvent }> {
  const occurrences = new Map<string, number>();
  return events.map((event) => {
    const occurrence = occurrences.get(event.eventId) ?? 0;
    occurrences.set(event.eventId, occurrence + 1);
    return { key: `${event.eventId}:${occurrence}`, event };
  });
}

/** Match only explicit IDs, in event order, without reusing a result for retries. */
export function buildToolTraces(events: RunEvent[]): ToolTrace[] {
  const traces: ToolTrace[] = [];
  const pending = new Map<string, ToolTrace[]>();
  for (const { key, event } of keyRunEvents(events)) {
    const id = event.data.toolCallId;
    const callId = typeof id === "string" && id.trim() ? id : null;
    if (event.type === "tool_use") {
      const trace: ToolTrace = { key, call: event };
      traces.push(trace);
      if (callId) {
        const queue = pending.get(callId) ?? [];
        queue.push(trace);
        pending.set(callId, queue);
      }
    } else if (event.type === "tool_result" && callId) {
      const queue = pending.get(callId);
      const trace = queue?.shift();
      if (trace) trace.result = event;
      if (queue?.length === 0) pending.delete(callId);
    }
  }
  return traces;
}

export function filterRunHistory(runs: RunSummary[], status: string, query: string): RunSummary[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return runs.filter((run) => {
    if (status !== "all" && run.status !== status) return false;
    if (terms.length === 0) return true;
    const text = [
      run.objective,
      run.summary,
      run.runId,
      run.sessionId,
      run.cwd,
      run.preset,
      run.source,
      run.cronJobName,
    ]
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function formatRunDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}
