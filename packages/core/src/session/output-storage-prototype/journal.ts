/** Bounded verification spike. Reads never truncate, repair, execute, or publish. */
import { randomUUID } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import {
  canonical,
  digest,
  EVENT_ID,
  fail,
  HEX,
  integer,
  keys,
  object,
  parseUnique,
  StorageFailure,
  UUID,
  type DecodedState,
  type Position,
  type RawObject,
} from "./codec.js";
import { CompleteIdentityIndex } from "./id-index.js";
import { CHUNK_SIZE, EVENT_LIMIT, JOURNAL_LIMIT, RECORD_LIMIT, stamp } from "./io.js";

export type Scope = RawObject & { kind: string };
export type Binding = { eventId: string; scope: Scope; projectionDigest: string; txId?: string };
type Fragment = {
  id: string;
  index: number;
  total: number;
  eventBytes: number;
  eventDigest: string;
  data: string;
};
type Begin = {
  id: string;
  eventId: string;
  scope: Scope;
  beforeRevision: number;
  afterRevision: number;
  beforeEffect: string;
  afterEffect: string;
  projectionDigest: string;
  hasDisplayEvent: boolean;
  plannedPreparedRecords: number;
};
type Commit = {
  id: string;
  eventId: string;
  begin: string;
  preparedThrough: string;
  projectionDigest: string;
  afterRevision: number;
  afterEffect: string;
};
type Line = { text: string; start: number; end: number };
export type VerifiedJournal = {
  identity: string;
  pin: string;
  start: Position;
  head: Position;
  fileStamp: string;
  transition?: RawObject;
  latestControl?: { txId: string; eventId: string; revision: number; effectDigest: string };
  uncommittedLegacyTail: boolean;
};
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const hex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const eventId = (v: unknown): v is string => typeof v === "string" && EVENT_ID.test(v);
export function token(identity: string, position: Position): string {
  return Buffer.from(JSON.stringify({ identity, ...position })).toString("base64url");
}
export function projection(scope: Scope, event: RawObject | null, effect: string | null): string {
  return digest(canonical({ scope, event, effect }));
}
export function validateScope(raw: unknown): Scope {
  if (!object(raw) || !text(raw.kind)) fail("Invalid producer scope");
  switch (raw.kind) {
    case "run":
      keys(raw, ["kind", "runId"], ["clientMessageId"]);
      break;
    case "control":
      keys(raw, ["kind", "operation", "operationId"], ["goal"]);
      if (!["goal", "compact", "archive"].includes(String(raw.operation)))
        fail("Invalid control operation");
      if (raw.goal !== undefined) {
        if (!object(raw.goal)) fail("Invalid Goal scope");
        keys(raw.goal, ["id", "beforeRevision", "afterRevision"]);
        if (
          !text(raw.goal.id) ||
          !integer(raw.goal.beforeRevision) ||
          !integer(raw.goal.afterRevision) ||
          raw.goal.beforeRevision < 1 ||
          raw.goal.afterRevision < 1
        )
          fail("Invalid Goal scope");
      }
      break;
    case "background":
      keys(
        raw,
        ["kind", "source", "sourceId", "originSessionId"],
        ["originClientMessageId", "workId", "attempt"],
      );
      if (!["agent_notification", "background_work"].includes(String(raw.source)))
        fail("Invalid background source");
      break;
    case "host_notice":
      keys(raw, ["kind", "source", "invocationId"]);
      if (
        ![
          "panel_submit",
          "automation",
          "async_answer",
          "background_wakeup",
          "cross_session_setup",
        ].includes(String(raw.source))
      )
        fail("Invalid notice source");
      break;
    case "metadata":
      keys(raw, ["kind", "operation", "operationId"]);
      if (raw.operation !== "session_title") fail("Invalid metadata source");
      break;
    case "queued_input":
      keys(raw, ["kind", "submitId"], ["originSessionId"]);
      break;
    default:
      throw new StorageFailure("unsupported", "Unknown producer scope");
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "goal") continue;
    if (key === "attempt" && integer(value)) continue;
    if (!text(value)) fail("Invalid native source identity");
  }
  return raw as Scope;
}

