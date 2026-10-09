import { createHmac, randomUUID } from "node:crypto";
import { existsSync, opendirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { operationDirectory, operationFile, readOperationFile } from "./files.js";
import { OperationRecoveryFiles, OPERATION_RECOVERY_MAX_BYTES } from "./recovery.js";
import { digest, legacyStateSchema, recordSchema, type OperationReceipt } from "./schema.js";

export const OPERATION_ACTIVE_MAX_RECORDS = 10_000;
export const OPERATION_ACTIVE_MAX_BYTES = 16 * 1024 * 1024;
export const OPERATION_ARCHIVE_MAX_RECORDS = 1024;
export const OPERATION_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024;
export const OPERATION_ARCHIVE_RECOVERY_MAX_BYTES = 512 * 1024 * 1024;
const prefixSchema = z.string().regex(/^[a-f0-9]{2}$/);
const bucketEntrySchema = z
  .object({
    digest,
    count: z.number().int().min(1).max(OPERATION_ARCHIVE_MAX_RECORDS),
    bytes: z.number().int().min(1).max(OPERATION_ARCHIVE_MAX_BYTES),
    recoveryBytes: z.number().int().nonnegative().max(OPERATION_ARCHIVE_RECOVERY_MAX_BYTES),
  })
  .strict();
const manifestSchema = z
  .object({
    buckets: z.record(prefixSchema, bucketEntrySchema),
    authentication: digest,
  })
  .strict();
export const ledgerStateSchema = z.discriminatedUnion("schema", [
  legacyStateSchema,
  legacyStateSchema.extend({ schema: z.literal(2), archives: manifestSchema }).strict(),
]);
export type LedgerState = z.infer<typeof ledgerStateSchema>;
type Manifest = z.infer<typeof manifestSchema>;
const recoverySummarySchema = z
  .object({
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(2 * OPERATION_RECOVERY_MAX_BYTES),
    slots: z
      .array(
        z
          .object({ digest, bytes: z.number().int().min(1).max(OPERATION_RECOVERY_MAX_BYTES) })
          .strict(),
      )
      .max(2),
  })
  .strict();
const bucketSchema = z
  .object({
    schema: z.literal(1),
    prefix: prefixSchema,
    records: z.array(recordSchema).min(1).max(OPERATION_ARCHIVE_MAX_RECORDS),
    recovery: z.record(digest, recoverySummarySchema),
  })
  .strict();
type Bucket = z.infer<typeof bucketSchema>;
const MAX_RECOVERY_SUMMARY_BYTES = Buffer.byteLength(
  JSON.stringify({
    bytes: 2 * OPERATION_RECOVERY_MAX_BYTES,
    slots: Array.from({ length: 2 }, () => ({
      digest: "f".repeat(64),
      bytes: OPERATION_RECOVERY_MAX_BYTES,
    })),
  }),
);

export function isArchivable(record: OperationReceipt): boolean {
  return (
    !record.operatorResolution &&
    ((record.state === "verified" &&
      !!record.attemptId &&
      !!record.reference &&
      record.verifiedAt !== undefined) ||
      (record.state === "blocked" && record.attemptId === undefined))
  );
}

/** A missing manifest must never silently mint a new intent namespace over cold artifacts. */
export function assertNoOperationArtifacts(directory: string): void {
  const entries = opendirSync(directory);
  try {
    if (entries.readSync())
      throw new Error("Operation manifest is missing beside existing artifacts");
  } finally {
    entries.closeSync();
  }
}

/**
 * Immutable HMAC-prefix buckets. Every method runs inside the original ledger
 * directory transaction. A lookup fully authenticates its prefix; other live
 * prefixes receive bounded regular-file/size checks, not a full history reread.
 */
export class OperationArchives {
  private readonly directory: string;
  private readonly buckets = new Map<string, Bucket>();
  private collected = false;
  private retained = false;

  constructor(
    private readonly ledgerDirectory: string,
    private readonly key: Buffer,
    private readonly state: LedgerState,
  ) {
    this.directory = join(ledgerDirectory, "archives");
    if (state.schema === 1) return;
    const manifest = state.archives;
    if (manifest.authentication !== this.authenticate(manifest.buckets))
      throw new Error("Operation archive manifest authentication failed");
    const entries = Object.entries(manifest.buckets);
    if (entries.length > 256 || this.recoveryBytes(manifest) > OPERATION_ARCHIVE_RECOVERY_MAX_BYTES)
      throw new Error("Operation archive exceeds bounds");
    operationDirectory(this.directory);
    for (const [prefix, entry] of entries) {
      const info = operationFile(this.file(prefix, entry.digest), OPERATION_ARCHIVE_MAX_BYTES);
      if (info.size !== entry.bytes) throw new Error("Operation archive size changed");
    }
  }

  private authenticate(buckets: Manifest["buckets"]): string {
    const entries = Object.entries(buckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([prefix, entry]) => [
        prefix,
        entry.digest,
        entry.count,
        entry.bytes,
        entry.recoveryBytes,
      ]);
    return createHmac("sha256", this.key)
      .update(JSON.stringify(["operation-archive-manifest-v1", entries]))
      .digest("hex");
  }

  private contentDigest(prefix: string, contents: string): string {
    return createHmac("sha256", this.key)
      .update(JSON.stringify(["operation-archive-bucket-v1", prefix, contents]))
      .digest("hex");
  }

  private file(prefix: string, digest: string): string {
    return join(this.directory, `${prefix}-${digest}.json`);
  }

  private recoveryBytes(manifest: Manifest): number {
    return Object.values(manifest.buckets).reduce((sum, entry) => sum + entry.recoveryBytes, 0);
  }

  private read(prefix: string): Bucket | undefined {
    if (this.buckets.has(prefix)) return this.buckets.get(prefix);
    const entry = this.state.schema === 2 ? this.state.archives.buckets[prefix] : undefined;
    if (!entry) return undefined;
    const contents = readOperationFile(
      this.file(prefix, entry.digest),
      OPERATION_ARCHIVE_MAX_BYTES,
    );
    if (Buffer.byteLength(contents) !== entry.bytes)
      throw new Error("Operation archive size changed");
    const bucket = this.decode(prefix, entry.digest, contents);
    if (
      bucket.records.length !== entry.count ||
      Object.values(bucket.recovery).reduce((sum, item) => sum + item.bytes, 0) !==
        entry.recoveryBytes
    )
      throw new Error("Operation archive recovery accounting changed");
    this.buckets.set(prefix, bucket);
    return bucket;
  }

  private decode(prefix: string, expectedDigest: string, contents: string): Bucket {
    if (this.contentDigest(prefix, contents) !== expectedDigest)
      throw new Error("Operation archive authentication failed");
    const bucket = bucketSchema.parse(JSON.parse(contents));
    if (bucket.prefix !== prefix || JSON.stringify(bucket) !== contents)
      throw new Error("Operation archive identity mismatch");
    let previous = "";
    for (const record of bucket.records) {
      const recovery = bucket.recovery[record.id];
      if (
        !record.id.startsWith(prefix) ||
        record.id <= previous ||
        !isArchivable(record) ||
        !recovery ||
        recovery.bytes !== recovery.slots.reduce((sum, slot) => sum + slot.bytes, 0) ||
        recovery.slots.some(
          (slot, index) => index > 0 && slot.digest <= recovery.slots[index - 1]!.digest,
        ) ||
        [record.recovery?.prepared, record.recovery?.identity].some(
          (digest) => digest && !recovery.slots.some((slot) => slot.digest === digest),
        )
      )
        throw new Error("Invalid archived operation receipt");
      previous = record.id;
    }
    if (
      Object.keys(bucket.recovery).length !== bucket.records.length ||
      Object.values(bucket.recovery).reduce((sum, item) => sum + item.bytes, 0) >
        OPERATION_ARCHIVE_RECOVERY_MAX_BYTES
    )
      throw new Error("Operation archive recovery accounting changed");
    return bucket;
  }

  lookup(id: string): OperationReceipt | undefined {
    digest.parse(id);
    // Even an active ID must not bypass a conflicting/corrupt cold prefix.
    const bucket = this.read(id.slice(0, 2));
    const archived = bucket?.records.find((record) => record.id === id);
    if (archived && this.state.records[id]) throw new Error("Duplicate operation archive identity");
    if (archived) {
      const current = new OperationRecoveryFiles(join(this.directory, "..")).inspect(
        this.key,
        id,
        [archived.recovery?.prepared, archived.recovery?.identity].filter(
          (value): value is string => value !== undefined,
        ),
      );
      if (JSON.stringify(current) !== JSON.stringify(bucket!.recovery[id]))
        throw new Error("Archived operation recovery changed");
    }
    return archived ?? this.state.records[id];
  }

  /** Real writes only. Never run GC from a readonly review or an old unlocked snapshot. */
  collect(): void {
    if (this.collected) return;
    const rootEntries = opendirSync(this.ledgerDirectory);
    const rootGarbage: string[] = [];
    let rootCount = 0;
    try {
      for (;;) {
        const entry = rootEntries.readSync();
        if (!entry) break;
        if (++rootCount > 32) throw new Error("Operation staging directory exceeds bounds");
        if (["ledger.json", "archives", "recovery"].includes(entry.name)) continue;
        if (!/^ledger\.json\.\d+\.[a-f0-9-]{36}\.tmp$/.test(entry.name))
          throw new Error("Invalid operation staging directory entry");
        operationFile(join(this.ledgerDirectory, entry.name), OPERATION_ACTIVE_MAX_BYTES);
        rootGarbage.push(entry.name);
      }
    } finally {
      rootEntries.closeSync();
    }
    if (rootGarbage.length > 2) throw new Error("Operation manifest orphan capacity exceeded");
    if (!existsSync(this.directory)) {
      if (this.state.schema === 2) throw new Error("Operation archive directory disappeared");
      for (const name of rootGarbage) rmSync(join(this.ledgerDirectory, name));
      this.collected = true;
      return;
    }
    operationDirectory(this.directory);
    const live = new Set(
      this.state.schema === 2
        ? Object.entries(this.state.archives.buckets).map(
            ([prefix, entry]) => `${prefix}-${entry.digest}.json`,
          )
        : [],
    );
    const entries = opendirSync(this.directory);
    const garbage: string[] = [];
    let count = 0;
    try {
      for (;;) {
        const entry = entries.readSync();
        if (!entry) break;
        if (
          ++count > 512 ||
          !/^(?:[a-f0-9]{2}-[a-f0-9]{64}\.json|\.stage-[a-f0-9-]{36}\.tmp)$/.test(entry.name)
        )
          throw new Error("Invalid operation archive directory entries");
        operationFile(join(this.directory, entry.name), OPERATION_ARCHIVE_MAX_BYTES);
        if (!live.has(entry.name)) garbage.push(entry.name);
      }
    } finally {
      entries.closeSync();
    }
    const versions = garbage.filter((name) => name.endsWith(".json"));
    if (versions.length > 2 || garbage.length - versions.length > 2)
      throw new Error("Operation archive orphan capacity exceeded");
    for (const name of versions) {
      const prefix = name.slice(0, 2);
      const orphan = this.decode(
        prefix,
        name.slice(3, 67),
        readOperationFile(join(this.directory, name), OPERATION_ARCHIVE_MAX_BYTES),
      );
      const current = new Map(this.read(prefix)?.records.map((record) => [record.id, record]));
      for (const record of orphan.records) {
        if (current.has(record.id) && this.state.records[record.id])
          throw new Error("Duplicate operation archive identity");
        const covered = this.state.records[record.id] ?? current.get(record.id);
        if (!covered || JSON.stringify(recordSchema.parse(covered)) !== JSON.stringify(record))
          throw new Error("Unreferenced operation archive is not covered by the current manifest");
      }
    }
    for (const name of rootGarbage) rmSync(join(this.ledgerDirectory, name));
    for (const name of garbage) rmSync(join(this.directory, name));
    this.collected = true;
  }

  /** At most one prefix and 32 newly archived receipts per real transaction. */
  retain(force = false): LedgerState {
    const state = this.state;
    if (this.retained) return state;
    if (
      !force &&
      Object.keys(state.records).length < 9000 &&
      Buffer.byteLength(JSON.stringify(state)) < 14 * 1024 * 1024
    )
      return state;
    const candidates = Object.values(state.records)
      .filter((record) => isArchivable(record) && state.observations?.[record.id] === undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const byPrefix = new Map<string, OperationReceipt[]>();
    for (const record of candidates) {
      const prefix = record.id.slice(0, 2);
      const group = byPrefix.get(prefix) ?? [];
      group.push(record);
      byPrefix.set(prefix, group);
    }
    for (const [prefix, group] of byPrefix) {
      const entry = state.schema === 2 ? state.archives.buckets[prefix] : undefined;
      // Prove room from authenticated canonical byte accounting before any
      // bucket read. A full history must not turn one short transaction into
      // 256 complete JSON/HMAC reads. Conservative tail slack is intentional.
      if (
        entry &&
        (entry.count >= OPERATION_ARCHIVE_MAX_RECORDS ||
          entry.bytes +
            Buffer.byteLength(JSON.stringify(recordSchema.parse(group[0]))) +
            Buffer.byteLength(JSON.stringify(group[0]!.id)) +
            MAX_RECOVERY_SUMMARY_BYTES +
            3 >
            OPERATION_ARCHIVE_MAX_BYTES)
      )
        continue;
      const previous = this.read(prefix);
      const bucket: Bucket = previous
        ? structuredClone(previous)
        : { schema: 1, prefix, records: [], recovery: {} };
      const manifest: Manifest =
        state.schema === 2 ? structuredClone(state.archives) : { buckets: {}, authentication: "" };
      const originalBytes = manifest.buckets[prefix]?.recoveryBytes ?? 0;
      let addedBytes = 0;
      const moved: OperationReceipt[] = [];
      const recovery = new OperationRecoveryFiles(join(this.directory, ".."));
      for (const record of group) {
        if (moved.length >= 32 || bucket.records.length >= OPERATION_ARCHIVE_MAX_RECORDS) break;
        if (bucket.records.some((item) => item.id === record.id))
          throw new Error("Duplicate operation archive identity");
        const summary = recovery.inspect(
          this.key,
          record.id,
          [record.recovery?.prepared, record.recovery?.identity].filter(
            (value): value is string => value !== undefined,
          ),
        );
        if (
          this.recoveryBytes(manifest) + addedBytes + summary.bytes >
          OPERATION_ARCHIVE_RECOVERY_MAX_BYTES
        )
          throw new Error("Operation archive recovery capacity is full");
        bucket.records.push(record);
        bucket.recovery[record.id] = summary;
        if (Buffer.byteLength(JSON.stringify(bucket)) > OPERATION_ARCHIVE_MAX_BYTES) {
          bucket.records.pop();
          delete bucket.recovery[record.id];
          break;
        }
        addedBytes += summary.bytes;
        moved.push(record);
      }
      if (!moved.length) throw new Error("Operation archive has no safe capacity");
      bucket.records.sort((a, b) => a.id.localeCompare(b.id));
      // Recovery map insertion order is irrelevant to identity; canonicalize it for stable files.
      bucket.recovery = Object.fromEntries(
        bucket.records.map((record) => [record.id, bucket.recovery[record.id]!]),
      );
      const contents = JSON.stringify(bucketSchema.parse(bucket));
      const contentDigest = this.contentDigest(prefix, contents);
      operationDirectory(this.directory, true);
      const target = this.file(prefix, contentDigest);
      if (!existsSync(target)) {
        const stage = join(this.directory, `.stage-${randomUUID()}.tmp`);
        try {
          writeFileSync(stage, contents, { mode: 0o600, flag: "wx" });
          renameSync(stage, target);
        } finally {
          rmSync(stage, { force: true });
        }
      }
      // Prove the bounded regular immutable file before publishing a reference.
      if (readOperationFile(target, OPERATION_ARCHIVE_MAX_BYTES) !== contents)
        throw new Error("Operation archive immutable identity changed");
      manifest.buckets[prefix] = {
        digest: contentDigest,
        count: bucket.records.length,
        bytes: Buffer.byteLength(contents),
        recoveryBytes: originalBytes + addedBytes,
      };
      manifest.authentication = this.authenticate(manifest.buckets);
      const next: LedgerState = { ...state, schema: 2, archives: manifest };
      next.records = { ...state.records };
      for (const record of moved) delete next.records[record.id];
      this.retained = true;
      return next;
    }
    return state;
  }
}
