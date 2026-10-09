import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { retentionPlan, seedRetentionMetadata } from "./operation-retention-data.mjs";

function authenticate(key, buckets) {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        "operation-archive-manifest-v1",
        Object.entries(buckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([prefix, entry]) => [
            prefix,
            entry.digest,
            entry.count,
            entry.bytes,
            entry.recoveryBytes,
          ]),
      ]),
    )
    .digest("hex");
}
function writeBucket(directory, key, prefix, records, recovery) {
  const contents = JSON.stringify({ schema: 1, prefix, records, recovery });
  const digest = createHmac("sha256", key)
    .update(JSON.stringify(["operation-archive-bucket-v1", prefix, contents]))
    .digest("hex");
  fs.writeFileSync(join(directory, `${prefix}-${digest}.json`), contents, { mode: 0o600 });
  return { digest, count: records.length, bytes: Buffer.byteLength(contents), recoveryBytes: 0 };
}

/** Metadata capacity fixtures are explicitly not hundreds of thousands of provider writes. */
export async function runRetentionCapacity({
  home,
  cipher,
  OperationLedger,
  launch,
  origin,
  criticalMetrics,
}) {
  const { recordSchema } = await import("../../packages/core/dist/operations/schema.js");
  const { OperationArchives, ledgerStateSchema, OPERATION_ARCHIVE_RECOVERY_MAX_BYTES } =
    await import("../../packages/core/dist/operations/archive.js");
  const { OperationRecoveryFiles } =
    await import("../../packages/core/dist/operations/recovery.js");
  const { mutateJsonFile } = await import("../../packages/core/dist/utils/file-mutex.js");
  const seedRoot = () => {
    const root = fs.mkdtempSync(join(home, "capacity-"));
    const ledger = new OperationLedger(root, cipher);
    const planned = ledger.prepare(retentionPlan());
    const attempt = ledger.claim(planned.id).receipt.attemptId;
    ledger.settle(planned.id, attempt, "succeeded", { reference: { id: "capacity/reference" } });
    const receipt = ledger.settle(planned.id, attempt, "verified");
    return { root, ledger, receipt, file: join(root, ".operations", "ledger.json") };
  };

  const full = seedRoot();
  const seeded = seedRetentionMetadata(full.root, 10_000, {
    decrypt: (value) => cipher.decrypt(value),
  });
  const key = Buffer.from(cipher.decrypt(seeded.state.key), "hex");
  const archiveDirectory = join(full.root, ".operations", "archives");
  fs.mkdirSync(archiveDirectory, { mode: 0o700 });
  const buckets = {};
  let maxBucketBytes = 0;
  // Use maximally sized ordinary receipt fields without fictional recovery bodies.
  const template = recordSchema.parse({
    ...full.receipt,
    service: "s".repeat(100),
    action: "a".repeat(100),
    channel: "c".repeat(100),
    reference: { id: "r".repeat(300) },
    ownerIncarnation: "e".repeat(64),
    createdAt: Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER,
    verifiedAt: Number.MAX_SAFE_INTEGER,
    error: "postcondition_failed",
  });
  for (let index = 0; index < 256; index++) {
    const prefix = index.toString(16).padStart(2, "0");
    const records = Array.from({ length: 1024 }, (_, offset) =>
      recordSchema.parse({ ...template, id: prefix + offset.toString(16).padStart(62, "0") }),
    );
    const recovery = Object.fromEntries(
      records.map((record) => [record.id, { bytes: 0, slots: [] }]),
    );
    buckets[prefix] = writeBucket(archiveDirectory, key, prefix, records, recovery);
    maxBucketBytes = Math.max(maxBucketBytes, buckets[prefix].bytes);
  }
  delete seeded.state.records[full.receipt.id];
  // Replace the removed seed so this is still an actual full 10,000-record ledger.
  const extra = {
    ...full.receipt,
    id: createHmac("sha256", key).update("extra-capacity-id").digest("hex"),
  };
  seeded.state.records[extra.id] = extra;
  const state = {
    ...seeded.state,
    schema: 2,
    archives: { buckets, authentication: authenticate(key, buckets) },
  };
  state.records = Object.fromEntries(
    Object.keys(state.records).map((id) => [id, { ...template, id }]),
  );
  state.observations = {};
  const activeLimit = 16 * 1024 * 1024 - 512;
  let activeBytes = Buffer.byteLength(JSON.stringify(state));
  let observationEntries = 0;
  for (const id of Object.keys(state.records)) {
    const history = [];
    for (let offset = 0; offset < 20; offset++) {
      const next = {
        id: randomUUID(),
        at: Number.MAX_SAFE_INTEGER,
        reviewedRevision: "a".repeat(64),
        ownerIncarnation: "b".repeat(64),
        result: "matches_current",
        actions: ["a".repeat(100), "b".repeat(100)],
        evidence: "c".repeat(64),
      };
      const candidate = [...history, next];
      const increment = history.length
        ? Buffer.byteLength(JSON.stringify(candidate)) - Buffer.byteLength(JSON.stringify(history))
        : Buffer.byteLength(JSON.stringify(id)) +
          1 +
          Buffer.byteLength(JSON.stringify(candidate)) +
          (observationEntries ? 1 : 0);
      if (activeBytes + increment > activeLimit) break;
      activeBytes += increment;
      history.push(next);
      if (history.length === 1) observationEntries++;
      state.observations[id] = history;
    }
    if (history.length < 20) break;
  }
  const canonical = JSON.stringify(state);
  assert.ok(activeLimit - Buffer.byteLength(canonical) < 1024);
  const padded = canonical + " ".repeat(activeLimit - Buffer.byteLength(canonical));
  fs.writeFileSync(full.file, padded, { mode: 0o600 });
  const originalHash = createHmac("sha256", key).update(fs.readFileSync(full.file)).digest("hex");
  const reads = [];
  const readBytes = [];
  const open = fs.openSync;
  const observedOpen = (path, ...args) => {
    if (String(path).startsWith(archiveDirectory) && String(path).endsWith(".json")) {
      reads.push(String(path));
      readBytes.push(fs.statSync(path).size);
    }
    return open(path, ...args);
  };
  fs.openSync = observedOpen;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => new OperationLedger(full.root, cipher).prepare(retentionPlan("full-cold-matrix")),
      /ledger is full/,
    );
    assert.equal(
      reads.length,
      1,
      "retain skips all 256 count-full buckets without whole-history reads",
    );
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
  }
  const fullCountCriticalMs = criticalMetrics.at(-1);
  assert.equal(
    createHmac("sha256", key).update(fs.readFileSync(full.file)).digest("hex"),
    originalHash,
  );
  const contention = await Promise.all(
    Array.from({ length: 8 }, () => launch("full-reject", full.root, origin)),
  );

  // An authenticated metadata-only prefix may be byte-full before count-full.
  // Deliberately noncanonical padding is never accepted by an affected lookup;
  // this negative fixture proves unrelated byte-full prefixes are skipped rather
  // than causing a 512 MiB content reread while the original lock is held.
  const targetPrefix = createHmac("sha256", key)
    .update(JSON.stringify(["intent", [retentionPlan().sessionId, "full-cold-matrix", null]]))
    .digest("hex")
    .slice(0, 2);
  const savedDirectory = join(full.root, "capacity-original-buckets");
  fs.mkdirSync(savedDirectory, { mode: 0o700 });
  const byteFull = structuredClone(state);
  let affectedId;
  for (const [prefix, entry] of Object.entries(buckets)) {
    if (prefix === targetPrefix) continue;
    const name = `${prefix}-${entry.digest}.json`;
    const original = join(archiveDirectory, name);
    const parsed = JSON.parse(fs.readFileSync(original, "utf8"));
    const removed = parsed.records.pop();
    delete parsed.recovery[removed.id];
    affectedId ??= parsed.records[0].id;
    const canonical = JSON.stringify(parsed);
    const contents = canonical + " ".repeat(2 * 1024 * 1024 - Buffer.byteLength(canonical));
    const digest = createHmac("sha256", key)
      .update(JSON.stringify(["operation-archive-bucket-v1", prefix, contents]))
      .digest("hex");
    fs.renameSync(original, join(savedDirectory, name));
    fs.writeFileSync(join(archiveDirectory, `${prefix}-${digest}.json`), contents, { mode: 0o600 });
    byteFull.archives.buckets[prefix] = { ...entry, digest, count: 1023, bytes: 2 * 1024 * 1024 };
  }
  byteFull.archives.authentication = authenticate(key, byteFull.archives.buckets);
  const byteFullContents = JSON.stringify(byteFull);
  fs.writeFileSync(
    full.file,
    byteFullContents + " ".repeat(Buffer.byteLength(padded) - Buffer.byteLength(byteFullContents)),
    { mode: 0o600 },
  );
  const byteFullBeforeReads = reads.length;
  let byteFullCriticalMs;
  fs.openSync = observedOpen;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => new OperationLedger(full.root, cipher).prepare(retentionPlan("full-cold-matrix")),
      /ledger is full/,
    );
    assert.equal(reads.length - byteFullBeforeReads, 1);
    byteFullCriticalMs = criticalMetrics.at(-1);
    assert.throws(
      () => new OperationLedger(full.root, cipher).claim(affectedId),
      /identity mismatch/,
    );
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
    // Explicit fixture reconstruction; production never discards unknown versions.
    for (const [prefix, entry] of Object.entries(byteFull.archives.buckets)) {
      if (prefix === targetPrefix) continue;
      fs.rmSync(join(archiveDirectory, `${prefix}-${entry.digest}.json`));
      const originalName = `${prefix}-${buckets[prefix].digest}.json`;
      fs.renameSync(join(savedDirectory, originalName), join(archiveDirectory, originalName));
    }
    fs.writeFileSync(full.file, padded, { mode: 0o600 });
  }

  // One different prefix can still make progress; target lookup and retain can read two buckets.
  const first = Object.values(state.records)
    .filter((record) => state.observations?.[record.id] === undefined)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
  const candidatePrefix = first.id.slice(0, 2);
  const oldEntry = buckets[candidatePrefix];
  const candidateFile = join(archiveDirectory, `${candidatePrefix}-${oldEntry.digest}.json`);
  const candidate = JSON.parse(fs.readFileSync(candidateFile, "utf8"));
  const removed = candidate.records.pop();
  delete candidate.recovery[removed.id];
  buckets[candidatePrefix] = writeBucket(
    archiveDirectory,
    key,
    candidatePrefix,
    candidate.records,
    candidate.recovery,
  );
  // Construct a different valid capacity fixture, rather than restore a partial
  // historical manifest. A real unreferenced generation with an uncovered ID
  // must be preserved and fail closed (covered by the rollback acceptance case).
  fs.rmSync(candidateFile);
  state.archives.authentication = authenticate(key, buckets);
  const progressContents = JSON.stringify(state);
  fs.writeFileSync(
    full.file,
    progressContents + " ".repeat(activeLimit - Buffer.byteLength(progressContents)),
    { mode: 0o600 },
  );
  let intent = "two-prefix-compaction";
  while (
    createHmac("sha256", key)
      .update(JSON.stringify(["intent", [retentionPlan().sessionId, intent, null]]))
      .digest("hex")
      .startsWith(candidatePrefix)
  )
    intent += "x";
  const lookupPrefix = createHmac("sha256", key)
    .update(JSON.stringify(["intent", [retentionPlan().sessionId, intent, null]]))
    .digest("hex")
    .slice(0, 2);
  // The two permitted unreferenced immutable generations are complete subsets
  // of their current prefixes. GC proves coverage before deleting either one.
  for (const prefix of Object.keys(buckets)
    .filter((prefix) => prefix !== candidatePrefix && prefix !== lookupPrefix)
    .slice(0, 2)) {
    const entry = buckets[prefix];
    const current = JSON.parse(
      fs.readFileSync(join(archiveDirectory, `${prefix}-${entry.digest}.json`), "utf8"),
    );
    const records = current.records.slice(0, 1023);
    writeBucket(
      archiveDirectory,
      key,
      prefix,
      records,
      Object.fromEntries(records.map((record) => [record.id, current.recovery[record.id]])),
    );
  }
  const beforeReadCount = reads.length;
  fs.openSync = observedOpen;
  syncBuiltinESMExports();
  try {
    const prepared = new OperationLedger(full.root, cipher).prepare(retentionPlan(intent));
    assert.equal(prepared.state, "planned");
    assert.equal(reads.length - beforeReadCount, 7);
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
  }
  const gcLookupRetainReadbackCriticalMs = criticalMetrics.at(-1);
  const gcLookupRetainReadbackContentBytes = readBytes
    .slice(beforeReadCount)
    .reduce((sum, bytes) => sum + bytes, 0);

  // Real encrypted physical files, not sparse sizes or invented quota counters.
  const recoveryFixture = seedRoot();
  const recoveryState = JSON.parse(fs.readFileSync(recoveryFixture.file, "utf8"));
  const recoveryKey = Buffer.from(cipher.decrypt(recoveryState.key), "hex");
  recoveryState.records = {};
  const recoveryFiles = new OperationRecoveryFiles(join(recoveryFixture.root, ".operations"));
  let physicalBytes = 0;
  let slots = 0;
  let records = 0;
  const maxPlaintext = JSON.stringify("x".repeat(512 * 1024 - 2));
  let maxEnvelopeBytes;
  while (physicalBytes < OPERATION_ARCHIVE_RECOVERY_MAX_BYTES - 256) {
    const id = "aa" + (++records).toString(16).padStart(62, "0");
    const references = [];
    for (let slot = 0; slot < 2; slot++) {
      const remaining = OPERATION_ARCHIVE_RECOVERY_MAX_BYTES - physicalBytes;
      let plaintext = slot ? maxPlaintext.replace(/^"x/, '"y') : maxPlaintext;
      if (maxEnvelopeBytes && remaining < maxEnvelopeBytes) {
        // JSON envelope grows by four bytes per three plaintext bytes; leave <=3 bytes slack.
        const fixed = maxEnvelopeBytes - 4 * Math.ceil(Buffer.byteLength(maxPlaintext) / 3);
        const length = Math.max(2, 3 * Math.floor((remaining - fixed) / 4));
        plaintext = JSON.stringify("z".repeat(length - 2));
      }
      const digest = recoveryFiles.save(recoveryKey, id, plaintext);
      const file = join(recoveryFixture.root, ".operations", "recovery", id, `${digest}.json`);
      const bytes = fs.statSync(file).size;
      maxEnvelopeBytes ??= bytes;
      assert.ok(bytes <= remaining);
      physicalBytes += bytes;
      slots++;
      references.push(digest);
      if (OPERATION_ARCHIVE_RECOVERY_MAX_BYTES - physicalBytes < 256) break;
    }
    recoveryState.records[id] = recordSchema.parse({
      ...recoveryFixture.receipt,
      id,
      createdAt: records,
      recovery: { prepared: references[0], ...(references[1] ? { identity: references[1] } : {}) },
    });
  }
  fs.writeFileSync(recoveryFixture.file, JSON.stringify(recoveryState), { mode: 0o600 });
  for (;;) {
    const moved = mutateJsonFile(recoveryFixture.file, {
      parse: (raw) => ledgerStateSchema.parse(JSON.parse(raw)),
      serialize: JSON.stringify,
      mutation: (current) => {
        const store = new OperationArchives(
          join(recoveryFixture.root, ".operations"),
          recoveryKey,
          current,
        );
        store.collect();
        const next = store.retain(true);
        return {
          value: next,
          result: Object.keys(current.records).length - Object.keys(next.records).length,
        };
      },
    });
    if (!moved) break;
  }
  const retained = JSON.parse(fs.readFileSync(recoveryFixture.file, "utf8"));
  assert.equal(Object.keys(retained.records).length, 0);
  assert.equal(retained.archives.buckets.aa.recoveryBytes, physicalBytes);
  assert.ok(OPERATION_ARCHIVE_RECOVERY_MAX_BYTES - physicalBytes < 256);
  const extraId = "aa" + (records + 1).toString(16).padStart(62, "0");
  const extraDigest = recoveryFiles.save(
    recoveryKey,
    extraId,
    JSON.stringify("quota overflow".repeat(50)),
  );
  retained.records[extraId] = recordSchema.parse({
    ...recoveryFixture.receipt,
    id: extraId,
    recovery: { prepared: extraDigest },
  });
  fs.writeFileSync(recoveryFixture.file, JSON.stringify(retained), { mode: 0o600 });
  const before = fs.readFileSync(recoveryFixture.file);
  assert.throws(
    () =>
      mutateJsonFile(recoveryFixture.file, {
        parse: (raw) => ledgerStateSchema.parse(JSON.parse(raw)),
        serialize: JSON.stringify,
        mutation: (current) => {
          const store = new OperationArchives(
            join(recoveryFixture.root, ".operations"),
            recoveryKey,
            current,
          );
          store.collect();
          return { value: store.retain(true) };
        },
      }),
    /recovery capacity is full/,
  );
  assert.deepEqual(fs.readFileSync(recoveryFixture.file), before);
  assert.ok(
    fs.existsSync(
      join(recoveryFixture.root, ".operations", "recovery", extraId, `${extraDigest}.json`),
    ),
  );
  key.fill(0);
  recoveryKey.fill(0);
  return {
    fullBuckets: 256,
    archivedMetadataRecords: 256 * 1024,
    activeBytes: Buffer.byteLength(padded),
    activeCanonicalBytes: Buffer.byteLength(canonical),
    maxCanonicalBucketBytes: maxBucketBytes,
    fullRetainBucketReads: 0,
    prepareTargetReads: 1,
    byteFullMetadataPrefixes: 255,
    byteFullMetadataBytes: 2 * 1024 * 1024,
    byteFullRetainReads: 0,
    affectedNoncanonicalLookupRejected: true,
    twoPrefixPrepareExistingReads: 2,
    coveredOrphanReads: 2,
    orphanCoverageCurrentPrefixReads: 2,
    immutableReadbackReads: 1,
    gcLookupRetainReadbackTotalReads: 7,
    gcLookupRetainReadbackContentBytes,
    matrixCriticalMs: {
      fullCount: fullCountCriticalMs,
      byteFullMetadata: byteFullCriticalMs,
      gcLookupRetainReadback: gcLookupRetainReadbackCriticalMs,
    },
    contentionPids: contention.map((result) => result.pid),
    recovery: {
      physicalBytes,
      quota: OPERATION_ARCHIVE_RECOVERY_MAX_BYTES,
      slots,
      records,
      sparse: false,
      pruned: false,
    },
  };
}
