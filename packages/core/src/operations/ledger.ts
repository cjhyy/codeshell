import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { getDefaultCredentialCipher, type EncryptionCipher } from "../credentials/cipher.js";
import { mutateJsonFile } from "../utils/file-mutex.js";
import { OperationRecoveryFiles } from "./recovery.js";

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
  })
  .strict();
export type OperationReceipt = z.infer<typeof recordSchema>;
export type OperationReference = z.infer<typeof reference>;
const stateSchema = z
  .object({
    schema: z.literal(1),
    key: z.string().min(1).max(4096),
    records: z.record(z.string(), recordSchema),
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
export function canonicalOperationValue(value: unknown): string {
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
  if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error("Operation input exceeds bounds");
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

  constructor(
    storageRoot: string,
    private readonly cipher: EncryptionCipher = getDefaultCredentialCipher(),
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
    const result = mutateJsonFile<LedgerState, R>(this.file, {
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
        return state;
      },
      serialize: (state) => JSON.stringify(state),
      mutation: (state) => {
        const secret = this.cipher.decrypt(state.key);
        if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid operation key");
        return mutation(state, Buffer.from(secret, "hex"));
      },
    });
    this.opened = true;
    return structuredClone(result!);
  }

  private hash(key: Buffer, purpose: string, value: unknown): string {
    return (
      createHmac("sha256", key)
        // The persisted random key is the namespace. Restoring/moving the same
        // ledger must preserve its pending identities rather than erase them.
        .update(canonicalOperationValue([purpose, value]))
        .digest("hex")
    );
  }

  private matchesPlan(key: Buffer, receipt: OperationReceipt, plan: OperationPlan): boolean {
    return (
      receipt.owner === this.hash(key, "owner", plan.sessionId) &&
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
        canonicalOperationValue(input),
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

  prepare(plan: OperationPlan): OperationReceipt {
    if (this.finalizedSessions.has(plan.sessionId)) throw new Error("Operation run has finalized");
    for (const id of [plan.sessionId, plan.intentId])
      if (typeof id !== "string" || !id || id.length > 500)
        throw new Error("Invalid operation owner");
    for (const item of [plan.service, plan.action, plan.channel]) label.parse(item);
    const prepared = this.transact((state, key) => {
      const owner = this.hash(key, "owner", plan.sessionId);
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
        if (existing.owner !== owner || existing.fingerprint !== fingerprint)
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
      };
      state.records[id] = receipt;
      return { value: state, result: receipt };
    });
    this.knownOwners.set(prepared.id, plan.sessionId);
    return prepared;
  }

  claim(id: string): { receipt: OperationReceipt; claimed: boolean } {
    return this.transact<{ receipt: OperationReceipt; claimed: boolean }>((state) => {
      const receipt = state.records[digest.parse(id)];
      if (!receipt) throw new Error("Operation does not exist");
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
            other.owner === receipt.owner &&
            !!other.attemptId &&
            other.state !== "verified",
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
      return {
        result: Object.values(state.records).some(
          (entry) => entry.owner === owner && !!entry.attemptId && entry.state !== "verified",
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
      let changed = false;
      let unverified = false;
      for (const receipt of Object.values(state.records)) {
        if (receipt.owner !== owner || receipt.state === "verified") continue;
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
