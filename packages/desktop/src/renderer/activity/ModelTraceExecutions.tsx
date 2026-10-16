import React, { useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  ModelTraceApi,
  ModelTraceEvent,
  ModelTraceSummary,
} from "../../preload/model-trace-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import type { TraceSelection } from "./ModelTraceDetail";
import { ModelTraceEvents } from "./ModelTraceEvents";
import {
  groupModelTraces,
  traceTime,
  traceDuration,
  traceStatusLabel,
  traceCoverageLabel,
} from "./modelTracePresentation";

type Detail = NonNullable<Awaited<ReturnType<ModelTraceApi["get"]>>>;

export function ModelTraceExecutions({
  items,
  selectedTrace,
  selectedRequest,
  selection,
  expanded,
  cache,
  eventsByRequest,
  scrollReady,
  activeStep,
  onSelect,
  onToggle,
}: {
  items: ModelTraceSummary[];
  selectedTrace: string | null;
  selectedRequest: string | null;
  selection: TraceSelection;
  expanded: ReadonlySet<string>;
  cache: Record<string, Detail>;
  eventsByRequest: Map<string, ModelTraceEvent[]>;
  scrollReady: boolean;
  activeStep: string;
  onSelect: (id: string, selection?: TraceSelection) => void;
  onToggle: (id: string) => void;
}) {
  const { t, lang } = useT();
  const executions = useMemo(() => groupModelTraces(items), [items]);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const scrolledRequest = useRef<string | null>(null);
  useEffect(() => {
    const button = selectedButton.current;
    if (
      !scrollReady ||
      !button ||
      scrolledRequest.current === selectedRequest ||
      button.getClientRects?.().length === 0
    )
      return;
    button.scrollIntoView?.({ block: "nearest" });
    scrolledRequest.current = selectedRequest;
  }, [selectedRequest, scrollReady, activeStep]);
  return (
    <ul className="space-y-2">
      {executions.map((execution) => (
        <li key={execution.traceId} className="min-w-0 rounded-lg border border-border/60 p-1">
          <button
            type="button"
            data-trace-group={execution.traceId}
            aria-pressed={selectedTrace === execution.traceId}
            className="sticky top-0 z-10 mb-1 block w-full rounded-md border-b border-border/60 bg-card px-2 py-2 text-left text-xs shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelect(execution.requests[0].id)}
          >
            <span className="block font-medium">
              {t("observability.execution")} · {traceTime(execution.startedAt, lang)}
            </span>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              {t("observability.executionCalls", { count: execution.requests.length })}
            </span>
            <span className="mt-1 block break-all font-mono text-[9px] text-muted-foreground">
              {execution.traceId}
            </span>
          </button>
          <ul>
            {execution.requests.map((call) => (
              <li key={call.id} className="min-w-0">
                <div className="flex min-w-0 items-start">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mt-1 size-6 shrink-0"
                    aria-label={`${t("observability.attempts", { count: cache[call.id]?.record.attempts.length ?? call.attemptCount })} · ${call.id}`}
                    aria-expanded={expanded.has(call.id)}
                    onClick={() => onToggle(call.id)}
                  >
                    {expanded.has(call.id) ? (
                      <ChevronDown size={12} aria-hidden />
                    ) : (
                      <ChevronRight size={12} aria-hidden />
                    )}
                  </Button>
                  <button
                    type="button"
                    ref={selectedRequest === call.id ? selectedButton : undefined}
                    data-trace-request={call.id}
                    aria-pressed={selectedRequest === call.id && selection.kind === "request"}
                    className={cn(
                      "min-w-0 flex-1 rounded-lg border px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selectedRequest === call.id && selection.kind === "request"
                        ? "border-primary/40 bg-primary/5"
                        : "border-transparent hover:bg-muted/40",
                    )}
                    onClick={() => onSelect(call.id)}
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
                            onClick={() => onSelect(call.id, { kind: "attempt", id: attempt.id })}
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
                    {!!eventsByRequest.get(call.id)?.length && (
                      <ModelTraceEvents
                        events={eventsByRequest.get(call.id)!}
                        requestId={call.id}
                        selectedRequest={selectedRequest}
                        selection={selection}
                        onSelect={onSelect}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
