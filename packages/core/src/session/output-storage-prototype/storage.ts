/** Non-activated, opt-in private fixture WAL. No production import or activation path. */
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync } from "node:fs";
import type { SessionState } from "../../types.js";
import {
  encodeState,
  EVENT_ID,
  fail,
  goalEffect,
  StorageFailure,
  type DecodedState,
  type Position,
  type RawObject,
} from "./codec.js";
import { CompleteIdentityIndex, IdentityPool } from "./id-index.js";
import {
  appendUnderLease,
  assertJournalFile,
  FixtureCustody,
  JOURNAL_LIMIT,
  openJournal,
  readStateUnderLease,
  stamp,
  writeStateUnderLease,
  type Lease,
} from "./io.js";
import {
  encodeRecord,
  eventPayloads,
  projection,
  readBinding,
  receiptAt,
  token,
  validateScope,
  verifyJournal,
  verifyState,
  type Scope,
  type VerifiedJournal,
} from "./journal.js";

export type Stage =
  | "transition_appended"
  | "transition_state"
  | "begin"
  | "pending_state"
  | "prepared"
  | "final_state"
  | "commit";
export type Receipt = { cursor: string; replayed: boolean };
export class FixtureStorage {
  private readonly custody: FixtureCustody;
  private readonly index: CompleteIdentityIndex;
  private verified?: VerifiedJournal;
  constructor(root: string, sessionId: string, pool: IdentityPool) {
    this.custody = new FixtureCustody(root, sessionId);
    this.index = new CompleteIdentityIndex(pool);
  }
  dispose(): void {
    this.index.dispose();
  }
  private underLease<T>(
    operation: (lease: Lease, fd: number, state: DecodedState, proof: VerifiedJournal) => T,
  ): T {
    return this.custody.withLease((lease) => {
      const fd = openJournal(lease, true);
      try {
        const state = readStateUnderLease(lease);
        if (!this.verified || !this.index.isAuthenticated(stamp(fd))) {
          this.index.reset();
          this.verified = verifyJournal(
            fd,
            lease.root,
            lstatSync(lease.directory),
            state,
            this.index,
          );
        } else verifyState(state, this.verified);
        const result = operation(lease, fd, state, this.verified);
        assertJournalFile(lease, fd);
        return result;
      } catch (error) {
        this.index.invalidate();
        this.verified = undefined;
        throw error;
      } finally {
        closeSync(fd);
      }
    });
  }
  inspect(): VerifiedJournal {
    return this.underLease((_lease, _fd, _state, proof) => structuredClone(proof));
  }
  /** Test-only opt-in transition. Does not prove physical old-runtime quiescence. */
  transition(stage: (stage: Stage) => void = () => {}): string {
    return this.underLease((lease, fd, state, proof) => {
      if (proof.transition) return token(proof.identity, proof.head);
      const transition = {
        id: randomUUID(),
        epoch: randomUUID(),
        from: 1,
        to: 2,
        priorThrough: token(proof.identity, proof.head),
        headerPin: proof.pin,
        initialControlEffect: goalEffect(state.state),
      };
      const record = encodeRecord(proof.head, { kind: "format_transition", transition });
      const next: DecodedState = {
        state: { ...state.state, stateRevision: state.state.stateRevision ?? 0 },
        format: {
          version: 2,
          epoch: transition.epoch,
          phase: "active",
          transitionId: transition.id,
          v1Through: transition.priorThrough,
          headerPin: proof.pin,
        },
        control: { effectDigest: transition.initialControlEffect },
      };
      encodeState(next); // Every deterministic validation happens before the first mutation.
      appendUnderLease(lease, fd, record.bytes, proof.head.offset);
      stage("transition_appended");
      writeStateUnderLease(lease, next);
      stage("transition_state");
      this.verified = { ...proof, head: record.position, transition, fileStamp: stamp(fd) };
      this.index.authenticate(stamp(fd));
      return token(proof.identity, record.position);
    });
  }
  append(eventId: string, scope: Scope, event: RawObject): Receipt {
    return this.underLease((lease, fd, state, proof) => {
      if (!state.format) fail("Fixture v2 transition required");
      this.validateId(eventId);
      validateScope(scope);
      const projected = projection(scope, event, null);
      const prior = this.index.lookup(eventId, projected, stamp(fd), (offset) =>
        readBinding(fd, offset),
      );
      if (prior) return { cursor: receiptAt(fd, proof.identity, prior.offset), replayed: true };
      this.index.assertInsertable(eventId, (offset) => readBinding(fd, offset));
      const encoded = this.encode(
        proof.head,
        eventPayloads({ eventId, scope, projectionDigest: projected }, event),
      );
      appendUnderLease(lease, fd, encoded.bytes, proof.head.offset);
      this.index.addVerified(
        eventId,
        projected,
        { ...encoded.head, bindingOffset: proof.head.offset },
        (offset) => readBinding(fd, offset),
      );
      this.verified = { ...proof, head: encoded.head, fileStamp: stamp(fd) };
      this.index.authenticate(stamp(fd));
      return { cursor: token(proof.identity, encoded.head), replayed: false };
    });
  }
  /** Goal-only fixture state CAS plus display projection; never borrows a run id. */
  control(
    eventId: string,
    scope: Scope,
    goal: unknown,
    event: RawObject | null,
    expectedRevision: number,
    stage: (stage: Stage) => void = () => {},
  ): Receipt {
    return this.underLease((lease, fd, current, proof) => {
      if (!current.format || !current.control) fail("Fixture v2 transition required");
      this.validateId(eventId);
      validateScope(scope);
      if (scope.kind !== "control" || scope.operation !== "goal")
        fail("Goal control fixture scope required");
      const nextState = {
        ...current.state,
        goalLifecycle: goal,
        stateRevision: expectedRevision + 1,
      } as SessionState;
      const afterEffect = goalEffect(nextState);
      const projected = projection(scope, event, afterEffect);
      const prior = this.index.lookup(eventId, projected, stamp(fd), (offset) =>
        readBinding(fd, offset),
      );
      if (prior) return { cursor: receiptAt(fd, proof.identity, prior.offset), replayed: true };
      if (current.state.stateRevision !== expectedRevision)
        throw new StorageFailure("conflict", "State revision conflict");
      this.index.assertInsertable(eventId, (offset) => readBinding(fd, offset));
      const id = randomUUID();
      const payloads = event
        ? eventPayloads({ eventId, scope, txId: id, projectionDigest: projected }, event)
        : [];
      const tx = {
        id,
        eventId,
        scope,
        beforeRevision: expectedRevision,
        afterRevision: expectedRevision + 1,
        beforeEffect: current.control.effectDigest,
        afterEffect,
        projectionDigest: projected,
        hasDisplayEvent: !!event,
        plannedPreparedRecords: payloads.length,
      };
      const begin = encodeRecord(proof.head, { kind: "tx_begin", tx });
      const beginCursor = token(proof.identity, begin.position);
      const prepared = this.encode(begin.position, payloads);
      const commit = encodeRecord(prepared.head, {
        kind: "tx_commit",
        tx: {
          id,
          eventId,
          begin: beginCursor,
          preparedThrough: token(proof.identity, prepared.head),
          projectionDigest: projected,
          afterRevision: expectedRevision + 1,
          afterEffect,
        },
      });
      if (commit.position.offset > JOURNAL_LIMIT)
        throw new StorageFailure("capacity", "Journal storage bound");
      const pending: DecodedState = {
        state: nextState,
        format: current.format,
        control: {
          ...current.control,
          effectDigest: afterEffect,
          pending: {
            txId: id,
            eventId,
            begin: beginCursor,
            beforeRevision: expectedRevision,
            afterRevision: expectedRevision + 1,
            beforeEffect: current.control.effectDigest,
            afterEffect,
            projectionDigest: projected,
          },
        },
      };
      const lastCommitted = {
        txId: id,
        eventId,
        revision: expectedRevision + 1,
        effectDigest: afterEffect,
      };
      const final: DecodedState = {
        state: nextState,
        format: current.format,
        control: { effectDigest: afterEffect, lastCommitted },
      };
      encodeState(pending);
      encodeState(final);
      appendUnderLease(lease, fd, begin.bytes, proof.head.offset);
      stage("begin");
      writeStateUnderLease(lease, pending);
      stage("pending_state");
      if (payloads.length) appendUnderLease(lease, fd, prepared.bytes, begin.position.offset);
      stage("prepared");
      writeStateUnderLease(lease, final);
      stage("final_state");
      appendUnderLease(lease, fd, commit.bytes, prepared.head.offset);
      stage("commit");
      this.index.addVerified(
        eventId,
        projected,
        { ...commit.position, bindingOffset: proof.head.offset },
        (offset) => readBinding(fd, offset),
      );
      this.verified = {
        ...proof,
        head: commit.position,
        latestControl: lastCommitted,
        fileStamp: stamp(fd),
      };
      this.index.authenticate(stamp(fd));
      return { cursor: token(proof.identity, commit.position), replayed: false };
    });
  }
  private validateId(id: unknown): void {
    if (typeof id !== "string" || !EVENT_ID.test(id)) fail("Invalid event id");
  }
  private encode(head: Position, payloads: RawObject[]): { bytes: Buffer; head: Position } {
    const records: Buffer[] = [];
    for (const payload of payloads) {
      const encoded = encodeRecord(head, payload);
      records.push(encoded.bytes);
      head = encoded.position;
    }
    if (head.offset > JOURNAL_LIMIT) throw new StorageFailure("capacity", "Journal storage bound");
    return { bytes: Buffer.concat(records), head };
  }
}
