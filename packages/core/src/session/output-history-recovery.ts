/** Explicit, evidence-preserving recovery of a known historical display gap. */
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TranscriptEvent } from "../types.js";
import type {
  OutputHistoryRecoveryAcceptance,
  OutputHistoryRecoveryPlan,
  OutputHistoryRecoveryResult,
  OutputHistoryRecoveryReason,
  OutputHistoryComparison,
} from "../protocol/output-history-recovery-types.js";
import { lockSync } from "../utils/lockfile.js";
import { STATE_LEASE_LOCK_OPTIONS } from "./output-journal-state-lease.js";
import { readOutputJournal } from "./output-journal.js";
import { createOutputJournalBinding, outputJournalAnchorName } from "./output-journal-binding.js";
import {
  initializePublishedOutputHead,
  outputJournalHeadName,
  readPublishedOutputHead,
} from "./output-journal-head.js";
import { compareOutputHistory } from "./output-history-comparison.js";
import { compareNativeOutputHistory } from "./output-history-native-comparison.js";
import {
  outputHistoryEventGroups,
  checkpointOutputHistoryRecords,
} from "./output-history-events.js";
import { hasHistoricalOutputGap } from "./output-history-gap.js";
import { SessionOutputCoverageStore } from "./output-coverage-state.js";