/** Stream at most one bounded record; fatal UTF8 includes BOM instead of stripping it. */
export function* lines(fd: number, start: number, end: number): Generator<Line> {
  let offset = start;
  let pending = Buffer.alloc(0);
  while (offset < end) {
    const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, end - offset));
    const n = readSync(fd, buffer, 0, buffer.length, offset);
    if (!n) fail("Journal read made no progress");
    offset += n;
    pending = Buffer.concat([pending, buffer.subarray(0, n)]);
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      if (newline > RECORD_LIMIT) throw new StorageFailure("capacity", "Journal record byte bound");
      const bytes = pending.subarray(0, newline);
      const end = offset - pending.length + newline + 1;
      const line = {
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        start: end - newline - 1,
        end,
      };
      pending = pending.subarray(newline + 1);
      yield line;
    }
    if (pending.length > RECORD_LIMIT)
      throw new StorageFailure("capacity", "Journal record byte bound");
  }
}
export function readBinding(fd: number, offset: number): string {
  const size = fstatSync(fd).size;
  const line = lines(fd, offset, Math.min(size, offset + RECORD_LIMIT + 1)).next();
  if (line.done) fail("Missing indexed binding");
  const raw = parseUnique(line.value.text, RECORD_LIMIT);
  if (!object(raw)) fail("Invalid indexed binding");
  const id = object(raw.tx) ? raw.tx.eventId : raw.eventId;
  if (!eventId(id)) fail("Invalid indexed event id");
  return id;
}
export function receiptAt(fd: number, identity: string, end: number): string {
  const start = Math.max(0, end - RECORD_LIMIT - 1);
  const bytes = Buffer.alloc(end - start);
  let done = 0;
  while (done < bytes.length) {
    const n = readSync(fd, bytes, done, bytes.length - done, start + done);
    if (!n) fail("Indexed receipt read made no progress");
    done += n;
  }
  if (bytes.at(-1) !== 0x0a) fail("Indexed receipt is not a record boundary");
  const previous = bytes.lastIndexOf(0x0a, bytes.length - 2);
  const raw = parseUnique(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(previous + 1, bytes.length - 1),
    ),
    RECORD_LIMIT,
  );
  if (!object(raw) || !integer(raw.sequence) || !hex(raw.hash)) fail("Invalid indexed receipt");
  return token(identity, { sequence: raw.sequence, offset: end, hash: raw.hash });
}
export function encodeRecord(
  head: Position,
  payload: RawObject,
): { bytes: Buffer; position: Position } {
  const value = {
    recordVersion: 2,
    sequence: head.sequence + 1,
    previousHash: head.hash,
    ...payload,
  };
  const hash = digest(canonical(value));
  const bytes = Buffer.from(canonical({ ...value, hash }) + "\n");
  if (bytes.length - 1 > RECORD_LIMIT)
    throw new StorageFailure("capacity", "Encoded record byte bound");
  return {
    bytes,
    position: { sequence: value.sequence, offset: head.offset + bytes.length, hash },
  };
}
export function eventPayloads(binding: Binding, event: RawObject): RawObject[] {
  if (!object(event) || !text(event.type)) fail("Invalid display event");
  const bytes = Buffer.from(canonical(event));
  if (bytes.length > EVENT_LIMIT) throw new StorageFailure("capacity", "Whole event byte bound");
  const id = randomUUID();
  const eventDigest = digest(bytes);
  return Array.from(eventPayloadIterator(binding, event, bytes, id, eventDigest));
}
/** Shared wire recipe; callers here are internal owners of the already captured bytes and IDs. */
export function* eventPayloadIterator(
  binding: Binding,
  event: RawObject,
  bytes: Buffer,
  id: string,
  eventDigest: string,
): Generator<RawObject> {
  if (bytes.length <= CHUNK_SIZE) {
    yield { kind: "event", ...binding, event };
    return;
  }
  const total = Math.ceil(bytes.length / CHUNK_SIZE);
  for (let index = 0; index < total; index++)
    yield {
      kind: "fragment",
      ...binding,
      fragment: {
        id,
        index,
        total,
        eventBytes: bytes.length,
        eventDigest,
        data: bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE).toString("base64"),
      },
    };
}

