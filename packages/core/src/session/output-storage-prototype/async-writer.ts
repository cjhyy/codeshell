/** Marker-only writer recipes and outcomes; no producer authority or automatic WAL recovery. */
import { randomUUID } from "node:crypto";
import type { SessionState } from "../../types.js";
import {
  appendPreparedRecordGroup,
  captureOwnedGoal,
  captureOwnedJSON,
  finalizeAsyncWriter,
  prepareAsyncEventSource,
  prepareAsyncRecordGroup,
  prepareAsyncState,
  preparedEventCount,
  preparedGroupHead,
  readWriterFacts,
  writePreparedAsyncStateUnderLease,
  type AsyncFile,
  type AsyncLease,
  type PreparedRecordGroup,
  type PreparedState,
  type WriterFacts,
} from "./async-io.js";
import { AsyncJournalReader } from "./async-journal.js";
import {
  EVENT_ID,
  goalEffect,
  StorageFailure,
  type DecodedState,
  type RawObject,
} from "./codec.js";
import { AsyncIdentityIndex, type PreparedIndexInsert } from "./id-index.js";
import { token, validateScope, type Scope, type VerifiedJournal } from "./journal.js";
import type { Receipt } from "./storage.js";
import { combineFailures } from "./lease-fs.js";

export type DurableOutcome = "zero_effects" | "committed" | "incomplete_or_unknown";
export class WriterCancellation extends DOMException {
  constructor(
    readonly durableOutcome: DurableOutcome,
    readonly cause: unknown,
    readonly durableReceipt?: Receipt | string,
  ) {
    super("Private writer cancelled after actual settlement", "AbortError");
  }
}
export class WriterFailure extends AggregateError {
  readonly durableOutcome = "incomplete_or_unknown";
  constructor(causes: readonly unknown[]) {
    super(causes, "Private writer failed; durable outcome is incomplete or unknown", {
      cause: causes[0],
    });
  }
}
export type WriterRequest =
  | { kind: "transition" }
  | { kind: "append"; eventId: string; scope: Scope; event: RawObject }
  | {
      kind: "control";
      eventId: string;
      scope: Scope;
      event: RawObject | null;
      goal: unknown;
      revision: number;
    };
