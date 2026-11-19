import type { PetLongTask, PetLongTaskContext } from "@cjhyy/code-shell-pet";

/** Another request made to the same Session, for telling requests apart. */
export interface ClosureSiblingRequest {
  taskId: string;
  status: string;
  createdAt?: number;
  objective: string;
}

/**
 * Which request a closure receipt is about, in fields Mimi can compare.
 *
 * A receipt used to carry only the task id, its objective and the error. A
 * request that failed while still queued then read like "some earlier request
 * failed", and Mimi told the owner that the request she had just made was
 * accepted separately, when the failed one was that request.
 */
export interface ClosureRequestIdentity {
  /** When this request was made. */
  createdAt: number;
  /** False when the request ended before any run of it started: nothing was executed. */
  started: boolean;
  request: {
    /** No later request has been made to this Session. */
    latestForSession: boolean;
    /** Requests to the same Session that are still queued or running. */
    openForSession: ClosureSiblingRequest[];
    /** Requests made to the same Session after this one, newest first. */
    newerForSession: ClosureSiblingRequest[];
  };
}

const MAX_SIBLINGS = 3;

export function closureRequestIdentity(
  task: PetLongTask,
  context: PetLongTaskContext | undefined,
): ClosureRequestIdentity {
  const sibling = (entry: {
    taskId: string;
    status: string;
    createdAt?: number;
    objective: string;
  }): ClosureSiblingRequest => ({
    taskId: entry.taskId,
    status: entry.status,
    ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
    objective: entry.objective.replace(/\s+/gu, " ").trim().slice(0, 200),
  });
  const same = <T extends { taskId: string; sessionId: string }>(entries: readonly T[]) =>
    entries.filter((entry) => entry.sessionId === task.sessionId && entry.taskId !== task.id);
  const open = same(context?.active ?? []);
  const newer = [...open, ...same(context?.recent ?? [])]
    .filter((entry) => entry.createdAt !== undefined && entry.createdAt > task.createdAt)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  return {
    createdAt: task.createdAt,
    started: task.startedAt !== undefined || task.events.some((event) => event.kind === "started"),
    request: {
      latestForSession: newer.length === 0,
      openForSession: open.slice(0, MAX_SIBLINGS).map(sibling),
      newerForSession: newer.slice(0, MAX_SIBLINGS).map(sibling),
    },
  };
}
