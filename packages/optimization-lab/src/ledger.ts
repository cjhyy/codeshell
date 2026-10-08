import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import {
  HashSchema,
  ResourceAllocationSchema,
  type ResourceAllocation,
} from "./contracts/experiment.js";
import { assertGrantActive, type BudgetGrant } from "./contracts/grant.js";
import {
  ExperimentStore,
  ExperimentIdSchema,
  readBoundedFile,
  writeAtomicFile,
  type LeaseFence,
} from "./store.js";

export type CallRole = "baseline" | "optimizer" | "screening" | "final";
const RoleSchema = z.enum(["baseline", "optimizer", "screening", "final"]);
const finite = z.number().finite().nonnegative();
const integer = z.number().int().nonnegative().safe();
const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);

export const LedgerUsageSchema = z
  .object({
    inputTokens: integer.nullable(),
    outputTokens: integer.nullable(),
    cacheReadTokens: integer.nullable(),
    cacheWriteTokens: integer.nullable(),
    reasoningTokens: integer.nullable(),
    reasoningIncludedInOutput: z.boolean(),
  })
  .strict();
export type LedgerUsage = z.infer<typeof LedgerUsageSchema>;
export interface BeginOperationInput {
  operationId: string;
  role: CallRole;
  timeoutMs: number;
  maxRequests: number;
  maxOutputTokens: number;
  finalPhase?: boolean;
}
export interface OperationReservation extends BeginOperationInput {
  owner: string;
  generation: number;
  grantRevision: number;
  startedAt: number;
  deadlineAt: number;
  status: "active" | "settled" | "unknown";
  elapsedMs: number | null;
  attemptIds: string[];
}
export interface AttemptReservation {
  owner: string;
  generation: number;
  grantRevision: number;
  attemptId: string;
  operationId: string;
  role: CallRole;
  estimatedTokens: number;
  estimatedCostUsd: number | null;
  status: "reserved" | "dispatched" | "settled" | "unknown";
  usage: LedgerUsage | null;
  actualCostUsd: number | null;
  responseModel: string | null;
}
export interface ReserveAttemptInput {
  operationId: string;
  attemptId?: string;
  estimatedTokens: number;
  estimatedCostUsd: number | null;
}
export interface SettleAttemptInput {
  attemptId: string;
  usage: LedgerUsage | null;
  responseModel: string | null;
  actualCostUsd: number | null;
}
export interface LedgerTotals {
  requests: number;
  reportedTokens: number;
  reservedTokens: number;
  unknownTokens: number;
  reportedCostUsd: number;
  reservedCostUsd: number;
  unknownCostUsd: number;
  unknownCostAttempts: number;
  reportedExecutionMs: number;
  reservedExecutionMs: number;
  unknownExecutionMs: number;
}
export interface LedgerSummary {
  sequence: number;
  headHash: string | null;
  totals: LedgerTotals;
  finalAllocation: ResourceAllocation;
  operations: Record<string, OperationReservation>;
  attempts: Record<string, AttemptReservation>;
  estimateInvalid: boolean;
}

const EventSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: ExperimentIdSchema,
    planHash: HashSchema,
    sequence: z.number().int().positive().safe(),
    eventId: z.string().uuid(),
    kind: z.enum([
      "operation_begin",
      "reserve",
      "dispatch",
      "settle",
      "unknown",
      "operation_finish",
      "operation_unknown",
      "final_allocation",
    ]),
    at: integer,
    owner: z.string().min(1).max(128),
    generation: z.number().int().positive().safe(),
    grantRevision: z.number().int().positive().safe(),
    operationId: identity.nullable(),
    attemptId: identity.nullable(),
    role: RoleSchema.nullable(),
    payload: z.record(z.unknown()),
    previousHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type LedgerEvent = z.infer<typeof EventSchema>;
const BeginPayloadSchema = z
  .object({
    timeoutMs: integer.refine((n) => n > 0),
    maxRequests: integer.refine((n) => n > 0),
    maxOutputTokens: integer.refine((n) => n > 0),
    finalPhase: z.boolean(),
    deadlineAt: integer,
  })
  .strict();
const ReservePayloadSchema = z
  .object({ estimatedTokens: finite, estimatedCostUsd: finite.nullable() })
  .strict();
