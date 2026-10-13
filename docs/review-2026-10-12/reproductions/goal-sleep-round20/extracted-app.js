const reconcileGoalMutation = async (eid, bucket, before, expectedProjection, mutationSeq) => {
  if (goalMutationSeqRef.current.get(bucket) !== mutationSeq)
    return "superseded";
  try {
    const persisted = await window.codeshell.goalGet(eid);
    if (goalMutationSeqRef.current.get(bucket) !== mutationSeq)
      return "superseded";
    if (persisted.ok === false)
      throw new Error("goal reconciliation rejected");
    if (persisted.goal) {
      const persistedGoalId = persisted.goalId ?? before.goalId;
      const sameGoal = persistedGoalId === before.goalId;
      dispatch({
        type: "goal_reconcile",
        bucket,
        expected: expectedProjection ? {
          goalId: expectedProjection.goalId,
          revision: expectedProjection.revision
        } : null,
        goal: {
          goalId: persistedGoalId,
          revision: persisted.revision ?? (sameGoal ? before.revision : undefined),
          objective: persisted.goal,
          paused: persisted.paused ?? false,
          round: sameGoal ? before.round : 0
        }
      });
      return "active";
    } else {
      dispatch({
        type: "goal_reconcile",
        bucket,
        expected: expectedProjection ? {
          goalId: expectedProjection.goalId,
          revision: expectedProjection.revision
        } : null,
        goal: null
      });
      return "deleted";
    }
  } catch (error) {
    window.codeshell.log("goal.reconcile.failed", {
      sessionId: eid,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  if (goalMutationSeqRef.current.get(bucket) !== mutationSeq)
    return "superseded";
  dispatch({
    type: "goal_reconcile",
    bucket,
    expected: expectedProjection ? { goalId: expectedProjection.goalId, revision: expectedProjection.revision } : null,
    goal: before
  });
  return "active";
};
const mutateActiveGoal = (next, operation) => {
  const eid = engineSessionIdForActive();
  const before = state.activeGoal;
  if (!eid || !before || !before.goalId || before.revision === undefined)
    return;
  const expectedGoalId = before.goalId;
  const expectedRevision = before.revision;
  const bucket = activeBucket;
  const optimistic = {
    ...next,
    revision: Math.max(1, before.revision) + 1
  };
  const mutationSeq = (goalMutationSeqRef.current.get(bucket) ?? 0) + 1;
  goalMutationSeqRef.current.set(bucket, mutationSeq);
  dispatch({
    type: "stream",
    bucket,
    event: {
      type: "goal_updated",
      goalId: optimistic.goalId,
      revision: optimistic.revision,
      objective: optimistic.objective,
      paused: optimistic.paused
    }
  });
  (async () => {
    try {
      const result = await window.codeshell.goalUpdate(eid, {
        ...next.objective !== before.objective ? { objective: next.objective } : {},
        ...next.paused !== before.paused ? { paused: next.paused } : {},
        expectedGoalId,
        expectedRevision
      });
      if (!result.ok || !result.updated) {
        throw new Error(result.ok ? "goal was not updated" : "goal update rejected");
      }
      if (goalMutationSeqRef.current.get(bucket) !== mutationSeq)
        return;
      dispatch({
        type: "stream",
        bucket,
        event: {
          type: "goal_updated",
          goalId: result.goalId ?? optimistic.goalId,
          revision: result.revision ?? optimistic.revision,
          objective: result.goal?.trim() || optimistic.objective,
          paused: result.paused ?? optimistic.paused
        }
      });
    } catch (error) {
      window.codeshell.log("goal.update.failed", {
        operation,
        sessionId: eid,
        error: error instanceof Error ? error.message : String(error)
      });
      await reconcileGoalMutation(eid, bucket, before, optimistic, mutationSeq);
    }
  })();
};
const handleUpdateGoal = (objective) => {
  const goal = state.activeGoal;
  const nextObjective = objective.trim();
  if (!goal || !nextObjective || nextObjective === goal.objective)
    return;
  mutateActiveGoal({ ...goal, objective: nextObjective }, "edit");
};
const handleGoalPausedChange = (paused) => {
  const goal = state.activeGoal;
  if (!goal || paused === goal.paused)
    return;
  mutateActiveGoal({ ...goal, paused }, paused ? "pause" : "resume");
};
const handleDeleteGoal = () => {
  const eid = engineSessionIdForActive();
  const before = state.activeGoal;
  if (!eid || !before || !before.goalId || before.revision === undefined)
    return;
  const expectedGoalId = before.goalId;
  const expectedRevision = before.revision;
  const bucket = activeBucket;
  const previousGoalToggle = goalOverrides[bucket] ?? false;
  const mutationSeq = (goalMutationSeqRef.current.get(bucket) ?? 0) + 1;
  goalMutationSeqRef.current.set(bucket, mutationSeq);
  dispatch({
    type: "stream",
    bucket,
    event: {
      type: "goal_cleared",
      goalId: before.goalId,
      revision: before.revision
    }
  });
  setGoalOverrides((prev) => ({ ...prev, [bucket]: false }));
  (async () => {
    try {
      const result = window.codeshell.goalDelete ? await window.codeshell.goalDelete(eid, {
        expectedGoalId,
        expectedRevision
      }) : await window.codeshell.goalClear(eid).then(({ ok, cleared }) => ({ ok, deleted: cleared }));
      if (!result.ok || !result.deleted) {
        throw new Error(result.ok ? "goal was not deleted" : "goal delete rejected");
      }
    } catch (error) {
      window.codeshell.log("goal.delete.failed", {
        sessionId: eid,
        error: error instanceof Error ? error.message : String(error)
      });
      const reconciled = await reconcileGoalMutation(eid, bucket, before, null, mutationSeq);
      if (reconciled === "active") {
        setGoalOverrides((prev) => ({ ...prev, [bucket]: previousGoalToggle }));
      }
    }
  })();
};
return { handleGoalPausedChange, handleDeleteGoal, handleUpdateGoal };
