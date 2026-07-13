import type { PetOpenSessionRequest, PetProjectionSnapshot } from "../../preload/types";
import React from "react";
import { PendingDecisionSection } from "./PendingDecisionSection";
import { PetOverviewHeader } from "./PetOverviewHeader";
import { selectPetOverview } from "./petSelectors";
import { SessionStatusSection } from "./SessionStatusSection";
import type { PetProjectionStatus } from "./petStateReducer";

export function PetWorldPane({
  projection,
  status,
  now = Date.now(),
  onNavigate,
  focusPending = false,
}: {
  projection: PetProjectionSnapshot | null;
  status: PetProjectionStatus;
  now?: number;
  onNavigate?: (request: PetOpenSessionRequest) => void;
  focusPending?: boolean;
}) {
  const selected = selectPetOverview(projection, status, now);
  const pendingRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!focusPending) return;
    pendingRef.current?.focus();
    pendingRef.current?.scrollIntoView({ block: "start" });
  }, [focusPending]);
  return (
    <section
      data-pet-world-pane="deterministic"
      className="min-h-0 overflow-y-auto border-r border-border"
    >
      <PetOverviewHeader
        runningCount={selected.runningCount}
        queuedCount={selected.queuedCount}
        pendingCount={selected.pendingCount}
        observedAt={projection?.observedAt}
        now={now}
        loading={status === "loading"}
        reconciling={status === "reconciling"}
      />
      <div className="space-y-3 p-2">
        <div ref={pendingRef} tabIndex={-1} className="outline-none">
          <PendingDecisionSection
            pending={selected.pending}
            onOpen={(decision) => {
              if (!projection) return;
              onNavigate?.({
                agentSessionId: decision.agentSessionId,
                snapshotVersion: projection.version,
                generation: projection.generation,
                requestId: decision.requestId,
                routeGeneration: decision.routeGeneration,
              });
            }}
          />
        </div>
        <SessionStatusSection
          sessions={selected.sessions}
          emptyState={selected.emptyState}
          now={now}
          onOpen={(session) => {
            if (!projection) return;
            onNavigate?.({
              agentSessionId: session.agentSessionId,
              snapshotVersion: projection.version,
              generation: projection.generation,
            });
          }}
        />
      </div>
    </section>
  );
}