const SettlePayloadSchema = z
  .object({
    usage: LedgerUsageSchema,
    responseModel: z.string().min(1).max(256).nullable(),
    actualCostUsd: finite.nullable(),
  })
  .strict();
const UnknownPayloadSchema = z
  .object({
    reason: z.string().min(1).max(256),
    usage: LedgerUsageSchema.nullable().optional(),
    responseModel: z.string().min(1).max(256).nullable().optional(),
  })
  .strict();
const FinishPayloadSchema = z.object({ elapsedMs: integer }).strict();
const empty = z.object({}).strict();
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const LedgerHeadSchema = z
  .object({ schemaVersion: z.literal(1), sequence: integer, hash: HashSchema.nullable() })
  .strict();

function checkedSum(...values: number[]): number {
  const result = values.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER)
    throw new Error("optimization_lab: accounting overflow");
  return result;
}
function usageTokens(usage: LedgerUsage): number | null {
  if (
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    (!usage.reasoningIncludedInOutput && usage.reasoningTokens === null)
  )
    return null;
  // Cache counters are subcategories of input, never additional input tokens.
  if ((usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > usage.inputTokens)
    throw new Error("optimization_lab: cache usage exceeds input usage");
  if (usage.reasoningIncludedInOutput && (usage.reasoningTokens ?? 0) > usage.outputTokens)
    throw new Error("optimization_lab: reasoning usage exceeds output usage");
  return checkedSum(
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningIncludedInOutput ? 0 : (usage.reasoningTokens ?? 0),
  );
}
const zeroTotals = (): LedgerTotals => ({
  requests: 0,
  reportedTokens: 0,
  reservedTokens: 0,
  unknownTokens: 0,
  reportedCostUsd: 0,
  reservedCostUsd: 0,
  unknownCostUsd: 0,
  unknownCostAttempts: 0,
  reportedExecutionMs: 0,
  reservedExecutionMs: 0,
  unknownExecutionMs: 0,
});

function summarize(events: LedgerEvent[], initialFinal: ResourceAllocation): LedgerSummary {
  const operations: Record<string, OperationReservation> = Object.create(null);
  const attempts: Record<string, AttemptReservation> = Object.create(null);
  let finalAllocation = { ...initialFinal };
  let estimateInvalid = false;
  for (const event of events) {
    if (event.kind === "final_allocation") {
      if (event.operationId !== null || event.attemptId !== null || event.role !== null)
        throw new Error("optimization_lab: invalid allocation event identity");
      finalAllocation = ResourceAllocationSchema.parse(event.payload);
      continue;
    }
    if (event.operationId === null || event.role === null)
      throw new Error("optimization_lab: missing operation identity");
    if (event.kind === "operation_begin") {
      if (operations[event.operationId] || event.attemptId !== null)
        throw new Error("optimization_lab: duplicate operation");
      const payload = BeginPayloadSchema.parse(event.payload);
      if (
        payload.deadlineAt !== event.at + payload.timeoutMs ||
        payload.finalPhase !== (event.role === "final")
      )
        throw new Error("optimization_lab: inconsistent operation deadline or role");
      operations[event.operationId] = {
        operationId: event.operationId,
        role: event.role,
        owner: event.owner,
        generation: event.generation,
        grantRevision: event.grantRevision,
        ...payload,
        startedAt: event.at,
        status: "active",
        elapsedMs: null,
        attemptIds: [],
      };
      if (payload.finalPhase) {
        finalAllocation.executionMs -= payload.timeoutMs;
        if (finalAllocation.executionMs < 0)
          throw new Error("optimization_lab: final execution allocation underflow");
      }
      continue;
    }
    const operation = operations[event.operationId];
    if (!operation || operation.role !== event.role || operation.status !== "active")
      throw new Error("optimization_lab: event has no active operation");
    if (
      !["unknown", "operation_unknown"].includes(event.kind) &&
      (event.owner !== operation.owner || event.generation !== operation.generation)
    )
      throw new Error("optimization_lab: operation writer generation mismatch");
    if (event.kind === "operation_finish" || event.kind === "operation_unknown") {
      if (
        event.attemptId !== null ||
        operation.attemptIds.some((id) => ["reserved", "dispatched"].includes(attempts[id].status))
      )
        throw new Error("optimization_lab: operation has unsettled attempts");
      // A final trial with no reserved HTTP attempt is still in the frozen
      // denominator. Return its future window to the ring, while a crash's
      // unknown window continues to count as spent separately.
      if (operation.finalPhase && operation.attemptIds.length === 0)
        finalAllocation.executionMs = checkedSum(finalAllocation.executionMs, operation.timeoutMs);
      if (event.kind === "operation_finish") {
        operation.elapsedMs = FinishPayloadSchema.parse(event.payload).elapsedMs;
        if (operation.elapsedMs > operation.timeoutMs) estimateInvalid = true;
        operation.status = "settled";
      } else {
        UnknownPayloadSchema.parse(event.payload);
        operation.status = "unknown";
      }
      continue;
    }
    if (event.attemptId === null) throw new Error("optimization_lab: missing attempt identity");
    if (event.kind === "reserve") {
      const payload = ReservePayloadSchema.parse(event.payload);
      if (attempts[event.attemptId] || operation.attemptIds.length >= operation.maxRequests)
        throw new Error("optimization_lab: duplicate or excess attempt");
      attempts[event.attemptId] = {
        attemptId: event.attemptId,
        owner: event.owner,
        generation: event.generation,
        grantRevision: event.grantRevision,
        operationId: event.operationId,
        role: event.role,
        ...payload,
        status: "reserved",
        usage: null,
        actualCostUsd: null,
        responseModel: null,
      };
      operation.attemptIds.push(event.attemptId);
      if (operation.finalPhase) {
        finalAllocation.requests -= 1;
        finalAllocation.estimatedTokens -= payload.estimatedTokens;
        if (finalAllocation.estimatedCostUsd !== null && payload.estimatedCostUsd !== null)
          finalAllocation.estimatedCostUsd -= payload.estimatedCostUsd;
        if (
          finalAllocation.requests < 0 ||
          finalAllocation.estimatedTokens < 0 ||
          (finalAllocation.estimatedCostUsd !== null && finalAllocation.estimatedCostUsd < -1e-12)
        )
          throw new Error("optimization_lab: final allocation underflow");
        if (finalAllocation.estimatedCostUsd !== null)
          finalAllocation.estimatedCostUsd = Math.max(0, finalAllocation.estimatedCostUsd);
      }
      continue;
    }
    const attempt = attempts[event.attemptId];
    if (!attempt || attempt.operationId !== event.operationId)
      throw new Error("optimization_lab: unknown attempt");
    if (event.kind === "dispatch") {
      empty.parse(event.payload);
      if (attempt.status !== "reserved")
        throw new Error("optimization_lab: invalid dispatch transition");
      attempt.status = "dispatched";
    } else if (event.kind === "unknown") {
      const payload = UnknownPayloadSchema.parse(event.payload);
      if (!["reserved", "dispatched"].includes(attempt.status))
        throw new Error("optimization_lab: invalid unknown transition");
      attempt.status = "unknown";
      attempt.usage = payload.usage ?? null;
      attempt.responseModel = payload.responseModel ?? null;
    } else if (event.kind === "settle") {
      if (attempt.status !== "dispatched")
        throw new Error("optimization_lab: invalid settle transition");
      const payload = SettlePayloadSchema.parse(event.payload);
      const tokens = usageTokens(payload.usage);
      if (tokens === null) throw new Error("optimization_lab: incomplete usage must be unknown");
      attempt.status = "settled";
      attempt.usage = payload.usage;
      attempt.actualCostUsd = payload.actualCostUsd;
      attempt.responseModel = payload.responseModel;
      if (
        tokens > attempt.estimatedTokens ||
        (payload.actualCostUsd !== null &&
          attempt.estimatedCostUsd !== null &&
          payload.actualCostUsd > attempt.estimatedCostUsd)
      )
        estimateInvalid = true;
    }
  }
  const totals = zeroTotals();
  for (const attempt of Object.values(attempts)) {
    totals.requests = checkedSum(totals.requests, 1);
    if (attempt.status === "settled") {
      totals.reportedTokens = checkedSum(totals.reportedTokens, usageTokens(attempt.usage!)!);
      if (attempt.actualCostUsd === null) {
        totals.unknownCostAttempts += 1;
        totals.unknownCostUsd = checkedSum(totals.unknownCostUsd, attempt.estimatedCostUsd ?? 0);
      } else totals.reportedCostUsd = checkedSum(totals.reportedCostUsd, attempt.actualCostUsd);
    } else if (attempt.status === "unknown") {
      totals.unknownTokens = checkedSum(totals.unknownTokens, attempt.estimatedTokens);
      totals.unknownCostUsd = checkedSum(totals.unknownCostUsd, attempt.estimatedCostUsd ?? 0);
      if (attempt.estimatedCostUsd === null) totals.unknownCostAttempts += 1;
    } else {
      totals.reservedTokens = checkedSum(totals.reservedTokens, attempt.estimatedTokens);
      totals.reservedCostUsd = checkedSum(totals.reservedCostUsd, attempt.estimatedCostUsd ?? 0);
      if (attempt.estimatedCostUsd === null) totals.unknownCostAttempts += 1;
    }
  }
  for (const operation of Object.values(operations)) {
    if (operation.status === "settled")
      totals.reportedExecutionMs = checkedSum(totals.reportedExecutionMs, operation.elapsedMs!);
    else if (operation.status === "unknown")
      totals.unknownExecutionMs = checkedSum(totals.unknownExecutionMs, operation.timeoutMs);
    else totals.reservedExecutionMs = checkedSum(totals.reservedExecutionMs, operation.timeoutMs);
  }
  return {
    sequence: events.length,
    headHash: events.at(-1)?.hash ?? null,
    totals,
    operations,
    attempts,
    finalAllocation,
    estimateInvalid,
  };
}

/** Durable request accounting. Every external side effect follows reserve + dispatch fsync. */
export class ExperimentLedger {
  constructor(
    readonly store: ExperimentStore,
    readonly now: () => number = Date.now,
  ) {}

  private readEvents(directory: string, planHash: string): LedgerEvent[] {
    const path = join(directory, "ledger.jsonl");
    const text = readBoundedFile(path, MAX_LEDGER_BYTES);
    if (text === undefined) throw new Error("optimization_lab: durable ledger missing");
    const headPath = join(directory, "ledger-head.json");
    const headText = readBoundedFile(headPath, 4096);
    if (headText === undefined) throw new Error("optimization_lab: durable ledger head missing");
    const head = LedgerHeadSchema.parse(JSON.parse(headText));
    const lastNewline = text.lastIndexOf("\n");
    const prefix = text.endsWith("\n") ? text : text.slice(0, lastNewline + 1);
    const tail = text.endsWith("\n") ? "" : text.slice(lastNewline + 1);
    const events: LedgerEvent[] = [];
    const ids = new Set<string>();
    for (const line of prefix.split("\n").slice(0, -1)) {
      let event: LedgerEvent;
      try {
        event = EventSchema.parse(JSON.parse(line));
      } catch {
        throw new Error("optimization_lab: corrupt ledger event");
      }
      const { hash, ...content } = event;
      if (
        event.experimentId !== basename(directory) ||
        event.planHash !== planHash ||
        event.sequence !== events.length + 1 ||
        event.previousHash !== (events.at(-1)?.hash ?? null) ||
        sha256Hex(canonicalJson(content)) !== hash ||
        ids.has(event.eventId)
      )
        throw new Error("optimization_lab: broken ledger hash chain");
      ids.add(event.eventId);
      events.push(event);
    }
    if (
      head.sequence > events.length ||
      (head.sequence === 0 ? head.hash !== null : events[head.sequence - 1]?.hash !== head.hash)
    )
      throw new Error("optimization_lab: ledger rolled back past durable head");
    if (tail) {
      // Preserve rejected tail evidence before replacing only the incomplete tail.
      const repairDirectory = join(directory, "ledger-repairs");
      try {
        mkdirSync(repairDirectory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const repairInfo = lstatSync(repairDirectory);
      if (repairInfo.isSymbolicLink() || !repairInfo.isDirectory())
        throw new Error("optimization_lab: unsafe ledger repair directory");
      const evidence = JSON.stringify({
        schemaVersion: 1,
        originalHash: sha256Hex(text),
        retainedHash: sha256Hex(prefix),
        discardedTail: tail,
      });
      const evidencePath = join(repairDirectory, `${sha256Hex(evidence)}.json`);
      const previous = readBoundedFile(evidencePath);
      if (previous !== undefined && previous !== evidence)
        throw new Error("optimization_lab: ledger repair evidence conflict");
      if (previous === undefined) writeAtomicFile(evidencePath, evidence);
      writeAtomicFile(path, prefix, MAX_LEDGER_BYTES);
    }
    // Appending the event precedes updating this head. A crash in between may
    // conservatively recover an ahead chain, never silently discard it.
    if (head.sequence < events.length)
      writeAtomicFile(
        headPath,
        canonicalJson({ schemaVersion: 1, sequence: events.length, hash: events.at(-1)!.hash }),
      );
    return events;
  }

  private append(
    directory: string,
    events: LedgerEvent[],
    fence: LeaseFence,
    grant: BudgetGrant,
    input: Pick<LedgerEvent, "kind" | "operationId" | "attemptId" | "role" | "payload">,
    at = this.now(),
  ): LedgerEvent {
    const content = {
      schemaVersion: 1 as const,
      experimentId: basename(directory),
      planHash: grant.planHash,
      sequence: events.length + 1,
      eventId: randomUUID(),
      at,
      owner: fence.owner,
      generation: fence.generation,
      grantRevision: grant.revision,
      previousHash: events.at(-1)?.hash ?? null,
      ...input,
    };
    const event = EventSchema.parse({ ...content, hash: sha256Hex(canonicalJson(content)) });
    const line = `${canonicalJson(event)}\n`;
    if (
      Buffer.byteLength(events.map((entry) => `${canonicalJson(entry)}\n`).join(""), "utf8") +
        Buffer.byteLength(line, "utf8") >
      MAX_LEDGER_BYTES
    )
      throw new Error("optimization_lab: ledger capacity exceeded");
    const fd = openSync(
      join(directory, "ledger.jsonl"),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, line, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    writeAtomicFile(
      join(directory, "ledger-head.json"),
      canonicalJson({ schemaVersion: 1, sequence: event.sequence, hash: event.hash }),
    );
    events.push(event);
    return event;
  }

  private context(
    id: string,
    fence: LeaseFence,
    fn: (
      directory: string,
      events: LedgerEvent[],
      summary: LedgerSummary,
      grant: BudgetGrant,
      now: number,
    ) => unknown,
    requireActive = true,
  ): any {
    return this.store.withLock(id, (directory) => {
      const now = this.now();
      this.store.assertFenceUnlocked(directory, fence, now);
      const snapshot = this.store.readUnlocked(directory, id);
      if (!snapshot.grant) throw new Error("optimization_lab: experiment is not authorized");
      if (requireActive) {
        assertGrantActive(snapshot.grant, snapshot.plan.planHash, now);
        if (snapshot.state.stopRequested) throw new Error("optimization_lab: stop requested");
      }
      const events = this.readEvents(directory, snapshot.plan.planHash);
      const summary = summarize(events, snapshot.plan.finalAllocation);
      return fn(directory, events, summary, snapshot.grant, now);
    });
  }

  summary(id: string): LedgerSummary {
    return this.store.withLock(id, (directory) => {
      const snapshot = this.store.readUnlocked(directory, id);
      return summarize(
        this.readEvents(directory, snapshot.plan.planHash),
        snapshot.plan.finalAllocation,
      );
    });
  }

  private assertBudget(summary: LedgerSummary, grant: BudgetGrant): void {
    if (summary.estimateInvalid)
      throw new Error("optimization_lab: estimate invalidated; new calls stopped");
    const { totals, finalAllocation } = summary;
    if (checkedSum(totals.requests, finalAllocation.requests) > grant.maxRequests)
      throw new Error("optimization_lab: request budget exhausted");
    if (
      checkedSum(
        totals.reportedExecutionMs,
        totals.reservedExecutionMs,
        totals.unknownExecutionMs,
        finalAllocation.executionMs,
      ) > grant.maxExecutionMs
    )
      throw new Error("optimization_lab: execution budget exhausted");
    if (
      grant.maxEstimatedTokens !== null &&
      checkedSum(
        totals.reportedTokens,
        totals.reservedTokens,
        totals.unknownTokens,
        finalAllocation.estimatedTokens,
      ) > grant.maxEstimatedTokens
    )
      throw new Error("optimization_lab: token estimate budget exhausted");
    if (grant.maxEstimatedCostUsd !== null) {
      if (totals.unknownCostAttempts > 0 || finalAllocation.estimatedCostUsd === null)
        throw new Error("optimization_lab: unknown cost cannot satisfy cost threshold");
      if (
        checkedSum(
          totals.reportedCostUsd,
          totals.reservedCostUsd,
          totals.unknownCostUsd,
          finalAllocation.estimatedCostUsd,
        ) > grant.maxEstimatedCostUsd
      )
        throw new Error("optimization_lab: cost estimate budget exhausted");
    }
  }

  beginOperation(id: string, fence: LeaseFence, input: BeginOperationInput): OperationReservation {
    identity.parse(input.operationId);
    RoleSchema.parse(input.role);
    return this.context(id, fence, (directory, events, summary, grant, now) => {
      const plan = this.store.readUnlocked(directory, id).plan;
      const limits = input.role === "optimizer" ? plan.bounds.optimization : plan.bounds.trial;
      if (
        input.timeoutMs !== limits.timeoutMs ||
        input.maxRequests !== limits.maxRequests ||
        input.maxOutputTokens !== limits.maxOutputTokens
      )
        throw new Error("optimization_lab: operation limits differ from frozen plan");
      const existing = summary.operations[input.operationId];
      if (existing) {
        if (
          existing.role !== input.role ||
          existing.timeoutMs !== input.timeoutMs ||
          existing.maxRequests !== input.maxRequests ||
          existing.maxOutputTokens !== input.maxOutputTokens ||
          Boolean(existing.finalPhase) !== (input.finalPhase ?? input.role === "final")
        )
          throw new Error("optimization_lab: operation identity conflict");
        return existing; // Idempotent identity never reopens or resets deadline.
      }
      if (Object.values(summary.operations).some((operation) => operation.status === "active"))
        throw new Error("optimization_lab: another operation is active");
      const payload = BeginPayloadSchema.parse({
        timeoutMs: input.timeoutMs,
        maxRequests: input.maxRequests,
        maxOutputTokens: input.maxOutputTokens,
        finalPhase: input.finalPhase ?? input.role === "final",
        deadlineAt: now + input.timeoutMs,
      });
      if (payload.finalPhase !== (input.role === "final"))
        throw new Error("optimization_lab: final role mismatch");
      const requiredFinalWindow = payload.finalPhase
        ? summary.finalAllocation.executionMs
        : payload.timeoutMs + summary.finalAllocation.executionMs;
      if (now + requiredFinalWindow > Date.parse(grant.expiresAt))
        throw new Error("optimization_lab: insufficient time before grant expiry");
      if (payload.finalPhase && summary.finalAllocation.executionMs < payload.timeoutMs)
        throw new Error("optimization_lab: final execution allocation insufficient");
      const hypothetical: LedgerEvent = {
        schemaVersion: 1,
        experimentId: id,
        planHash: grant.planHash,
        sequence: events.length + 1,
        eventId: randomUUID(),
        kind: "operation_begin",
        at: now,
        owner: fence.owner,
        generation: fence.generation,
        grantRevision: grant.revision,
        operationId: input.operationId,
        attemptId: null,
        role: input.role,
        payload,
        previousHash: summary.headHash,
        hash: "0".repeat(64),
      };
      this.assertBudget(
        summarize(
          [...events, hypothetical],
          this.store.readUnlocked(directory, id).plan.finalAllocation,
        ),
        grant,
      );
      this.append(
        directory,
        events,
        fence,
        grant,
        {
          kind: "operation_begin",
          operationId: input.operationId,
          attemptId: null,
          role: input.role,
          payload,
        },
        now,
      );
      return summarize(events, this.store.readUnlocked(directory, id).plan.finalAllocation)
        .operations[input.operationId];
    });
  }

  reserveAttempt(
    id: string,
    fence: LeaseFence,
    input: ReserveAttemptInput,
  ): AttemptReservation & { deadlineAt: number } {
    identity.parse(input.operationId);
    const attemptId = identity.parse(input.attemptId ?? randomUUID());
    return this.context(id, fence, (directory, events, summary, grant, now) => {
      if (summary.attempts[attemptId])
        throw new Error("optimization_lab: attempt identity already used");
      const operation = summary.operations[input.operationId];
      if (
        !operation ||
        operation.status !== "active" ||
        now >= operation.deadlineAt ||
        operation.owner !== fence.owner ||
        operation.generation !== fence.generation
      )
        throw new Error("optimization_lab: operation missing, closed or expired");
      const payload = ReservePayloadSchema.parse({
        estimatedTokens: input.estimatedTokens,
        estimatedCostUsd: input.estimatedCostUsd,
      });
      const hypothetical: LedgerEvent = {
        schemaVersion: 1,
        experimentId: id,
        planHash: grant.planHash,
        sequence: events.length + 1,
        eventId: randomUUID(),
        kind: "reserve",
        at: now,
        owner: fence.owner,
        generation: fence.generation,
        grantRevision: grant.revision,
        operationId: operation.operationId,
        attemptId,
        role: operation.role,
        payload,
        previousHash: summary.headHash,
        hash: "0".repeat(64),
      };
      const initialFinal = this.store.readUnlocked(directory, id).plan.finalAllocation;
      this.assertBudget(summarize([...events, hypothetical], initialFinal), grant);
      this.append(
        directory,
        events,
        fence,
        grant,
        {
          kind: "reserve",
          operationId: operation.operationId,
          attemptId,
          role: operation.role,
          payload,
        },
        now,
      );
      return {
        ...summarize(events, initialFinal).attempts[attemptId],
        deadlineAt: Math.min(operation.deadlineAt, Date.parse(grant.expiresAt)),
      };
    });
  }

  dispatch(id: string, fence: LeaseFence, attemptId: string): void {
    this.context(id, fence, (directory, events, summary, grant, now) => {
      const attempt = summary.attempts[attemptId];
      const operation = attempt && summary.operations[attempt.operationId];
      if (
        !attempt ||
        attempt.status !== "reserved" ||
        !operation ||
        operation.status !== "active" ||
        now >= operation.deadlineAt ||
        operation.owner !== fence.owner ||
        operation.generation !== fence.generation
      )
        throw new Error("optimization_lab: attempt cannot dispatch");
      this.assertBudget(summary, grant);
      this.append(
        directory,
        events,
        fence,
        grant,
        {
          kind: "dispatch",
          operationId: attempt.operationId,
          attemptId,
          role: attempt.role,
          payload: {},
        },
        now,
      );
    });
  }

  settle(id: string, fence: LeaseFence, input: SettleAttemptInput): void {
    this.context(
      id,
      fence,
      (directory, events, summary, grant) => {
        const attempt = summary.attempts[input.attemptId];
        if (!attempt) throw new Error("optimization_lab: unknown attempt");
        if (attempt.status === "settled") {
          if (
            canonicalJson({
              usage: attempt.usage,
              responseModel: attempt.responseModel,
              actualCostUsd: attempt.actualCostUsd,
            }) !==
            canonicalJson({
              usage: input.usage,
              responseModel: input.responseModel,
              actualCostUsd: input.actualCostUsd,
            })
          )
            throw new Error("optimization_lab: conflicting duplicate settlement");
          return;
        }
        if (
          attempt.status !== "dispatched" ||
          attempt.owner !== fence.owner ||
          attempt.generation !== fence.generation
        )
          throw new Error("optimization_lab: attempt cannot settle");
        if (input.usage === null || usageTokens(LedgerUsageSchema.parse(input.usage)) === null) {
          this.append(directory, events, fence, grant, {
            kind: "unknown",
            operationId: attempt.operationId,
            attemptId: attempt.attemptId,
            role: attempt.role,
            payload: {
              reason: "usage_unavailable",
              usage: input.usage,
              responseModel: input.responseModel,
            },
          });
          return;
        }
        const payload = SettlePayloadSchema.parse(
          input.usage === null
            ? {}
            : {
                usage: input.usage,
                responseModel: input.responseModel,
                actualCostUsd: input.actualCostUsd,
              },
        );
        this.append(directory, events, fence, grant, {
          kind: "settle",
          operationId: attempt.operationId,
          attemptId: attempt.attemptId,
          role: attempt.role,
          payload,
        });
      },
      false,
    );
  }

  unknown(id: string, fence: LeaseFence, attemptId: string, reason = "outcome_unknown"): void {
    this.context(
      id,
      fence,
      (directory, events, summary, grant) => {
        const attempt = summary.attempts[attemptId];
        if (!attempt) throw new Error("optimization_lab: unknown attempt");
        if (["unknown", "settled"].includes(attempt.status)) return;
        const payload = UnknownPayloadSchema.parse({ reason });
        this.append(directory, events, fence, grant, {
          kind: "unknown",
          operationId: attempt.operationId,
          attemptId,
          role: attempt.role,
          payload,
        });
      },
      false,
    );
  }

  finishOperation(id: string, fence: LeaseFence, operationId: string, elapsedMs?: number): void {
    this.context(
      id,
      fence,
      (directory, events, summary, grant, now) => {
        const operation = summary.operations[operationId];
        if (!operation) throw new Error("optimization_lab: unknown operation");
        if (operation.status !== "active") return;
        if (operation.owner !== fence.owner || operation.generation !== fence.generation)
          throw new Error("optimization_lab: operation writer generation mismatch");
        if (
          operation.attemptIds.some((attemptId) =>
            ["reserved", "dispatched"].includes(summary.attempts[attemptId].status),
          )
        )
          throw new Error("optimization_lab: cannot finish in-flight operation");
        const payload = FinishPayloadSchema.parse({
          elapsedMs: elapsedMs ?? Math.max(0, now - operation.startedAt),
        });
        this.append(
          directory,
          events,
          fence,
          grant,
          { kind: "operation_finish", operationId, attemptId: null, role: operation.role, payload },
          now,
        );
      },
      false,
    );
  }

  /** New owner conservatively consumes full windows and reservations; never replays HTTP. */
  recoverUnknown(id: string, fence: LeaseFence): void {
    this.context(
      id,
      fence,
      (directory, events, summary, grant) => {
        for (const operation of Object.values(summary.operations)) {
          if (operation.status !== "active") continue;
          for (const attemptId of operation.attemptIds) {
            const attempt = summary.attempts[attemptId];
            if (["reserved", "dispatched"].includes(attempt.status))
              this.append(directory, events, fence, grant, {
                kind: "unknown",
                operationId: operation.operationId,
                attemptId,
                role: attempt.role,
                payload: { reason: "owner_interrupted" },
              });
          }
          this.append(directory, events, fence, grant, {
            kind: "operation_unknown",
            operationId: operation.operationId,
            attemptId: null,
            role: operation.role,
            payload: { reason: "owner_interrupted" },
          });
        }
      },
      false,
    );
  }

  /** Recompute final needs after freezing candidate; search cannot borrow these resources. */
  setFinalAllocation(id: string, fence: LeaseFence, allocation: ResourceAllocation): void {
    const payload = ResourceAllocationSchema.parse(allocation);
    this.context(id, fence, (directory, events, summary, grant, now) => {
      if (
        payload.requests !== summary.finalAllocation.requests ||
        payload.executionMs !== summary.finalAllocation.executionMs
      )
        throw new Error("optimization_lab: final denominator cannot change");
      const hypothetical: LedgerEvent = {
        schemaVersion: 1,
        experimentId: id,
        planHash: grant.planHash,
        sequence: events.length + 1,
        eventId: randomUUID(),
        kind: "final_allocation",
        at: now,
        owner: fence.owner,
        generation: fence.generation,
        grantRevision: grant.revision,
        operationId: null,
        attemptId: null,
        role: null,
        payload,
        previousHash: summary.headHash,
        hash: "0".repeat(64),
      };
      this.assertBudget(
        summarize(
          [...events, hypothetical],
          this.store.readUnlocked(directory, id).plan.finalAllocation,
        ),
        grant,
      );
      this.append(
        directory,
        events,
        fence,
        grant,
        { kind: "final_allocation", operationId: null, attemptId: null, role: null, payload },
        now,
      );
    });
  }
}