const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 96 * 1024 * 1024;
const MAX_FRAMES = 100_000;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const safeId = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
export interface OutputHistoryRecoveryAuthority {
  /** Host-owned authorization identity; a plan token never replaces authorization. */
  key: string;
  assertCurrent(): void;
}
export interface OutputHistoryRecoveryEvidence {
  /** Trusted Host-only file, such as this exact Session's renderer cache. */
  path: string;
  name: string;
}
class Refusal extends Error {
  constructor(readonly reason: OutputHistoryRecoveryReason) {
    super(reason);
  }
}
const requireProof = (
  value: unknown,
  reason: OutputHistoryRecoveryReason = "unavailable",
): void => {
  if (!value) throw new Refusal(reason);
};
function stamp(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function readFile(path: string, name: string) {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    requireProof(
      before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(MAX_FILE),
    );
    const data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      requireProof(count > 0);
      offset += count;
    }
    const named = fs.lstatSync(path, { bigint: true });
    requireProof(
      stamp(before) === stamp(fs.fstatSync(fd, { bigint: true })) &&
        stamp(before) === stamp(named) &&
        !named.isSymbolicLink(),
    );
    return { name, path, data, sha256: sha(data), stamp: stamp(before) };
  } finally {
    fs.closeSync(fd);
  }
}
function jsonLines(data: Buffer): any[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  requireProof(text.endsWith("\n"), "unsupported_history");
  const lines = text.slice(0, -1).split("\n");
  requireProof(lines.length > 0 && lines.length <= MAX_FRAMES, "unsupported_history");
  return lines.map((line) => JSON.parse(line));
}
function writeExclusive(path: string, data: Buffer) {
  const fd = fs.openSync(
    path,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    let offset = 0;
    while (offset < data.length) {
      const count = fs.writeSync(fd, data, offset, data.length - offset, offset);
      requireProof(count > 0, "storage_error");
      offset += count;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(path, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function privateDirectory(path: string) {
  try {
    fs.mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(path);
  requireProof(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (process.platform === "win32" ||
        ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.())),
    "storage_error",
  );
}

/** Root and evidence paths are supplied by the trusted Host, never by IPC/WS payloads. */
export class OutputHistoryRecovery {
  private readonly plans = new Map<
    string,
    {
      sessionId: string;
      owner: string;
      fingerprint: string;
      expires: number;
      comparison: OutputHistoryComparison;
    }
  >();
  constructor(
    private readonly root: () => string,
    private readonly options: {
      evidence?: (sessionId: string) => OutputHistoryRecoveryEvidence[];
      onCheckpoint?: (phase: "evidence-durable" | "epoch-durable" | "state-durable") => void;
    } = {},
  ) {}

  private inspect(sessionId: string, authority: OutputHistoryRecoveryAuthority) {
    authority.assertCurrent();
    requireProof(safeId.test(sessionId) && !sessionId.includes(".."));
    const root = fs.realpathSync(this.root()),
      directory = join(root, sessionId);
    const directoryStat = fs.lstatSync(directory, { bigint: true });
    requireProof(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
    const stateFile = readFile(join(directory, "state.json"), "state.json");
    requireProof(stateFile.data.length <= 1024 * 1024);
    const state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stateFile.data));
    requireProof(
      state.sessionId === sessionId &&
        Number.isFinite(state.startedAt) &&
        !state.ephemeral &&
        !state.parentSessionId &&
        state.kind !== "pet",
    );
    requireProof(
      state.stateRevision === undefined ||
        (Number.isSafeInteger(state.stateRevision) && state.stateRevision >= 0),
    );
    // Persisted status can outlive a worker. The Host authority proves actual
    // quiescence; the complete closed-turn comparison below proves the source.
    requireProof(
      !state.outputRecoveryIncomplete && !state.outputJournalStorage,
      "unsupported_history",
    );
    requireProof(state.outputCoverage?.unpaired === true, "not_needed");
    const coverage = new SessionOutputCoverageStore(() => root).read(sessionId);
    requireProof(coverage.status === "ok" && coverage.unpaired, "unsupported_history");
    const journal = readFile(
      join(directory, outputJournalAnchorName(state.outputJournalBinding)),
      "journal.jsonl",
    );
    const head = readFile(
      join(directory, outputJournalHeadName(state.outputJournalHead)),
      "head.json",
    );
    const transcript = readFile(join(directory, "transcript.jsonl"), "transcript.jsonl");
    const files = [stateFile, journal, head, transcript];
    try {
      files.push(readFile(join(directory, "external-runtime.json"), "external-runtime.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const extra of this.options.evidence?.(sessionId) ?? []) {
      requireProof(
        /^[a-z][a-z0-9.-]{0,63}$/.test(extra.name) &&
          !files.some((file) => file.name === extra.name),
      );
      files.push(readFile(extra.path, extra.name));
    }
    requireProof(
      files.reduce((total, file) => total + file.data.length, 0) <= MAX_TOTAL,
      "unsupported_history",
    );
    let after: string | undefined,
      through: string | undefined,
      count = 0;
    do {
      const page = readOutputJournal(root, sessionId, { after, through });
      requireProof(page.status === "ok" && !page.uncommittedTail, "unsupported_history");
      count += page.frames.length;
      requireProof(count <= MAX_FRAMES, "unsupported_history");
      through ??= page.through;
      if (page.complete) break;
      requireProof(page.next && page.next !== after);
      after = page.next;
    } while (after);
    const raw = jsonLines(journal.data),
      header = raw.shift();
    requireProof(raw.length === count, "unsupported_history");
    const position = JSON.parse(Buffer.from(through!, "base64url").toString("utf8"));
    requireProof(
      position.offset === journal.data.length &&
        position.sequence === raw.length &&
        position.hash === raw.at(-1)?.hash,
    );
    const native = jsonLines(transcript.data) as TranscriptEvent[];
    const groups = outputHistoryEventGroups(raw);
    const events = groups.map((group) => group.event);
    const originalEventsHash = sha(JSON.stringify(events));
    const external = compareOutputHistory(native, events, sessionId, state.cwd);
    const compared = external.ok
      ? external
      : compareNativeOutputHistory(native, events, sessionId, state.cwd, {
          legacyBaseThroughEventId: header.legacyBaseThroughEventId,
          terminalStatus: state.status,
        });
    if (!compared.ok) throw new Refusal(compared.reason);
    requireProof(sha(JSON.stringify(events)) === originalEventsHash, "history_mismatch");
    const checkpointEvents = compared.checkpointEvents ?? events;
    const checkpointRecords = checkpointOutputHistoryRecords(groups, checkpointEvents, sessionId);
    requireProof(checkpointRecords.length <= MAX_FRAMES, "unsupported_history");
    const proofSha256 = sha(JSON.stringify({ comparison: compared.comparison, checkpointEvents }));
    const inputIds = new Set(
      checkpointEvents
        .filter((event) => event.type === "session_user_message")
        .map((event) => event.clientMessageId),
    );
    requireProof(
      Array.isArray(state.outputCoverage.inputIds) &&
        state.outputCoverage.inputIds.every(
          (id: unknown) => typeof id === "string" && inputIds.has(id),
        ),
      "history_mismatch",
    );
    const fingerprint = sha(
      JSON.stringify([
        root,
        String(directoryStat.dev),
        String(directoryStat.ino),
        files.map(({ name, path, sha256, stamp }) => ({ name, path, sha256, stamp })),
        proofSha256,
      ]),
    );
    authority.assertCurrent();
    // Reading/projection cannot authorize a source that changed across the scan.
    requireProof(
      files.every((file) => {
        const now = readFile(file.path, file.name);
        return now.stamp === file.stamp && now.sha256 === file.sha256;
      }),
      "stale",
    );
    return {
      root,
      directory,
      state,
      files,
      journal,
      transcript,
      raw,
      checkpointRecords,
      proofSha256,
      header,
      fingerprint,
      comparison: compared.comparison,
    };
  }

  plan(sessionId: string, authority: OutputHistoryRecoveryAuthority): OutputHistoryRecoveryPlan {
    try {
      const source = this.inspect(sessionId, authority);
      for (const [id, plan] of this.plans)
        if (plan.expires < Date.now() || plan.owner === authority.key) this.plans.delete(id);
      if (this.plans.size >= 16) return { status: "blocked", sessionId, reason: "busy" };
      const planId = randomUUID();
      this.plans.set(planId, {
        sessionId,
        owner: authority.key,
        fingerprint: source.fingerprint,
        comparison: source.comparison,
        expires: Date.now() + 10 * 60_000,
      });
      return {
        status: "ready",
        sessionId,
        planId,
        historicalGap: true,
        notice: "historical_notifications_incomplete",
        comparison: source.comparison,
      };
    } catch (error) {
      return {
        status: "blocked",
        sessionId,
        reason: error instanceof Refusal ? error.reason : "unavailable",
      };
    }
  }

  /** Read-only preflight before the Host closes an idle runtime. Also settles a lost ack. */
  validate(
    sessionId: string,
    input: OutputHistoryRecoveryAcceptance,
    authority: OutputHistoryRecoveryAuthority,
  ): OutputHistoryRecoveryResult | undefined {
    if (input?.acceptHistoricalGap !== true)
      return { status: "blocked", sessionId, reason: "confirmation_required" };
    try {
      authority.assertCurrent();
      requireProof(safeId.test(sessionId) && !sessionId.includes(".."));
      const directory = join(fs.realpathSync(this.root()), sessionId);
      const namedDirectory = fs.lstatSync(directory);
      requireProof(namedDirectory.isDirectory() && !namedDirectory.isSymbolicLink());
      const current = JSON.parse(
        readFile(join(directory, "state.json"), "state.json").data.toString("utf8"),
      );
      if (
        current.sessionId === sessionId &&
        hasHistoricalOutputGap(current) &&
        current.outputHistoryRecovery.planId === input.planId
      )
        return { status: "applied", sessionId, historicalGap: true };
      const plan = this.plans.get(input.planId);
      if (
        !plan ||
        plan.sessionId !== sessionId ||
        plan.owner !== authority.key ||
        plan.expires < Date.now()
      )
        return { status: "stale", sessionId, reason: "stale" };
      const source = this.inspect(sessionId, authority);
      requireProof(source.fingerprint === plan.fingerprint, "stale");
      return undefined;
    } catch (error) {
      const reason = error instanceof Refusal ? error.reason : "unavailable";
      return { status: reason === "stale" ? "stale" : "blocked", sessionId, reason };
    }
  }

  apply(
    sessionId: string,
    input: OutputHistoryRecoveryAcceptance,
    authority: OutputHistoryRecoveryAuthority,
  ): OutputHistoryRecoveryResult {
    const validated = this.validate(sessionId, input, authority);
    if (validated) return validated;
    const plan = this.plans.get(input.planId)!;
    let release: (() => void) | undefined;
    let committed = false;
    try {
      authority.assertCurrent();
      const root = fs.realpathSync(this.root()),
        directory = join(root, sessionId),
        statePath = join(directory, "state.json");
      release = lockSync(statePath, STATE_LEASE_LOCK_OPTIONS);
      const lease = fs.lstatSync(statePath + ".lock", { bigint: true });
      const admittedDirectory = fs.lstatSync(directory, { bigint: true });
      const assertLease = () => {
        const current = fs.lstatSync(statePath + ".lock", { bigint: true });
        const namedDirectory = fs.lstatSync(directory, { bigint: true });
        requireProof(
          current.isDirectory() &&
            !current.isSymbolicLink() &&
            current.dev === lease.dev &&
            current.ino === lease.ino &&
            namedDirectory.isDirectory() &&
            !namedDirectory.isSymbolicLink() &&
            namedDirectory.dev === admittedDirectory.dev &&
            namedDirectory.ino === admittedDirectory.ino &&
            fs.realpathSync(this.root()) === root,
          "stale",
        );
        fs.utimesSync(statePath + ".lock", new Date(), new Date());
        authority.assertCurrent();
      };
      const source = this.inspect(sessionId, authority);
      requireProof(source.fingerprint === plan.fingerprint, "stale");
      const id = randomUUID(),
        evidenceRoot = join(directory, ".output-history-recovery"),
        evidence = join(evidenceRoot, id);
      privateDirectory(evidenceRoot);
      privateDirectory(evidence);
      for (const file of source.files) {
        assertLease();
        writeExclusive(join(evidence, file.name), file.data);
      }
      syncDirectory(evidence);
      syncDirectory(evidenceRoot);
      this.options.onCheckpoint?.("evidence-durable");
      assertLease();
      const header = {
        ...source.header,
        journalId: randomUUID(),
        sessionIncarnation: randomUUID(),
      };
      const headerText = JSON.stringify(header) + "\n",
        seed = sha(headerText);
      let previousHash = seed;
      const lines = [headerText];
      let sequence = 0;
      for (const record of source.checkpointRecords) {
        const { hash: _oldHash, previousHash: _oldPrevious, ...rest } = record;
        const value = { ...rest, sequence: ++sequence, previousHash };
        previousHash = sha(JSON.stringify(value));
        lines.push(JSON.stringify({ ...value, hash: previousHash }) + "\n");
      }
      const data = Buffer.from(lines.join("")),
        anchorName = `output-journal-${id}.jsonl`,
        headName = `output-journal-head-${id}.json`;
      requireProof(data.length <= MAX_FILE, "unsupported_history");
      const identity = sha(randomUUID()),
        incarnation = sha(randomUUID());
      writeExclusive(join(directory, anchorName), data);
      const fd = fs.openSync(
        join(directory, anchorName),
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      let binding;
      try {
        binding = createOutputJournalBinding(
          root,
          directory,
          fd,
          identity,
          incarnation,
          anchorName,
        );
      } finally {
        fs.closeSync(fd);
      }
      const head = initializePublishedOutputHead(
        directory,
        {
          version: 1,
          identity,
          sequence,
          offset: data.length,
          hash: previousHash,
        },
        headName,
      );
      requireProof(
        readFile(join(directory, anchorName), "epoch").sha256 === sha(data),
        "storage_error",
      );
      readPublishedOutputHead(directory, head);
      const acceptedAt = new Date().toISOString();
      const receipt = Buffer.from(
        JSON.stringify(
          {
            version: 1,
            recoveryId: id,
            planId: input.planId,
            sessionId,
            acceptedAt,
            historicalGap: true,
            comparison: source.comparison,
            proofSha256: source.proofSha256,
            insertedFrames: source.checkpointRecords.length - source.raw.length,
            source: source.files.map(({ name, sha256, stamp }) => ({ name, sha256, stamp })),
            epoch: { anchorName, journalSha256: sha(data), identity, incarnation, headName },
          },
          null,
          2,
        ) + "\n",
      );
      writeExclusive(join(evidence, "receipt.json"), receipt);
      syncDirectory(evidence);
      syncDirectory(directory);
      this.options.onCheckpoint?.("epoch-durable");
      assertLease();
      requireProof(
        source.files.every(
          (file) => readFile(join(evidence, file.name), file.name).sha256 === file.sha256,
        ) && readFile(join(evidence, "receipt.json"), "receipt").sha256 === sha(receipt),
        "storage_error",
      );
      // Atomic state publication selects an already durable, verified pair.
      // Crashes before this rename leave the entire old epoch authoritative.
      requireProof(
        source.files.every((file) => {
          const now = readFile(file.path, file.name);
          return now.stamp === file.stamp && now.sha256 === file.sha256;
        }),
        "stale",
      );
      const next = {
        ...source.state,
        stateRevision: (source.state.stateRevision ?? 0) + 1,
        outputJournalIdentity: seed,
        outputJournalBinding: binding,
        outputJournalHead: head,
        outputCoverageIdentity: incarnation,
        outputCoverage: {
          version: 1,
          incarnation,
          journalIdentity: seed,
          unpaired: false,
          inputIds: [],
        },
        outputHistoryRecovery: {
          version: 1,
          recoveryId: id,
          planId: input.planId,
          historicalGap: true,
          acceptedAt,
          sourceJournalSha256: source.journal.sha256,
          transcriptSha256: source.transcript.sha256,
          receiptSha256: sha(receipt),
          notice: "historical_notifications_incomplete",
        },
      };
      const stateBytes = Buffer.from(JSON.stringify(next, null, 2) + "\n");
      requireProof(stateBytes.length <= 1024 * 1024, "storage_error");
      const temporary = join(directory, `.output-history-state-${id}.tmp`);
      writeExclusive(temporary, stateBytes);
      assertLease();
      fs.renameSync(temporary, statePath);
      syncDirectory(directory);
      committed = true;
      this.plans.delete(input.planId);
      this.options.onCheckpoint?.("state-durable");
      return { status: "applied", sessionId, historicalGap: true };
    } catch (error) {
      // A lost acknowledgement never rolls back a committed epoch or repeats a write.
      if (committed) return { status: "applied", sessionId, historicalGap: true };
      const reason = error instanceof Refusal ? error.reason : "storage_error";
      return { status: reason === "stale" ? "stale" : "blocked", sessionId, reason };
    } finally {
      release?.();
    }
  }
}
