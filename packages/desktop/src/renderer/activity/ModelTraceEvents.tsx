import React from "react";
import type { ModelTraceEvent } from "../../preload/model-trace-api";
import type { TraceSelection } from "./ModelTraceDetail";
import { eventIndent, traceDuration } from "./modelTracePresentation";

export function ModelTraceEvents({
  events,
  requestId,
  selectedRequest,
  selection,
  onSelect,
}: {
  events: ModelTraceEvent[];
  requestId: string;
  selectedRequest: string | null;
  selection: TraceSelection;
  onSelect: (requestId: string, selection: TraceSelection) => void;
}) {
  return (
    <ul className="mt-1 space-y-1">
      {events.map((event) => (
        <li key={event.id} style={{ paddingLeft: eventIndent(event, events) * 12 }}>
          <button
            type="button"
            data-trace-event={event.id}
            aria-pressed={
              selectedRequest === requestId &&
              selection.kind === "event" &&
              selection.id === event.id
            }
            className="w-full min-w-0 rounded-lg px-2 py-2 text-left text-xs hover:bg-muted/40 aria-pressed:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelect(requestId, { kind: "event", id: event.id })}
          >
            <span className="block break-words [overflow-wrap:anywhere]">{event.name}</span>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              {event.kind} · {event.status} · {traceDuration(event.startedAt, event.endedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
