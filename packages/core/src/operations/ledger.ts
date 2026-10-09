import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { getDefaultCredentialCipher, type EncryptionCipher } from "../credentials/cipher.js";
import { mutateJsonFile } from "../utils/file-mutex.js";
import { OperationRecoveryFiles } from "./recovery.js";
import type { OperationSessionOwner } from "./session-owner.js";

export const operationStates = [
  "planned",
  "running",
  "succeeded",
  "verified",
  "failed",
  "unknown",
  "blocked",
] as const;
export type OperationState = (typeof operationStates)[number];
export const operationErrors = [
  "transient",
  "stale_reference",
  "validation",
  "authentication",
  "permission",
  "unsupported",
  "postcondition_failed",
  "poll_pending",
  "cancelled",
] as const;
export type OperationError = (typeof operationErrors)[number];

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().regex(/^[a-z0-9_.-]{1,100}$/);
const reference = z.object({ id: z.string().regex(/^[a-zA-Z0-9_/-]{1,300}$/) }).strict();
const recordSchema = z
  .object({
    id: digest,
    owner: digest,
    fingerprint: digest,
    service: label,
    action: label,
    channel: label,
    state: z.enum(operationStates),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    attemptId: z.string().uuid().optional(),
    reference: reference.optional(),
    error: z.enum(operationErrors).optional(),
    verifiedAt: z.number().int().nonnegative().optional(),
    recovery: z.object({ prepared: digest, identity: digest.optional() }).strict().optional(),
    ownerIncarnation: digest.optional(),
    operatorResolution: z
      .object({
        id: z.string().uuid(),
        decision: z.literal("accept_uncertainty"),
        at: z.number().int().nonnegative(),
        reviewedRevision: digest,
      })
      .strict()
      .optional(),
  })
  .strict();
export type OperationReceipt = z.infer<typeof recordSchema>;
export type OperationReference = z.infer<typeof reference>;
const observationSchema = z
  .object({
    id: z.string().uuid(),
    at: z.number().int().nonnegative(),
    reviewedRevision: digest,
    ownerIncarnation: digest,
    result: z.enum([
      "matches_current",
      "differs_current",
      "identity_changed",
      "unavailable",
      "permission_denied",
      "hooks_unavailable",
    ]),
    actions: z.array(label).max(2),
    evidence: digest,
  })
  .strict();
export type OperationObservation = z.infer<typeof observationSchema>;
export interface OperationReview {
  id: string;
  revision: string;
  service: string;
  action: string;
  state: OperationState;
  createdAt: number;
  hasReference: boolean;
  canResolve: boolean;
  resolvedAt?: number;
  observation?: Pick<OperationObservation, "id" | "at" | "result" | "actions">;
}
const stateSchema = z
  .object({
    schema: z.literal(1),
    key: z.string().min(1).max(4096),
    records: z.record(z.string(), recordSchema),
    observations: z.record(z.string(), z.array(observationSchema).max(20)).optional(),
  })
  .strict();
type LedgerState = z.infer<typeof stateSchema>;

/** Trusted adapter input. Values are HMACed; parameters/bodies never enter the ledger. */
export interface OperationPlan {
  sessionId: string;
  /** Stable user-intent identity, never a randomly regenerated model tool-call ID. */
  intentId: string;
  /** Optional fixed semantic item within a batch/user intent; privately HMACed. */
  intentVariant?: unknown;
  service: string;
  action: string;
  channel: string;
  account: unknown;
  target: unknown;
  parameters: unknown;
  postcondition: unknown;
}

/** Trusted adapter evidence only. Domain interpretation belongs to the adapter. */
export interface OperationRecoveryInput {
  schema: 1;
  plan: OperationPlan;
  payload: unknown;
}

/** Reject non-JSON, cycles, oversized/deep values, and ambiguous key ordering. */
export function canonicalOperationValue(value: unknown, maxBytes = 64 * 1024): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024)
    throw new Error("Invalid operation input bound");
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > 10_000 || depth > 20) throw new Error("Operation input exceeds bounds");
    if (input === null || typeof input === "boolean" || typeof input === "string") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (!input || typeof input !== "object" || seen.has(input))
      throw new Error("Operation input must be finite JSON");
    seen.add(input);
    try {
      if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
      if (
        Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null
      )
        throw new Error("Operation input must be plain JSON");
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(input).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (!Object.hasOwn(descriptor, "value"))
          throw new Error("Operation input cannot have accessors");
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      seen.delete(input);
    }
  };
  const serialized = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error("Operation input exceeds bounds");
  return serialized;
}

