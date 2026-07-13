import type { PetOpenSessionRequest, PetProjectionSnapshot } from "../../preload/types";
import React from "react";
import { PetOverviewHeader } from "./PetOverviewHeader";
import { PetWorkTree } from "./PetWorkTree";
import { loadDismissedPetWorkItemIds, saveDismissedPetWorkItemIds } from "./petWorkInbox";
import { buildPetWorkMap } from "./petWorkMap";
import { selectPetOverview } from "./petSelectors";
import type { PetProjectionStatus } from "./petStateReducer";

export function PetWorldPane({
  projection,
  status,
  now = Date.now(),
  onNavigate,
  focusPending = false,
  excludedSessionIds,
}: {
  projection: PetProjectionSnapshot | null;
  status: PetProjectionStatus;
  now?: number;
  onNavigate?: (request: PetOpenSessionRequest) => void;
  focusPending?: boolean;
  excludedSessionIds?: ReadonlySet<string>;
}) {
  const selected = selectPetOverview(projection, status, now);
  const [dismissedIds, setDismissedIds] = React.useState(loadDismissedPetWorkItemIds);
  const workMap = buildPetWorkMap(selected.sessions, selected.pending, {
    dismissedIds,
    excludedSessionIds,
  });
  const pendingRef = React.useRef<HTMLDivElement>(null);
  const dismissItems = React.useCallback((ids: readonly string[]) => {
    setDismissedIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      saveDismissedPetWorkItemIds(next);
      return next;
    });
  }, []);
  const restoreDismissed = React.useCallback(() => {
    const next = new Set<string>();
    saveDismissedPetWorkItemIds(next);
    setDismissedIds(next);
  }, []);
  React.useEffect(() => {
    if (!focusPending) return;
    pendingRef.current?.focus();
    pendingRef.current?.scrollIntoView({ block: "start" });
  }, [focusPending]);
  return (
    <section
      data-pet-world-pane="deterministic"
      className="mimi-surface flex max-h-full flex-col self-start overflow-hidden rounded-3xl"
    >
      <PetOverviewHeader
        unfinishedCount={workMap.counts.unfinished}
        optimizationCount={workMap.counts.optimization}
        completedCount={workMap.counts.completed}
        observedAt={projection?.observedAt}
        now={now}
        loading={status === "loading"}
        reconciling={status === "reconciling"}
        retrying={status === "error"}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 min-[1440px]:p-5">
        <div ref={pendingRef} tabIndex={-1} className="outline-none">
          <PetWorkTree
            workMap={workMap}
            emptyState={selected.emptyState}
            defaultOpen={focusPending}
            onDismiss={(item) => dismissItems([item.id])}
            onClearCompleted={() => dismissItems(workMap.itemIds.completed)}
            onRestoreDismissed={restoreDismissed}
            onOpen={(item) => {
              if (!projection) return;
              onNavigate?.({
                ...item.navigation,
                snapshotVersion: projection.version,
                generation: projection.generation,
              });
            }}
          />
        </div>
      </div>
    </section>
  );
}
