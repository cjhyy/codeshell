import type {
  PetOpenSessionRequest,
  PetProjectionSnapshot,
  PetWorkInboxSnapshot,
  PetWorkInboxUpdate,
} from "../../preload/types";
import React from "react";
import { PetOverviewHeader } from "./PetOverviewHeader";
import { PetWorkTree } from "./PetWorkTree";
import {
  loadDismissedPetWorkItemIds,
  newerPetWorkInboxSnapshot,
  updateDismissedPetWorkItemIds,
} from "./petWorkInbox";
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
  const [dismissedIds, setDismissedIds] = React.useState<Set<string>>(() => new Set());
  const dismissedIdsRef = React.useRef(dismissedIds);
  const dismissedRevisionRef = React.useRef(-1);
  const dismissedActiveRef = React.useRef(true);
  const dismissedPendingMutationsRef = React.useRef(0);
  const dismissedDeferredSnapshotRef = React.useRef<PetWorkInboxSnapshot | null>(null);
  const dismissedMutationQueueRef = React.useRef(Promise.resolve());
  const applyDismissedSnapshot = React.useCallback((value: unknown) => {
    const snapshot = newerPetWorkInboxSnapshot(value, dismissedRevisionRef.current);
    if (!snapshot || !dismissedActiveRef.current) return;
    dismissedRevisionRef.current = snapshot.revision;
    const next = new Set(snapshot.dismissedIds);
    dismissedIdsRef.current = next;
    setDismissedIds(next);
  }, []);
  const receiveDismissedSnapshot = React.useCallback(
    (value: unknown) => {
      const snapshot = newerPetWorkInboxSnapshot(value, dismissedRevisionRef.current);
      if (!snapshot) return;
      if (dismissedPendingMutationsRef.current > 0) {
        if (
          !dismissedDeferredSnapshotRef.current ||
          snapshot.revision > dismissedDeferredSnapshotRef.current.revision
        ) {
          dismissedDeferredSnapshotRef.current = snapshot;
        }
        return;
      }
      applyDismissedSnapshot(snapshot);
    },
    [applyDismissedSnapshot],
  );
  const enqueueDismissedMutation = React.useCallback(
    (update: PetWorkInboxUpdate, fallbackIds: ReadonlySet<string>) => {
      dismissedPendingMutationsRef.current += 1;
      dismissedMutationQueueRef.current = dismissedMutationQueueRef.current
        .then(async () => {
          const snapshot = await updateDismissedPetWorkItemIds(
            window.codeshell.pet,
            update,
            fallbackIds,
          );
          if (snapshot) receiveDismissedSnapshot(snapshot);
        })
        .finally(() => {
          dismissedPendingMutationsRef.current -= 1;
          if (dismissedPendingMutationsRef.current !== 0) return;
          const deferred = dismissedDeferredSnapshotRef.current;
          dismissedDeferredSnapshotRef.current = null;
          if (deferred) applyDismissedSnapshot(deferred);
        });
    },
    [applyDismissedSnapshot, receiveDismissedSnapshot],
  );
  const workMap = buildPetWorkMap(selected.sessions, selected.pending, {
    dismissedIds,
    excludedSessionIds,
  });
  const pendingRef = React.useRef<HTMLDivElement>(null);
  const dismissItems = React.useCallback(
    (ids: readonly string[]) => {
      const next = new Set(dismissedIdsRef.current);
      for (const id of ids) next.add(id);
      dismissedIdsRef.current = next;
      setDismissedIds(next);
      enqueueDismissedMutation({ action: "add", ids: [...ids] }, next);
    },
    [enqueueDismissedMutation],
  );
  const restoreDismissed = React.useCallback(() => {
    const next = new Set<string>();
    dismissedIdsRef.current = next;
    setDismissedIds(next);
    enqueueDismissedMutation({ action: "clear" }, next);
  }, [enqueueDismissedMutation]);
  React.useEffect(() => {
    let disposed = false;
    dismissedActiveRef.current = true;
    const api = window.codeshell.pet;
    const unsubscribe = api.onDismissedWorkItemIdsChanged((snapshot) => {
      if (!disposed) receiveDismissedSnapshot(snapshot);
    });
    void loadDismissedPetWorkItemIds(api).then((snapshot) => {
      if (!disposed) receiveDismissedSnapshot(snapshot);
    });
    return () => {
      disposed = true;
      dismissedActiveRef.current = false;
      unsubscribe();
    };
  }, [receiveDismissedSnapshot]);
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