/**
 * Owner-only sidecar outside individual transcripts. Short synchronous transactions
 * serialize processes; no lock is held while approval, tools, or network await.
 * The supplied Host cipher protects the stable HMAC key. Headless defaults are
 * explicitly owner-only plaintext, as with credentials; this is not an OS sandbox.
 */
export class OperationLedger {
  private readonly directory: string;
  private readonly file: string;
  private readonly scope: string;
  private readonly rootIdentity: { dev: number; ino: number };
  private opened = false;
  private readonly knownOwners = new Map<string, string>();
  private readonly sealedIds = new Set<string>();
  private readonly finalizedSessions = new Set<string>();
  private capturedIncarnation: string | undefined;

  constructor(
    storageRoot: string,
    private readonly cipher: EncryptionCipher = getDefaultCredentialCipher(),
    private readonly ownerBinding?: { sessionId: string; read(): OperationSessionOwner },
  ) {
    mkdirSync(resolve(storageRoot), { recursive: true, mode: 0o700 });
    // Path aliases must not create independent idempotency identities for the
    // same physical ledger. Pin the actual root as well as its lock path.
    this.scope = realpathSync(resolve(storageRoot));
    const root = lstatSync(this.scope);
    if (!root.isDirectory()) throw new Error("Invalid operation storage root");
    this.rootIdentity = { dev: root.dev, ino: root.ino };
    this.directory = join(this.scope, ".operations");
    this.file = join(this.directory, "ledger.json");
  }