export type JournalStep =
  | { kind: "line" }
  | {
      kind: "add";
      eventId: string;
      projection: string;
      receipt: { sequence: number; offset: number; bindingOffset: number };
    }
  | { kind: "parse"; text: string; maxBytes: number; unique: boolean }
  | { kind: "canonical"; value: unknown }
  | { kind: "digest"; value: string | Buffer }
  | { kind: "digestCanonical"; value: unknown }
  | { kind: "projection"; scope: Scope; event: RawObject | null; effect: string | null }
  | { kind: "decode"; bytes: Buffer };
export type JournalSteps<T> = Generator<JournalStep, T, any>;

/** Bounded CPU-only sync evaluator. Async I/O uses the same semantic state machine below. */
export function evaluateJournalStep(
  step: Exclude<JournalStep, { kind: "line" } | { kind: "add" }>,
): unknown {
  switch (step.kind) {
    case "parse":
      return step.unique ? parseUnique(step.text, step.maxBytes) : JSON.parse(step.text);
    case "canonical":
      return canonical(step.value);
    case "digest":
      return digest(step.value);
    case "digestCanonical":
      return digest(canonical(step.value));
    case "projection":
      return projection(step.scope, step.event, step.effect);
    case "decode":
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(step.bytes);
  }
}

/** Sync I/O driver retained for the original private fixture writer and its regression tests. */
export function verifyJournal(
  fd: number,
  root: string,
  directoryIdentity: { dev: number; ino: number },
  decoded: DecodedState,
  index: CompleteIdentityIndex,
): VerifiedJournal {
  const file = fstatSync(fd);
  const beforeStamp = stamp(fd);
  const iterator = lines(fd, 0, file.size);
  const steps = verifyJournalSteps(root, directoryIdentity, file, file.size, beforeStamp, decoded);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    let result: unknown;
    if (step.kind === "line") {
      const line = iterator.next();
      result = line.done ? undefined : line.value;
    } else if (step.kind === "add")
      index.addVerified(step.eventId, step.projection, step.receipt, (offset) =>
        readBinding(fd, offset),
      );
    else result = evaluateJournalStep(step);
    next = steps.next(result);
  }
  if (stamp(fd) !== beforeStamp) fail("Journal changed during verification");
  index.authenticate(beforeStamp);
  return next.value;
}

