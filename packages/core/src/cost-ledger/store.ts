import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  opendirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TokenUsage } from "../types.js";
import type { UsageOwner } from "./context.js";
import { estimateReceipt } from "./pricing.js";
import { summarizeReceipts } from "./summary.js";
import type {
  ExternalBilledUsage,
  UsageIdentity,
  UsageQuery,
  UsageReceipt,
  UsageSummary,
} from "./types.js";

const MAX_RECEIPTS = 10_000;
const MAX_RECEIPT_BYTES = 16_384;
const PURPOSES = new Set([
  "main",
  "aux_summary",
  "tool_summary",
  "goal_judge",
  "title",
  "context_package",
  "manual_compact",
  "subagent",
  "external",
]);
function textId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f]/.test(value)
  );
}
function normalizeUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as TokenUsage;
  if (
    ![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return null;
  if (
    [usage.cacheReadTokens, usage.cacheCreationTokens].some(
      (n) => n !== undefined && (!Number.isSafeInteger(n) || n < 0),
    )
  )
    return null;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: usage.cacheCreationTokens }),
  };
}
function validReceipt(value: unknown, namespace: string): value is UsageReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as UsageReceipt;
  return (
    r.version === 1 &&
    r.namespace === namespace &&
    /^[a-f0-9]{64}$/.test(r.requestId) &&
    textId(r.runtimeId) &&
    textId(r.sessionId) &&
    /^[a-f0-9-]{36}$/.test(r.accountingSessionId) &&
    textId(r.provider) &&
    textId(r.model) &&
    (r.providerKind === undefined || textId(r.providerKind)) &&
    (r.runId === undefined || textId(r.runId)) &&
    textId(r.source) &&
    PURPOSES.has(r.purpose) &&
    Array.isArray(r.ancestors) &&
    r.ancestors.length <= 64 &&
    r.ancestors.every(textId) &&
    Array.isArray(r.ancestorAccountingIds) &&
    r.ancestorAccountingIds.length <= 64 &&
    r.ancestorAccountingIds.every((id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id)) &&
    Number.isFinite(r.startedAt) &&
    r.startedAt >= 0 &&
    (r.settledAt === undefined || (Number.isFinite(r.settledAt) && r.settledAt >= r.startedAt)) &&
    ["pending", "completed", "failed"].includes(r.outcome) &&
    (r.usage === null || normalizeUsage(r.usage) !== null) &&
    (r.estimatedCostUsd === null ||
      (typeof r.estimatedCostUsd === "number" &&
        Number.isFinite(r.estimatedCostUsd) &&
        r.estimatedCostUsd >= 0)) &&
    (r.estimatedCostUsd === null || r.usage !== null)
  );
}

/** Per-request atomic files avoid a shared read/add/write total and asynchronous locks. */
export class UsageLedger {
  readonly namespace: string;
  readonly runtimeId: string;
  private readonly directory?: string;
  private readonly now: () => number;
  private readonly records = new Map<string, UsageReceipt>();
  private readonly sessionAccountingIds = new Map<string, string>();
  private persistenceErrors = 0;
  private invalidReceipts = 0;

  noteAccountingFailure(): void {
    this.persistenceErrors++;
  }

  constructor(
    options: {
      storageDir?: string;
      namespace?: string;
      runtimeId?: string;
      now?: () => number;
    } = {},
  ) {
    this.namespace = options.namespace ?? "default";
    this.runtimeId = options.runtimeId ?? randomUUID();
    if (!textId(this.namespace) || !textId(this.runtimeId))
      throw new Error("Invalid usage namespace");
    this.directory =
      options.storageDir &&
      join(options.storageDir, createHash("sha256").update(this.namespace).digest("hex"));
    this.now = options.now ?? Date.now;
  }

  owner(
    sessionId: string,
    runId?: string,
    ancestors: readonly string[] = [],
    purpose: UsageOwner["purpose"] = "main",
    sessionScope = "default",
  ): UsageOwner {
    if (
      !textId(sessionId) ||
      (runId !== undefined && !textId(runId)) ||
      ancestors.length > 64 ||
      !ancestors.every(textId)
    )
      throw new Error("Invalid usage owner");
    const key = JSON.stringify([sessionScope, sessionId]);
    const accountingSessionId = this.sessionAccountingIds.get(key) ?? randomUUID();
    this.sessionAccountingIds.set(key, accountingSessionId);
    return Object.freeze({
      ledger: this,
      sessionId,
      accountingSessionId,
      runId,
      ancestors: Object.freeze([...new Set(ancestors)].filter((id) => id !== sessionId)),
      ancestorAccountingIds: Object.freeze(
        ancestors.flatMap(
          (id) => this.sessionAccountingIds.get(JSON.stringify([sessionScope, id])) ?? [],
        ),
      ),
      purpose,
    });
  }