  private transact<R>(
    mutation: (state: LedgerState, key: Buffer) => { value?: LedgerState; result: R },
    guard?: () => () => void,
  ): R {
    const root = lstatSync(this.scope);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.dev !== this.rootIdentity.dev ||
      root.ino !== this.rootIdentity.ino
    )
      throw new Error("Operation storage root changed");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid operation directory");
    let releaseGuard: (() => void) | undefined;
    let result: R | undefined;
    try {
      result = mutateJsonFile<LedgerState, R>(this.file, {
        maxBytes: 16 * 1024 * 1024,
        mode: 0o600,
        parse: (raw) => {
          if (raw === undefined) {
            if (this.opened) throw new Error("Operation ledger disappeared");
            return {
              schema: 1,
              key: this.cipher.encrypt(randomBytes(32).toString("hex")),
              records: {},
            };
          }
          const state = stateSchema.parse(JSON.parse(raw));
          if (Object.keys(state.records).length > 10_000)
            throw new Error("Operation ledger exceeds bounds");
          for (const [id, record] of Object.entries(state.records))
            if (id !== record.id) throw new Error("Operation ledger identity mismatch");
          for (const id of Object.keys(state.observations ?? {}))
            if (!state.records[id]) throw new Error("Operation observation identity mismatch");
          return state;
        },
        serialize: (state) => JSON.stringify(state),
        mutation: (state) => {
          releaseGuard = guard?.();
          if (
            this.ownerBinding &&
            this.capturedIncarnation !== undefined &&
            this.ownerBinding.read().incarnation !== this.capturedIncarnation
          )
            throw new Error("Operation Session incarnation changed");
          const secret = this.cipher.decrypt(state.key);
          if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid operation key");
          return mutation(state, Buffer.from(secret, "hex"));
        },
      });
    } finally {
      releaseGuard?.();
    }
    this.opened = true;
    return structuredClone(result!);
  }

  private hash(key: Buffer, purpose: string, value: unknown): string {
    return (
      createHmac("sha256", key)
        // The persisted random key is the namespace. Restoring/moving the same
        // ledger must preserve its pending identities rather than erase them.
        .update(
          canonicalOperationValue([purpose, value], purpose === "plan" ? 512 * 1024 : 64 * 1024),
        )
        .digest("hex")
    );
  }

  private matchesPlan(key: Buffer, receipt: OperationReceipt, plan: OperationPlan): boolean {
    return (
      receipt.owner === this.hash(key, "owner", plan.sessionId) &&
      (receipt.ownerIncarnation === undefined ||
        receipt.ownerIncarnation === this.incarnation(key, plan.sessionId)) &&
      receipt.id ===
        this.hash(key, "intent", [plan.sessionId, plan.intentId, plan.intentVariant ?? null]) &&
      receipt.fingerprint ===
        this.hash(key, "plan", [
          plan.service,
          plan.action,
          plan.channel,
          plan.account,
          plan.target,
          plan.parameters,
          plan.postcondition,
        ])
    );
  }

  /** Capture original inputs before send, then at most one original immutable read identity. */
  captureRecovery(
    plan: OperationPlan,
    id: string,
    phase: "prepared" | "identity",
    payload: unknown,
  ): void {
    if (this.finalizedSessions.has(plan.sessionId) || this.sealedIds.has(id))
      throw new Error("Operation recovery has finalized");
    this.transact((state, key) => {
      const receipt = state.records[digest.parse(id)];
      if (
        !receipt ||
        !this.matchesPlan(key, receipt, plan) ||
        this.knownOwners.get(id) !== plan.sessionId ||
        receipt.state !== (phase === "prepared" ? "planned" : "succeeded")
      )
        throw new Error("Operation recovery input changed");
      const input: OperationRecoveryInput = { schema: 1, plan, payload };
      const stored = new OperationRecoveryFiles(this.directory).save(
        key,
        id,
        canonicalOperationValue(input, 512 * 1024),
      );
      if (phase === "prepared") {
        if (receipt.recovery && receipt.recovery.prepared !== stored)
          throw new Error("Prepared operation recovery is immutable");
        receipt.recovery ??= { prepared: stored };
      } else {
        if (!receipt.recovery) throw new Error("Original prepared recovery input is missing");
        if (receipt.recovery.identity && receipt.recovery.identity !== stored)
          throw new Error("Original operation read identity is immutable");
        receipt.recovery.identity = stored;
      }
      return { value: state, result: undefined };
    });
  }

  /** Exact plan proof for a trusted adapter's candidate; never exposes the ledger key. */
  provePlan(receipt: OperationReceipt, plan: OperationPlan): boolean {
    return this.transact((state, key) => {
      const current = state.records[digest.parse(receipt.id)];
      return {
        result:
          !!current &&
          current.fingerprint === receipt.fingerprint &&
          current.attemptId === receipt.attemptId &&
          this.matchesPlan(key, current, plan),
      };
    });
  }

  private reviewedReceipt(
    state: LedgerState,
    key: Buffer,
    sessionId: string,
    id: string,
    revision: string,
    legacyEvidence: ReadonlyMap<string, string>,
  ): { receipt: OperationReceipt; incarnation: string } {
    const incarnation = this.incarnation(key, sessionId);
    const owner = this.hash(key, "owner", sessionId);
    const receipt = state.records[digest.parse(id)];
    if (
      !incarnation ||
      !receipt ||
      !this.matchesOwner(receipt, owner, incarnation) ||
      receipt.state !== "unknown" ||
      !receipt.attemptId ||
      this.hash(key, "review", receipt) !== digest.parse(revision) ||
      (!receipt.ownerIncarnation &&
        legacyEvidence.get(id) !==
          JSON.stringify([receipt.owner, receipt.fingerprint, receipt.attemptId]))
    )
      throw new Error("Operation read review is stale or unproven");
    if (
      Object.values(state.records).some(
        (entry) => this.matchesOwner(entry, owner, incarnation) && entry.state === "running",
      )
    )
      throw new Error("Operation Session is running");
    return { receipt, incarnation };
  }

  /** Private Host adapter input. Never returned by a model tool or renderer API. */
  readReviewRecovery(
    sessionId: string,
    id: string,
    revision: string,
    legacyEvidence: ReadonlyMap<string, string>,
    guard: () => () => void,
  ): { receipt: OperationReceipt; input?: OperationRecoveryInput } {
    return this.transact((state, key) => {
      const { receipt } = this.reviewedReceipt(state, key, sessionId, id, revision, legacyEvidence);
      if ((state.observations?.[id]?.length ?? 0) >= 20)
        throw new Error("Operation observation history is full");
      let input: OperationRecoveryInput | undefined;
      if (receipt.recovery) {
        input = JSON.parse(
          new OperationRecoveryFiles(this.directory).read(
            key,
            id,
            receipt.recovery.identity ?? receipt.recovery.prepared,
          ),
        );
        if (!input || input.schema !== 1 || !this.matchesPlan(key, receipt, input.plan))
          throw new Error("Original recovery plan is unproven");
      }
      return { result: { receipt, ...(input ? { input } : {}) } };
    }, guard);
  }

  /** Append an independent present-state observation. The original receipt never changes. */
  observeReview(
    sessionId: string,
    id: string,
    revision: string,
    legacyEvidence: ReadonlyMap<string, string>,
    result: OperationObservation["result"],
    actions: string[],
    evidence: unknown,
    guard: () => () => void,
  ): OperationObservation {
    return this.transact((state, key) => {
      const { incarnation } = this.reviewedReceipt(
        state,
        key,
        sessionId,
        id,
        revision,
        legacyEvidence,
      );
      const history = state.observations?.[id] ?? [];
      if (history.length >= 20) throw new Error("Operation observation history is full");
      const observation = observationSchema.parse({
        id: randomUUID(),
        at: Date.now(),
        reviewedRevision: revision,
        ownerIncarnation: incarnation,
        result,
        actions,
        evidence: this.hash(key, "observation-evidence", evidence),
      });
      state.observations ??= {};
      state.observations[id] = [...history, observation];
      return { value: state, result: observation };
    }, guard);
  }

  private incarnation(key: Buffer, sessionId: string): string | undefined {
    if (!this.ownerBinding) return undefined;
    if (this.ownerBinding.sessionId !== sessionId) throw new Error("Operation owner mismatch");
    const current = this.ownerBinding.read().incarnation;
    if (this.capturedIncarnation !== undefined && current !== this.capturedIncarnation)
      throw new Error("Operation Session incarnation changed");
    this.capturedIncarnation = current;
    return this.hash(key, "incarnation", current);
  }

  private matchesOwner(receipt: OperationReceipt, owner: string, incarnation?: string): boolean {
    return (
      receipt.owner === owner &&
      (incarnation === undefined ||
        receipt.ownerIncarnation === undefined ||
        receipt.ownerIncarnation === incarnation)
    );
  }

  private resolvedForOwner(receipt: OperationReceipt, incarnation?: string): boolean {
    return (
      !!receipt.operatorResolution &&
      incarnation !== undefined &&
      receipt.ownerIncarnation === incarnation
    );
  }

  /** Bounded masked Host review. The original receipt and payload never leave the ledger. */
  reviewSession(
    sessionId: string,
    legacyEvidence: ReadonlyMap<string, string>,
  ): {
    records: OperationReview[];
    truncated: boolean;
  } {
    if (!existsSync(this.file) && !this.opened) return { records: [], truncated: false };
    return this.transact((state, key) => {
      const owner = this.hash(key, "owner", sessionId);
      const incarnation = this.incarnation(key, sessionId);
      if (!incarnation) throw new Error("Operation review requires durable Host ownership");
      const selected = Object.values(state.records)
        .filter(
          (entry) =>
            this.matchesOwner(entry, owner, incarnation) &&
            entry.attemptId &&
            entry.state !== "verified",
        )
        .sort(
          (a, b) =>
            Number(!!a.operatorResolution) - Number(!!b.operatorResolution) ||
            b.createdAt - a.createdAt ||
            a.id.localeCompare(b.id),
        );
      return {
        result: {
          records: selected.slice(0, 50).map((entry) => ({
            id: entry.id,
            revision: this.hash(key, "review", entry),
            service: entry.service,
            action: entry.action,
            state: entry.state,
            createdAt: entry.createdAt,
            hasReference: !!entry.reference,
            canResolve:
              entry.state === "unknown" &&
              !entry.operatorResolution &&
              (entry.ownerIncarnation === incarnation ||
                legacyEvidence.get(entry.id) ===
                  JSON.stringify([entry.owner, entry.fingerprint, entry.attemptId])),
            ...(entry.operatorResolution ? { resolvedAt: entry.operatorResolution.at } : {}),
            ...(() => {
              const history = state.observations?.[entry.id];
              const latest = history
                ?.slice()
                .reverse()
                .find((item) => item.ownerIncarnation === incarnation);
              return latest
                ? {
                    observation: {
                      id: latest.id,
                      at: latest.at,
                      result: latest.result,
                      actions: latest.actions,
                    },
                  }
                : {};
            })(),
          })),
          truncated: selected.length > 50,
        },
      };
    });
  }

  /** Native Host confirmation only. This records a decision, never provider success. */
  resolveReview(
    sessionId: string,
    id: string,
    expectedRevision: string,
    legacyEvidence: ReadonlyMap<string, string>,
    guard: () => () => void,
  ): void {
    this.transact((state, key) => {
      const owner = this.hash(key, "owner", sessionId);
      const incarnation = this.incarnation(key, sessionId);
      if (!incarnation) throw new Error("Operation resolution requires durable Host ownership");
      const receipt = state.records[digest.parse(id)];
      if (
        !receipt ||
        !this.matchesOwner(receipt, owner, incarnation) ||
        receipt.state !== "unknown" ||
        !receipt.attemptId ||
        receipt.operatorResolution ||
        this.hash(key, "review", receipt) !== digest.parse(expectedRevision)
      )
        throw new Error("Operation review is stale");
      if (
        !receipt.ownerIncarnation &&
        legacyEvidence.get(id) !==
          JSON.stringify([receipt.owner, receipt.fingerprint, receipt.attemptId])
      )
        throw new Error("Legacy operation ownership is unproven");
      if (
        Object.values(state.records).some(
          (entry) => this.matchesOwner(entry, owner, incarnation) && entry.state === "running",
        )
      )
        throw new Error("Operation Session is running");
      receipt.ownerIncarnation = incarnation;
      receipt.operatorResolution = {
        id: randomUUID(),
        decision: "accept_uncertainty",
        at: Date.now(),
        reviewedRevision: expectedRevision,
      };
      return { value: state, result: undefined };
    }, guard);
  }

  prepare(plan: OperationPlan): OperationReceipt {
    if (this.finalizedSessions.has(plan.sessionId)) throw new Error("Operation run has finalized");
    for (const id of [plan.sessionId, plan.intentId])
      if (typeof id !== "string" || !id || id.length > 500)
        throw new Error("Invalid operation owner");
    for (const item of [plan.service, plan.action, plan.channel]) label.parse(item);
    const prepared = this.transact((state, key) => {
      const owner = this.hash(key, "owner", plan.sessionId);
      const incarnation = this.incarnation(key, plan.sessionId);
      const id = this.hash(key, "intent", [
        plan.sessionId,
        plan.intentId,
        plan.intentVariant ?? null,
      ]);
      const fingerprint = this.hash(key, "plan", [
        plan.service,
        plan.action,
        plan.channel,
        plan.account,
        plan.target,
        plan.parameters,
        plan.postcondition,
      ]);
      const existing = state.records[id];
      if (existing) {
        if (
          existing.owner !== owner ||
          existing.fingerprint !== fingerprint ||
          (existing.ownerIncarnation !== undefined && existing.ownerIncarnation !== incarnation)
        )
          throw new Error("Operation intent conflicts with its immutable plan");
        return { result: existing };
      }
      if (Object.keys(state.records).length >= 10_000) throw new Error("Operation ledger is full");
      const now = Date.now();
      const receipt: OperationReceipt = {
        id,
        owner,
        fingerprint,
        service: plan.service,
        action: plan.action,
        channel: plan.channel,
        state: "planned",
        createdAt: now,
        updatedAt: now,
        ...(incarnation ? { ownerIncarnation: incarnation } : {}),
      };
      state.records[id] = receipt;
      return { value: state, result: receipt };
    });
    this.knownOwners.set(prepared.id, plan.sessionId);
    return prepared;
  }

  claim(id: string): { receipt: OperationReceipt; claimed: boolean } {
    return this.transact<{ receipt: OperationReceipt; claimed: boolean }>((state, key) => {
      const receipt = state.records[digest.parse(id)];
      if (!receipt) throw new Error("Operation does not exist");
      // A receipt cannot itself grant ownership to an unbound or different
      // incarnation caller, even if that caller learned a bound planned id.
      if (
        receipt.ownerIncarnation !== undefined &&
        receipt.ownerIncarnation !==
          (this.ownerBinding ? this.incarnation(key, this.ownerBinding.sessionId) : undefined)
      )
        return { result: { receipt, claimed: false } };
      if (this.sealedIds.has(id) && receipt.state === "planned") {
        receipt.state = "blocked";
        receipt.error = "cancelled";
        receipt.updatedAt = Date.now();
        return { value: state, result: { receipt, claimed: false } };
      }
      if (receipt.state !== "planned") return { result: { receipt, claimed: false } };
      // Check the Session barrier in the same transaction as the claim. An
      // earlier async preflight cannot exclude another process's intervening send.
      if (
        Object.values(state.records).some(
          (other) =>
            other.id !== id &&
            this.matchesOwner(other, receipt.owner, receipt.ownerIncarnation) &&
            !!other.attemptId &&
            other.state !== "verified" &&
            !this.resolvedForOwner(other, receipt.ownerIncarnation),
        )
      ) {
        receipt.state = "blocked";
        receipt.error = "stale_reference";
        receipt.updatedAt = Date.now();
        return { value: state, result: { receipt, claimed: false } };
      }
      receipt.state = "running";
      receipt.attemptId = randomUUID();
      receipt.updatedAt = Date.now();
      return { value: state, result: { receipt, claimed: true } };
    });
  }

  settle(
    id: string,
    attemptId: string | undefined,
    next: "blocked" | "unknown" | "succeeded" | "verified",
    options: {
      reference?: OperationReference;
      error?: OperationError;
    } = {},
  ): OperationReceipt {
    return this.transact((state) => {
      const receipt = state.records[digest.parse(id)];
      if (!receipt || receipt.attemptId !== attemptId) throw new Error("Operation attempt changed");
      if (receipt.operatorResolution) return { result: receipt };
      if (this.sealedIds.has(id) && receipt.state !== "verified") {
        receipt.state = "unknown";
        receipt.updatedAt = Date.now();
        return { value: state, result: receipt };
      }
      // A published uncertain terminal state is sealed against late IO callbacks.
      if (receipt.state === "unknown") return { result: receipt };
      if (receipt.state === "verified" && (next === "verified" || next === "succeeded"))
        return { result: receipt }; // Concurrent independent read cannot downgrade proof.
      const allowed =
        next === "blocked"
          ? receipt.state === "planned"
          : next === "unknown"
            ? receipt.state === "running"
            : next === "succeeded"
              ? receipt.state === "running" || receipt.state === "succeeded"
              : receipt.state === "succeeded";
      if (!allowed) throw new Error("Invalid operation transition");
      if (options.reference) receipt.reference = reference.parse(options.reference);
      if ((next === "succeeded" || next === "verified") && !receipt.reference)
        throw new Error("Operation verification requires an immutable reference");
      receipt.state = next;
      receipt.updatedAt = Date.now();
      if (options.error) receipt.error = z.enum(operationErrors).parse(options.error);
      else delete receipt.error;
      if (next === "verified") receipt.verifiedAt = receipt.updatedAt;
      return { value: state, result: receipt };
    });
  }

  hasUnverifiedWrites(sessionId: string): boolean {
    if (!existsSync(this.file) && !this.opened) return false;
    return this.transact((state, key) => {
      const owner = this.hash(key, "owner", sessionId);
      const incarnation = this.incarnation(key, sessionId);
      return {
        result: Object.values(state.records).some(
          (entry) =>
            this.matchesOwner(entry, owner, incarnation) &&
            !!entry.attemptId &&
            entry.state !== "verified" &&
            !this.resolvedForOwner(entry, incarnation),
        ),
      };
    });
  }

  sealPending(id: string): OperationReceipt {
    this.sealedIds.add(id);
    return this.transact((state) => {
      const receipt = state.records[digest.parse(id)];
      if (!receipt) throw new Error("Operation does not exist");
      if (receipt.state !== "running") return { result: receipt };
      receipt.state = "unknown";
      receipt.updatedAt = Date.now();
      return { value: state, result: receipt };
    });
  }

  /** Freeze all outstanding sends/reads before publishing any terminal Run result. */
  sealForFinalization(sessionId: string): boolean {
    // Fence this controller before any disk work. Even a failed checkpoint must
    // stop its in-flight callback upgrading a terminal result after IO recovers.
    this.finalizedSessions.add(sessionId);
    for (const [id, owner] of this.knownOwners) if (owner === sessionId) this.sealedIds.add(id);
    if (!existsSync(this.file) && !this.opened) return false;
    return this.transact((state, key) => {
      const owner = this.hash(key, "owner", sessionId);
      const incarnation = this.incarnation(key, sessionId);
      let changed = false;
      let unverified = false;
      for (const receipt of Object.values(state.records)) {
        if (
          !this.matchesOwner(receipt, owner, incarnation) ||
          receipt.state === "verified" ||
          this.resolvedForOwner(receipt, incarnation)
        )
          continue;
        if (receipt.state === "planned") {
          receipt.state = "blocked";
          receipt.error = "cancelled";
          receipt.updatedAt = Date.now();
          changed = true;
          continue;
        }
        if (!receipt.attemptId) continue;
        unverified = true;
        if (receipt.state === "running" || receipt.state === "succeeded") {
          receipt.state = "unknown";
          receipt.updatedAt = Date.now();
          changed = true;
        }
      }
      return { ...(changed ? { value: state } : {}), result: unverified };
    });
  }
}
