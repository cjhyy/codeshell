/** Whole-history private fixture reader. No tail-only shortcut, publication or repair. */
import { createHash } from "node:crypto";
import {
  assertAsyncJournalSnapshot,
  assertAsyncLease,
  readAsyncAt,
  readAsyncStateUnderLease,
  yieldAsyncLease,
  type AsyncFile,
  type AsyncJournalSnapshot,
  type AsyncLease,
} from "./async-io.js";
import {
  canonicalSteps,
  EVENT_ID,
  fail,
  HEX,
  integer,
  object,
  parseJSONSteps,
  StorageFailure,
  type DecodedState,
} from "./codec.js";
import { AsyncIdentityIndex, type IndexReceipt } from "./id-index.js";
import { CHUNK_SIZE, RECORD_LIMIT } from "./io.js";
import {
  evaluateJournalStep,
  token,
  verifyJournalSteps,
  verifyStateSteps,
  type JournalStep,
  type JournalSteps,
  type VerifiedJournal,
} from "./journal.js";

type Line = { text: string; start: number; end: number };

/** Every async CPU step operates on internally parsed, unexposed disk JSON, never caller data. */
export class AsyncJournalReader {
  private cpuBytes = 0;
  private cpuSteps = 0;
  constructor(
    readonly lease: AsyncLease,
    readonly file: AsyncFile,
    readonly snapshot: AsyncJournalSnapshot,
  ) {
    assertAsyncLease(lease);
  }
  async checkpoint(bytes = 0, force = false): Promise<void> {
    this.cpuBytes += bytes;
    this.cpuSteps++;
    if (force || this.cpuBytes >= CHUNK_SIZE || this.cpuSteps >= 1024) {
      await yieldAsyncLease(this.lease);
      await assertAsyncJournalSnapshot(this.lease, this.file, this.snapshot);
      this.cpuBytes = this.cpuSteps = 0;
    }
    assertAsyncLease(this.lease);
  }
  async range(position: number, length: number): Promise<Buffer> {
    if (
      !integer(position) ||
      !integer(length) ||
      length > RECORD_LIMIT + 1 ||
      position + length > this.snapshot.size
    )
      fail("Bounded verified journal range required");
    const chunks: Buffer[] = [];
    let done = 0;
    while (done < length) {
      await assertAsyncJournalSnapshot(this.lease, this.file, this.snapshot);
      const chunk = await readAsyncAt(
        this.lease,
        this.file,
        Math.min(CHUNK_SIZE, length - done),
        position + done,
      );
      await assertAsyncJournalSnapshot(this.lease, this.file, this.snapshot);
      if (!chunk.length) fail("Journal read made no progress");
      chunks.push(chunk);
      done += chunk.length;
      await this.checkpoint(chunk.length, true);
    }
    return Buffer.concat(chunks, done);
  }
  async *lines(start = 0, end = this.snapshot.size): AsyncGenerator<Line> {
    if (!integer(start) || !integer(end) || start > end || end > this.snapshot.size)
      fail("Bounded journal line interval required");
    let offset = start;
    let pending = Buffer.alloc(0);
    while (offset < end) {
      const bytes = await this.range(offset, Math.min(CHUNK_SIZE, end - offset));
      offset += bytes.length;
      pending = Buffer.concat([pending, bytes]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        if (newline > RECORD_LIMIT)
          throw new StorageFailure("capacity", "Journal record byte bound");
        const end = offset - pending.length + newline + 1;
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          pending.subarray(0, newline),
        );
        pending = pending.subarray(newline + 1);
        yield { text, start: end - newline - 1, end };
      }
      if (pending.length > RECORD_LIMIT)
        throw new StorageFailure("capacity", "Journal record byte bound");
    }
    // A partial final line is deliberately not yielded; the shared validator marks it incomplete.
  }
  async parse(text: string, maxBytes: number): Promise<unknown> {
    const steps = parseJSONSteps(text, maxBytes);
    try {
      let next = steps.next();
      while (!next.done) {
        await this.checkpoint(CHUNK_SIZE);
        next = steps.next();
      }
      return next.value;
    } finally {
      steps.return(undefined);
    }
  }
  private async canonical(value: unknown, hash = false): Promise<string> {
    const steps = canonicalSteps(value);
    const chunks: string[] = [];
    const digest = hash ? createHash("sha256") : undefined;
    try {
      for (const chunk of steps) {
        if (digest) digest.update(chunk);
        else chunks.push(chunk);
        await this.checkpoint(Buffer.byteLength(chunk));
      }
      return digest ? digest.digest("hex") : chunks.join("");
    } finally {
      steps.return(undefined);
    }
  }
  async cpu(step: Exclude<JournalStep, { kind: "line" } | { kind: "add" }>): Promise<unknown> {
    switch (step.kind) {
      case "parse":
        return step.unique ? this.parse(step.text, step.maxBytes) : evaluateJournalStep(step);
      case "canonical":
        return this.canonical(step.value);
      case "digestCanonical":
        return this.canonical(step.value, true);
      case "projection":
        return this.canonical({ scope: step.scope, event: step.event, effect: step.effect }, true);
      case "digest": {
        const bytes = typeof step.value === "string" ? Buffer.from(step.value) : step.value;
        const hash = createHash("sha256");
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
          hash.update(chunk);
          await this.checkpoint(chunk.length);
        }
        return hash.digest("hex");
      }
      case "decode": {
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        const chunks: string[] = [];
        for (let offset = 0; offset < step.bytes.length; offset += CHUNK_SIZE) {
          const chunk = step.bytes.subarray(offset, offset + CHUNK_SIZE);
          chunks.push(decoder.decode(chunk, { stream: true }));
          await this.checkpoint(chunk.length);
        }
        chunks.push(decoder.decode());
        return chunks.join("");
      }
    }
  }
  async state(decoded: DecodedState, verified: VerifiedJournal): Promise<void> {
    if (decoded.state.outputJournalIdentity !== verified.pin)
      fail("Journal pin missing or replaced");
    const steps = verifyStateSteps(decoded, verified);
    try {
      let next = steps.next();
      while (!next.done) {
        if (next.value.kind === "line" || next.value.kind === "add")
          fail("Invalid state verification step");
        next = steps.next(await this.cpu(next.value));
      }
    } finally {
      steps.return(undefined);
    }
  }
  async binding(offset: number): Promise<string> {
    const iterator = this.lines(offset, Math.min(this.snapshot.size, offset + RECORD_LIMIT + 1));
    try {
      const first = await iterator.next();
      if (first.done) fail("Missing indexed binding");
      const raw = await this.parse(first.value.text, RECORD_LIMIT);
      if (!object(raw)) fail("Invalid indexed binding");
      const id = object(raw.tx) ? raw.tx.eventId : raw.eventId;
      if (typeof id !== "string" || !EVENT_ID.test(id)) fail("Invalid indexed event id");
      await assertAsyncJournalSnapshot(this.lease, this.file, this.snapshot);
      return id;
    } finally {
      await iterator.return(undefined);
    }
  }
  async receipt(identity: string, receipt: IndexReceipt): Promise<string> {
    const start = Math.max(0, receipt.offset - RECORD_LIMIT - 1);
    const bytes = await this.range(start, receipt.offset - start);
    if (bytes.at(-1) !== 0x0a) fail("Indexed receipt is not a record boundary");
    const previous = bytes.lastIndexOf(0x0a, bytes.length - 2);
    const raw = await this.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(previous + 1, -1),
      ),
      RECORD_LIMIT,
    );
    if (
      !object(raw) ||
      raw.sequence !== receipt.sequence ||
      typeof raw.hash !== "string" ||
      !HEX.test(raw.hash)
    )
      fail("Invalid indexed receipt");
    await assertAsyncJournalSnapshot(this.lease, this.file, this.snapshot);
    return token(identity, { sequence: receipt.sequence, offset: receipt.offset, hash: raw.hash });
  }
  async verify(decoded: DecodedState, index: AsyncIdentityIndex): Promise<VerifiedJournal> {
    const snapshot = this.snapshot;
    const steps: JournalSteps<VerifiedJournal> = verifyJournalSteps(
      this.lease.root,
      { dev: snapshot.directoryDev, ino: snapshot.directoryIno },
      snapshot,
      snapshot.size,
      snapshot.stamp,
      decoded,
    );
    const iterator = this.lines();
    try {
      let next = steps.next();
      while (!next.done) {
        const step = next.value;
        let result: unknown;
        if (step.kind === "line") {
          const line = await iterator.next();
          result = line.done ? undefined : line.value;
        } else if (step.kind === "add")
          await index.addVerified(step.eventId, step.projection, step.receipt, (offset) =>
            this.binding(offset),
          );
        else result = await this.cpu(step);
        assertAsyncLease(this.lease);
        next = steps.next(result);
      }
      const proof = next.value;
      await this.state(await readAsyncStateUnderLease(this.lease), proof);
      await assertAsyncJournalSnapshot(this.lease, this.file, snapshot);
      return proof;
    } finally {
      steps.return(undefined as never);
      await iterator.return(undefined);
    }
  }
}