  begin(
    owner: UsageOwner,
    identity: UsageIdentity,
    external?: { source: string; requestId: string },
  ): UsageReceipt {
    const requestId = createHash("sha256")
      .update(
        JSON.stringify([
          this.namespace,
          external?.source ?? "provider",
          external?.requestId ?? randomUUID(),
        ]),
      )
      .digest("hex");
    const receipt: UsageReceipt = {
      version: 1,
      requestId,
      namespace: this.namespace,
      runtimeId: this.runtimeId,
      sessionId: owner.sessionId,
      accountingSessionId: owner.accountingSessionId,
      ...(owner.runId ? { runId: owner.runId } : {}),
      ancestors: [...owner.ancestors],
      ancestorAccountingIds: [...owner.ancestorAccountingIds],
      purpose: external ? "external" : owner.purpose,
      provider: identity.provider,
      model: identity.model,
      ...(identity.providerKind ? { providerKind: identity.providerKind } : {}),
      source: external?.source ?? "provider",
      startedAt: this.now(),
      outcome: "pending",
      usage: null,
      estimatedCostUsd: null,
      pricing: null,
    };
    if (external && this.persist(receipt, true) === "exists")
      throw new Error("External usage identity conflict");
    this.records.set(requestId, receipt);
    if (!external) this.persist(receipt);
    return receipt;
  }

  settle(receipt: UsageReceipt, value: TokenUsage | null): void {
    const usage = normalizeUsage(value);
    if (usage) {
      receipt.usage = usage;
      Object.assign(receipt, estimateReceipt(receipt, usage));
    }
    receipt.settledAt = this.now();
    this.persist(receipt);
  }

  finish(receipt: UsageReceipt, outcome: "completed" | "failed"): void {
    receipt.outcome = outcome;
    receipt.settledAt = this.now();
    this.persist(receipt);
  }

  recordExternal(owner: UsageOwner, input: ExternalBilledUsage): UsageReceipt {
    if (
      ![input.source, input.requestId, input.provider, input.model].every(textId) ||
      input.source === "provider" ||
      (input.usage !== undefined && !normalizeUsage(input.usage))
    )
      throw new Error("Invalid external usage receipt");
    const id = createHash("sha256")
      .update(JSON.stringify([this.namespace, input.source, input.requestId]))
      .digest("hex");
    const existing = this.records.get(id) ?? this.read(id);
    if (existing) {
      if (
        existing.sessionId !== owner.sessionId ||
        existing.accountingSessionId !== owner.accountingSessionId ||
        existing.provider !== input.provider ||
        existing.model !== input.model ||
        existing.providerKind !== input.providerKind ||
        JSON.stringify(existing.usage) !== JSON.stringify(normalizeUsage(input.usage))
      )
        throw new Error("External usage identity conflict");
      return structuredClone(existing);
    }
    const receipt = this.begin(owner, input, { source: input.source, requestId: input.requestId });
    this.settle(receipt, input.usage ?? null);
    this.finish(receipt, "completed");
    return structuredClone(receipt);
  }

  sessionState(sessionId: string, sessionScope = "default"): Record<string, unknown> {
    const owner = this.owner(sessionId, undefined, [], "main", sessionScope);
    return {
      version: 1,
      kind: "usage-ledger",
      namespace: this.namespace,
      sessionId,
      accountingSessionId: owner.accountingSessionId,
      summary: this.summary({ scope: "session", sessionId }, sessionScope),
    };
  }

  /** Only a matching persisted Session reference can adopt historical request ownership. */
  adoptSession(sessionId: string, state: unknown, sessionScope = "default"): boolean {
    if (!state || typeof state !== "object") return false;
    const reference = state as Record<string, unknown>;
    if (
      reference.version !== 1 ||
      reference.kind !== "usage-ledger" ||
      reference.namespace !== this.namespace ||
      reference.sessionId !== sessionId ||
      typeof reference.accountingSessionId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(reference.accountingSessionId)
    )
      return false;
    const key = JSON.stringify([sessionScope, sessionId]);
    const current = this.sessionAccountingIds.get(key);
    if (current && current !== reference.accountingSessionId) return false;
    this.sessionAccountingIds.set(key, reference.accountingSessionId);
    return true;
  }