export function captureWriterRequest(
  kind: "append" | "control",
  eventId: string,
  scope: Scope,
  event: RawObject | null,
  goal?: unknown,
  revision?: number,
): WriterRequest {
  const ownedScope = captureOwnedJSON(scope);
  const ownedEvent = event === null ? null : captureOwnedJSON(event);
  const ownedGoal = kind === "control" ? captureOwnedGoal(goal) : undefined;
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId))
    throw new StorageFailure("incomplete", "Invalid event id");
  validateScope(ownedScope);
  if (kind === "append") {
    if (!ownedEvent) throw new StorageFailure("incomplete", "Display event required");
    return { kind, eventId, scope: ownedScope, event: ownedEvent };
  }
  if (
    ownedScope.kind !== "control" ||
    ownedScope.operation !== "goal" ||
    !Number.isSafeInteger(revision) ||
    revision! < 0 ||
    !Number.isSafeInteger(revision! + 1)
  )
    throw new StorageFailure("incomplete", "Goal scope and safe state revision required");
  return {
    kind,
    eventId,
    scope: ownedScope,
    event: ownedEvent,
    goal: ownedGoal,
    revision: revision!,
  };
}
type Stage = { name: string; group?: PreparedRecordGroup; state?: PreparedState };
export type PreparedMutation = {
  proof: VerifiedJournal;
  receipt: Receipt | string;
  stages: Stage[];
  finalStage?: string;
  delta?: PreparedIndexInsert;
};
export async function prepareWriterMutation(
  lease: AsyncLease,
  reader: AsyncJournalReader,
  current: DecodedState,
  proof: VerifiedJournal,
  index: AsyncIdentityIndex,
  request: WriterRequest,
): Promise<PreparedMutation> {
  if (request.kind === "transition") {
    if (proof.transition) return { proof, receipt: token(proof.identity, proof.head), stages: [] };
    const transition = {
      id: randomUUID(),
      epoch: randomUUID(),
      from: 1,
      to: 2,
      priorThrough: token(proof.identity, proof.head),
      headerPin: proof.pin,
      initialControlEffect: goalEffect(current.state),
    };
    const state = prepareAsyncState(lease, {
      state: { ...current.state, stateRevision: current.state.stateRevision ?? 0 },
      format: {
        version: 2,
        epoch: transition.epoch,
        phase: "active",
        transitionId: transition.id,
        v1Through: transition.priorThrough,
        headerPin: proof.pin,
      },
      control: { effectDigest: transition.initialControlEffect },
    });
    const group = await prepareAsyncRecordGroup(lease, proof.head, {
      kind: "format_transition",
      transition,
    });
    const head = preparedGroupHead(group);
    return {
      proof: { ...proof, head, transition },
      receipt: token(proof.identity, head),
      stages: [
        { name: "transition_appended", group },
        { name: "transition_state", state },
      ],
      finalStage: "transition_state",
    };
  }
  if (!current.format || !current.control)
    throw new StorageFailure("incomplete", "Fixture v2 transition required");
  const nextState =
    request.kind === "control"
      ? ({
          ...current.state,
          goalLifecycle: request.goal,
          stateRevision: request.revision + 1,
        } as SessionState)
      : current.state;
  const afterEffect = request.kind === "control" ? goalEffect(nextState) : null;
  const projected = (await reader.cpu({
    kind: "projection",
    scope: request.scope,
    event: request.event,
    effect: afterEffect,
  })) as string;
  const prior = await index.lookup(request.eventId, projected, proof.fileStamp, (offset) =>
    reader.binding(offset),
  );
  if (prior)
    return {
      proof,
      stages: [],
      receipt: {
        cursor: await reader.receipt(proof.identity, prior),
        replayed: true,
      },
    };
  if (request.kind === "control" && current.state.stateRevision !== request.revision)
    throw new StorageFailure("conflict", "State revision conflict");
  const txId = request.kind === "control" ? randomUUID() : undefined;
  const hasDisplayEvent = request.event !== null;
  const source = request.event
    ? await prepareAsyncEventSource(
        lease,
        {
          eventId: request.eventId,
          scope: request.scope,
          projectionDigest: projected,
          ...(txId ? { txId } : {}),
        },
        request.event,
      )
    : undefined;
  // Request is our private holder. Fragment recipes retain only bytes, not a second full object.
  request.event = null as never;
  const stages: Stage[] = [];
  let nextProof: VerifiedJournal;
  if (request.kind === "append") {
    const group = await prepareAsyncRecordGroup(lease, proof.head, undefined, source);
    nextProof = { ...proof, head: preparedGroupHead(group) };
    stages.push({ name: "append", group });
  } else {
    const tx = {
      id: txId!,
      eventId: request.eventId,
      scope: request.scope,
      beforeRevision: request.revision,
      afterRevision: request.revision + 1,
      beforeEffect: current.control.effectDigest,
      afterEffect: afterEffect!,
      projectionDigest: projected,
      hasDisplayEvent,
      plannedPreparedRecords: source ? preparedEventCount(source) : 0,
    };
    const begin = await prepareAsyncRecordGroup(lease, proof.head, { kind: "tx_begin", tx });
    const beginHead = preparedGroupHead(begin),
      beginCursor = token(proof.identity, beginHead);
    const prepared = await prepareAsyncRecordGroup(lease, beginHead, undefined, source);
    const preparedHead = preparedGroupHead(prepared);
    const commit = await prepareAsyncRecordGroup(lease, preparedHead, {
      kind: "tx_commit",
      tx: {
        id: txId!,
        eventId: request.eventId,
        begin: beginCursor,
        preparedThrough: token(proof.identity, preparedHead),
        projectionDigest: projected,
        afterRevision: request.revision + 1,
        afterEffect: afterEffect!,
      },
    });
    const lastCommitted = {
      txId: txId!,
      eventId: request.eventId,
      revision: request.revision + 1,
      effectDigest: afterEffect!,
    };
    const pending = prepareAsyncState(lease, {
      state: nextState,
      format: current.format,
      control: {
        ...current.control,
        effectDigest: afterEffect!,
        pending: {
          txId: txId!,
          eventId: request.eventId,
          begin: beginCursor,
          beforeRevision: request.revision,
          afterRevision: request.revision + 1,
          beforeEffect: current.control.effectDigest,
          afterEffect: afterEffect!,
          projectionDigest: projected,
        },
      },
    });
    const final = prepareAsyncState(lease, {
      state: nextState,
      format: current.format,
      control: { effectDigest: afterEffect!, lastCommitted },
    });
    stages.push(
      { name: "begin", group: begin },
      { name: "pending_state", state: pending },
      { name: "prepared", group: prepared },
      { name: "final_state", state: final },
      { name: "commit", group: commit },
    );
    nextProof = { ...proof, head: preparedGroupHead(commit), latestControl: lastCommitted };
  }
  const delta = await index.prepareInsert(
    request.eventId,
    projected,
    {
      sequence: nextProof.head.sequence,
      offset: nextProof.head.offset,
      bindingOffset: proof.head.offset,
    },
    (offset) => reader.binding(offset),
  );
  return {
    proof: nextProof,
    receipt: { cursor: token(proof.identity, nextProof.head), replayed: false },
    stages,
    finalStage: stages.at(-1)!.name,
    delta,
  };
}
export async function executeWriterMutation(
  lease: AsyncLease,
  file: AsyncFile,
  prepared: PreparedMutation,
  facts: WriterFacts,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    for (const stage of prepared.stages) {
      if (stage.group) await appendPreparedRecordGroup(lease, file, stage.group, facts, stage.name);
      else await writePreparedAsyncStateUnderLease(lease, stage.state!, facts, stage.name);
    }
  } catch (cause) {
    failures.push(cause);
  }
  if (!prepared.finalStage || readWriterFacts(facts).completed.includes(prepared.finalStage)) {
    try {
      await finalizeAsyncWriter(lease, file, prepared.proof, facts);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) throw combineFailures(failures);
}
/** Only actual DOM Abort leaves qualify; unknown/falsy/cleanup causes retain failure semantics. */
export function onlyCancellation(causes: readonly unknown[]): boolean {
  const active = new Set<unknown>(),
    complete = new Set<unknown>();
  const visit = (cause: unknown, depth = 0): boolean => {
    if (depth > 64 || active.has(cause)) return false;
    if (complete.has(cause)) return true;
    const abort = cause instanceof DOMException && cause.name === "AbortError";
    if (!abort && (!(cause instanceof AggregateError) || !cause.errors.length)) return false;
    active.add(cause);
    const ownCause = Object.getOwnPropertyDescriptor(cause, "cause");
    const ok =
      (abort ||
        (cause as AggregateError).errors.every((item: unknown) => visit(item, depth + 1))) &&
      (!ownCause || ("value" in ownCause && visit(ownCause.value, depth + 1)));
    active.delete(cause);
    if (ok) complete.add(cause);
    return ok;
  };
  return causes.length > 0 && causes.every((cause) => visit(cause));
}
