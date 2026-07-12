import type { PetProjectionSnapshot } from "../../preload/types";
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
  onOpenPending,
  onOpenSession,
}: {
  projection: PetProjectionSnapshot | null;
  status: PetProjectionStatus;
  now?: number;
  onOpenPending?: (sessionId: string, requestId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const selected = selectPetOverview(projection, status, now);
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
        <PendingDecisionSection
          pending={selected.pending}
          onOpen={(decision) => onOpenPending?.(decision.agentSessionId, decision.requestId)}
        />
        <SessionStatusSection
          sessions={selected.sessions}
          emptyState={selected.emptyState}
          now={now}
          onOpen={(session) => onOpenSession?.(session.agentSessionId)}
        />
      </div>
    </section>
  );
}