  summary(query: UsageQuery = {}, sessionScope = "default"): UsageSummary {
    const scope = query.scope ?? "runtime";
    if (scope === "session" && !textId(query.sessionId))
      throw new Error("Usage Session is required");
    const limit = query.limit ?? MAX_RECEIPTS;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_RECEIPTS ||
      (query.since !== undefined && (!Number.isFinite(query.since) || query.since < 0)) ||
      (query.until !== undefined && (!Number.isFinite(query.until) || query.until < 0)) ||
      (query.runId !== undefined && !textId(query.runId)) ||
      (query.cursor !== undefined && !/^[a-f0-9]{64}$/.test(query.cursor))
    )
      throw new Error("Invalid usage query");
    const ids = new Set(this.records.keys());
    let partial = false;
    if (this.directory && scope !== "runtime") {
      try {
        const directory = opendirSync(this.directory);
        try {
          let count = 0;
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (++count > 50_000) {
              partial = true;
              break;
            }
            if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
              ids.add(entry.name.slice(0, -5));
          }
        } finally {
          directory.closeSync();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.persistenceErrors++;
      }
    }
    const ordered = [...ids].sort().filter((id) => !query.cursor || id > query.cursor);
    const selected = ordered.slice(0, limit);
    partial ||= selected.length < ordered.length;
    const receipts: UsageReceipt[] = [];
    this.invalidReceipts = 0;
    for (const id of selected) {
      const receipt = this.records.get(id) ?? this.read(id);
      if (!receipt) {
        this.invalidReceipts++;
        continue;
      }
      if (scope === "runtime" && receipt.runtimeId !== this.runtimeId) continue;
      if (
        scope === "session" &&
        receipt.accountingSessionId !==
          this.sessionAccountingIds.get(JSON.stringify([sessionScope, query.sessionId])) &&
        !(
          query.includeChildren &&
          receipt.ancestorAccountingIds.includes(
            this.sessionAccountingIds.get(JSON.stringify([sessionScope, query.sessionId])) ?? "",
          )
        )
      )
        continue;
      if (query.runId !== undefined && receipt.runId !== query.runId) continue;
      if (receipt.startedAt < (query.since ?? 0) || receipt.startedAt > (query.until ?? Infinity))
        continue;
      receipts.push(receipt);
    }
    return summarizeReceipts(receipts, {
      version: 1,
      scope,
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      includesChildren: query.includeChildren === true,
      partial: partial || this.persistenceErrors > 0 || this.invalidReceipts > 0,
      persistenceErrors: this.persistenceErrors,
      invalidReceipts: this.invalidReceipts,
      scannedReceipts: selected.length,
      ...(partial ? { nextCursor: selected.at(-1) } : {}),
    });
  }

  private read(id: string): UsageReceipt | undefined {
    if (!this.directory) return undefined;
    try {
      const file = join(this.directory, `${id}.json`);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES)
        return undefined;
      const receipt: unknown = JSON.parse(readFileSync(file, "utf8"));
      return validReceipt(receipt, this.namespace) && receipt.requestId === id
        ? receipt
        : undefined;
    } catch {
      return undefined;
    }
  }

  private persist(receipt: UsageReceipt, exclusive = false): "written" | "exists" | "failed" {
    if (!this.directory) return "written";
    const temporary = join(this.directory, `.${receipt.requestId}.${randomUUID()}.tmp`);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const raw = JSON.stringify(receipt);
      if (Buffer.byteLength(raw) > MAX_RECEIPT_BYTES)
        throw new Error("Usage receipt exceeds limit");
      writeFileSync(temporary, raw, { mode: 0o600, flag: "wx" });
      const target = join(this.directory, `${receipt.requestId}.json`);
      if (exclusive) {
        linkSync(temporary, target);
        unlinkSync(temporary);
      } else renameSync(temporary, target);
      return "written";
    } catch (error) {
      if (exclusive && (error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          unlinkSync(temporary);
        } catch {
          /* Already removed. */
        }
        return "exists";
      }
      this.persistenceErrors++;
      try {
        unlinkSync(temporary);
      } catch {
        /* May not have been created. */
      }
      return "failed";
    }
  }
}