/** One validator for both drivers; it cannot perform I/O, authenticate an index or publish proof. */
export function* verifyJournalSteps(
  root: string,
  directoryIdentity: { dev: number | string; ino: number | string },
  fileIdentity: { dev: number | string; ino: number | string },
  size: number,
  beforeStamp: string,
  decoded: DecodedState,
): JournalSteps<VerifiedJournal> {
  if (size > JOURNAL_LIMIT) throw new StorageFailure("capacity", "Journal byte bound");
  const first = (yield { kind: "line" }) as Line | undefined;
  if (!first) fail("Missing journal header");
  const header = yield { kind: "parse", text: first.text, maxBytes: RECORD_LIMIT, unique: false };
  if (
    !object(header) ||
    header.version !== 1 ||
    header.sessionId !== decoded.state.sessionId ||
    header.startedAt !== decoded.state.startedAt ||
    !hex(header.storageScope) ||
    !text(header.sessionIncarnation) ||
    !text(header.journalId)
  )
    fail("Invalid pinned journal header");
  const pin = yield { kind: "digest", value: first.text + "\n" };
  if (decoded.state.outputJournalIdentity !== pin) fail("Journal pin missing or replaced");
  const rootDigest = yield { kind: "digest", value: root };
  const identity = yield {
    kind: "digest",
    // Existing v1 cursor identities stringify Node's default numeric Stats projection.
    // Ownership and stamps remain exact BigInt values in the async I/O driver.
    value: `${rootDigest}\n${first.text}\n${Number(directoryIdentity.dev)}:${Number(directoryIdentity.ino)}\n${Number(fileIdentity.dev)}:${Number(fileIdentity.ino)}`,
  };
  const start = { sequence: 0, offset: first.end, hash: pin };
  let current: Position = start;
  let committed: Position = start;
  let transition: RawObject | undefined;
  let latestControl: VerifiedJournal["latestControl"];
  let effect: string | undefined;
  let pending:
    | { begin: Begin; cursor: string; bindingOffset: number; prepared?: string; count: number }
    | undefined;
  let group:
    | { binding: Binding; fragment: Fragment; chunks: Buffer[]; bytes: number; start: number }
    | undefined;
  let legacyGroup: { id: string; total: number; index: number } | undefined;

  for (;;) {
    const line = (yield { kind: "line" }) as Line | undefined;
    if (!line) break;
    const raw = yield { kind: "parse", text: line.text, maxBytes: RECORD_LIMIT, unique: false };
    if (!object(raw)) fail("Invalid record object");
    const { hash, ...value } = raw;
    if (
      value.sequence !== current.sequence + 1 ||
      value.previousHash !== current.hash ||
      !hex(hash)
    )
      fail("Journal continuity failed");
    current = { sequence: value.sequence as number, offset: line.end, hash };
    if (!transition && typeof value.runId === "string") {
      if (
        transition ||
        typeof value.runId !== "string" ||
        !!value.event === !!value.fragment ||
        hash !== (yield { kind: "digest", value: JSON.stringify(value) })
      )
        fail("Invalid legacy prefix");
      if (value.fragment) {
        if (
          !object(value.fragment) ||
          typeof value.fragment.id !== "string" ||
          !integer(value.fragment.index) ||
          !integer(value.fragment.total) ||
          value.fragment.total < 2 ||
          value.fragment.total > 256 ||
          value.fragment.index >= value.fragment.total ||
          typeof value.fragment.data !== "string" ||
          value.fragment.data.length > Math.ceil(CHUNK_SIZE / 3) * 4
        )
          fail("Invalid legacy fragment");
        const part = value.fragment as unknown as { id: string; total: number; index: number };
        if (
          (!legacyGroup && part.index !== 0) ||
          (legacyGroup &&
            (part.id !== legacyGroup.id ||
              part.total !== legacyGroup.total ||
              part.index !== legacyGroup.index + 1))
        )
          fail("Interrupted legacy fragment");
        legacyGroup = part;
        if (part.index === part.total - 1) {
          legacyGroup = undefined;
          committed = current;
        }
      } else {
        if (legacyGroup || !object(value.event) || typeof value.event.type !== "string")
          fail("Invalid legacy event");
        committed = current;
      }
      continue;
    }
    yield { kind: "parse", text: line.text, maxBytes: RECORD_LIMIT, unique: true };
    if (value.recordVersion !== 2)
      throw new StorageFailure("unsupported", "Unknown record version");
    if (
      (yield { kind: "canonical", value: raw }) !== line.text ||
      hash !== (yield { kind: "digestCanonical", value }) ||
      legacyGroup
    )
      fail("Invalid canonical v2 record");
    const common = ["recordVersion", "sequence", "previousHash", "hash", "kind"];
    if (value.kind === "format_transition") {
      keys(raw, [...common, "transition"]);
      if (transition || pending || group || !object(value.transition))
        fail("Invalid format transition");
      keys(value.transition, [
        "id",
        "epoch",
        "from",
        "to",
        "priorThrough",
        "headerPin",
        "initialControlEffect",
      ]);
      const t = value.transition;
      if (
        !uuid(t.id) ||
        !uuid(t.epoch) ||
        t.from !== 1 ||
        t.to !== 2 ||
        t.priorThrough !== token(identity, committed) ||
        t.headerPin !== pin ||
        !hex(t.initialControlEffect)
      )
        fail("Invalid transition binding");
      transition = t;
      effect = t.initialControlEffect;
      committed = current;
      continue;
    }
    if (!transition) fail("V2 record without format transition");
    if (value.kind === "tx_begin") {
      keys(raw, [...common, "tx"]);
      if (pending || group || !object(value.tx)) fail("Overlapping control transaction");
      keys(value.tx, [
        "id",
        "eventId",
        "scope",
        "beforeRevision",
        "afterRevision",
        "beforeEffect",
        "afterEffect",
        "projectionDigest",
        "hasDisplayEvent",
        "plannedPreparedRecords",
      ]);
      const b = value.tx;
      validateScope(b.scope);
      if (
        !uuid(b.id) ||
        !eventId(b.eventId) ||
        !integer(b.beforeRevision) ||
        !integer(b.afterRevision) ||
        b.afterRevision !== b.beforeRevision + 1 ||
        !hex(b.beforeEffect) ||
        !hex(b.afterEffect) ||
        !hex(b.projectionDigest) ||
        typeof b.hasDisplayEvent !== "boolean" ||
        !integer(b.plannedPreparedRecords) ||
        b.plannedPreparedRecords > 256 ||
        (b.hasDisplayEvent ? b.plannedPreparedRecords < 1 : b.plannedPreparedRecords !== 0) ||
        b.beforeEffect !== effect ||
        (latestControl && b.beforeRevision < latestControl.revision)
      )
        fail("Invalid transaction begin");
      pending = {
        begin: b as unknown as Begin,
        cursor: token(identity, current),
        bindingOffset: line.start,
        count: 0,
      };
      continue;
    }
    if (value.kind === "tx_commit") {
      keys(raw, [...common, "tx"]);
      if (!pending || group || !object(value.tx))
        fail("Commit without complete prepared transaction");
      keys(value.tx, [
        "id",
        "eventId",
        "begin",
        "preparedThrough",
        "projectionDigest",
        "afterRevision",
        "afterEffect",
      ]);
      const c = value.tx as unknown as Commit;
      const b = pending.begin;
      if (
        c.id !== b.id ||
        c.eventId !== b.eventId ||
        c.begin !== pending.cursor ||
        c.preparedThrough !== (pending.prepared ?? pending.cursor) ||
        c.projectionDigest !== b.projectionDigest ||
        c.afterRevision !== b.afterRevision ||
        c.afterEffect !== b.afterEffect ||
        pending.count !== b.plannedPreparedRecords ||
        b.hasDisplayEvent !== !!pending.prepared
      )
        fail("Transaction commit binding failed");
      if (
        !b.hasDisplayEvent &&
        b.projectionDigest !==
          (yield { kind: "projection", scope: b.scope, event: null, effect: b.afterEffect })
      )
        fail("Invalid state-only projection");
      yield {
        kind: "add",
        eventId: b.eventId,
        projection: b.projectionDigest,
        receipt: {
          sequence: current.sequence,
          offset: current.offset,
          bindingOffset: pending.bindingOffset,
        },
      };
      latestControl = {
        txId: b.id,
        eventId: b.eventId,
        revision: b.afterRevision,
        effectDigest: b.afterEffect,
      };
      effect = b.afterEffect;
      pending = undefined;
      committed = current;
      continue;
    }
    if (value.kind !== "event" && value.kind !== "fragment")
      throw new StorageFailure("unsupported", "Unknown v2 record kind");
    keys(raw, [...common, "eventId", "scope", "projectionDigest", value.kind], ["txId"]);
    const scope = validateScope(value.scope);
    if (
      !eventId(value.eventId) ||
      !hex(value.projectionDigest) ||
      (value.txId !== undefined && !uuid(value.txId))
    )
      fail("Invalid event binding");
    const binding: Binding = {
      eventId: value.eventId,
      scope,
      projectionDigest: value.projectionDigest,
      ...(value.txId ? { txId: value.txId as string } : {}),
    };
    if (
      pending
        ? binding.txId !== pending.begin.id ||
          binding.eventId !== pending.begin.eventId ||
          binding.projectionDigest !== pending.begin.projectionDigest ||
          (yield { kind: "canonical", value: scope }) !==
            (yield { kind: "canonical", value: pending.begin.scope }) ||
          pending.prepared
        : binding.txId !== undefined
    )
      fail("Prepared output authority mismatch");
    if (pending) pending.count++;
    let event: RawObject | undefined;
    let bindingOffset = line.start;
    if (value.kind === "event") {
      if (
        group ||
        !object(value.event) ||
        !text(value.event.type) ||
        Buffer.byteLength(yield { kind: "canonical", value: value.event }) > CHUNK_SIZE
      )
        fail("Invalid whole event");
      event = value.event;
    } else {
      if (!object(value.fragment)) fail("Invalid fragment");
      keys(value.fragment, ["id", "index", "total", "eventBytes", "eventDigest", "data"]);
      const part = value.fragment as unknown as Fragment;
      if (
        !uuid(part.id) ||
        !integer(part.index) ||
        !integer(part.total) ||
        part.total < 2 ||
        part.total > 256 ||
        part.index >= part.total ||
        !integer(part.eventBytes) ||
        part.eventBytes <= CHUNK_SIZE ||
        part.eventBytes > EVENT_LIMIT ||
        !hex(part.eventDigest) ||
        typeof part.data !== "string" ||
        part.data.length > Math.ceil(CHUNK_SIZE / 3) * 4
      )
        fail("Invalid fragment bounds");
      const chunk = Buffer.from(part.data, "base64");
      if (
        part.total !== Math.ceil(part.eventBytes / CHUNK_SIZE) ||
        chunk.length !==
          (part.index === part.total - 1
            ? part.eventBytes - CHUNK_SIZE * (part.total - 1)
            : CHUNK_SIZE) ||
        chunk.toString("base64") !== part.data
      )
        fail("Invalid base64 fragment");
      if (!group) {
        if (part.index !== 0) fail("Missing fragment beginning");
        group = { binding, fragment: part, chunks: [], bytes: 0, start: line.start };
      } else if (
        (yield { kind: "canonical", value: binding }) !==
          (yield { kind: "canonical", value: group.binding }) ||
        part.id !== group.fragment.id ||
        part.total !== group.fragment.total ||
        part.eventBytes !== group.fragment.eventBytes ||
        part.eventDigest !== group.fragment.eventDigest ||
        part.index !== group.fragment.index + 1
      )
        fail("Fragment binding continuity failed");
      group.fragment = part;
      group.bytes += chunk.length;
      if (group.bytes > EVENT_LIMIT) fail("Fragment assembly bound");
      group.chunks.push(chunk);
      if (part.index !== part.total - 1) continue;
      const bytes = Buffer.concat(group.chunks, group.bytes);
      if (
        bytes.length !== part.eventBytes ||
        (yield { kind: "digest", value: bytes }) !== part.eventDigest
      )
        fail("Fragment event digest failed");
      const decoded = yield { kind: "decode", bytes };
      const parsed = yield { kind: "parse", text: decoded, maxBytes: EVENT_LIMIT, unique: true };
      if (!object(parsed) || !text(parsed.type)) fail("Invalid assembled event");
      event = parsed;
      bindingOffset = group.start;
      group = undefined;
    }
    if (
      (yield {
        kind: "projection",
        scope,
        event,
        effect: pending ? pending.begin.afterEffect : null,
      }) !== binding.projectionDigest
    )
      fail("Public projection digest mismatch");
    if (pending) pending.prepared = token(identity, current);
    else {
      yield {
        kind: "add",
        eventId: binding.eventId,
        projection: binding.projectionDigest,
        receipt: { sequence: current.sequence, offset: current.offset, bindingOffset },
      };
      committed = current;
    }
  }
  if (pending || group || legacyGroup || current.offset !== size)
    fail("Unresolved WAL/fragment/transition tail is incomplete; never truncate");
  const verified = {
    identity,
    pin,
    start,
    head: committed,
    fileStamp: beforeStamp,
    transition,
    latestControl,
    uncommittedLegacyTail: false,
  };
  yield* verifyStateSteps(decoded, verified);
  return verified;
}

export function verifyState(decoded: DecodedState, verified: VerifiedJournal): void {
  const steps = verifyStateSteps(decoded, verified);
  let next = steps.next();
  while (!next.done) {
    if (next.value.kind === "line" || next.value.kind === "add")
      fail("Invalid state-only verification step");
    next = steps.next(evaluateJournalStep(next.value));
  }
}
export function* verifyStateSteps(
  decoded: DecodedState,
  verified: VerifiedJournal,
): JournalSteps<void> {
  const { transition, pin, latestControl } = verified;
  if (transition) {
    if (
      !decoded.format ||
      !decoded.control ||
      decoded.control.pending ||
      decoded.format.transitionId !== transition.id ||
      decoded.format.epoch !== transition.epoch ||
      decoded.format.headerPin !== pin ||
      decoded.format.v1Through !== transition.priorThrough
    )
      fail("Format transition/state incomplete");
    const effect = latestControl?.effectDigest ?? transition.initialControlEffect;
    if (
      decoded.control.effectDigest !== effect ||
      (yield {
        kind: "digestCanonical",
        value: (decoded.state as unknown as RawObject).goalLifecycle ?? null,
      }) !== effect ||
      (yield { kind: "canonical", value: decoded.control.lastCommitted ?? null }) !==
        (yield { kind: "canonical", value: latestControl ?? null }) ||
      (latestControl && (decoded.state.stateRevision ?? -1) < latestControl.revision)
    )
      fail("Latest control watermark/state mismatch");
  } else if (decoded.format || decoded.control) fail("Versioned state without transition");
}
