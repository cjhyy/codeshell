/** Session-owned output, persisted before publication. Transport epochs never enter this log. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { StreamEvent, TranscriptEvent } from "../types.js";
import { lockSync } from "../utils/lockfile.js";

const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_PAGE_FRAMES = 512;
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

interface Header {
  version: 1;
  storageScope: string;
  sessionIncarnation: string;
  journalId: string;
  sessionId: string;
  startedAt: number;
  legacyBaseThroughEventId?: string;
}
interface Position {
  sequence: number;
  offset: number;
  hash: string;
}
interface Checkpoint extends Position {
  committed: boolean;
}
interface VerifiedFile {
  stamp: string;
  head: Position;
  checkpoints: Checkpoint[];
}
// Only verified positions/hashes are cached, never output bodies. Eviction
// affects performance only; the journal is always sufficient to rebuild them.
const verifiedFiles = new Map<string, VerifiedFile>();
const MAX_VERIFIED_FILES = 16;
function fileStamp(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
interface Cursor extends Position {
  identity: string;
}
interface Fragment {
  id: string;
  index: number;
  total: number;
  data: string;
}
interface RecordValue {
  sequence: number;
  runId: string;
  event?: StreamEvent;
  fragment?: Fragment;
  previousHash: string;
}
export interface OutputJournalFrame {
  cursor: string;
  sequence: number;
  runId: string;
  event?: StreamEvent;
  fragment?: Fragment;
}
export interface OutputJournalOptions {
  after?: string;
  through?: string;
  maxBytes?: number;
  maxFrames?: number;
}
export interface OutputJournalPage {
  version: 1;
  status: "ok" | "unavailable" | "cursor_invalid" | "incomplete";
  /** All pages in a recovery use the same frozen through cursor. */
  from?: string;
  through?: string;
  next?: string;
  coverageStart?: string;
  legacyBaseThroughEventId?: string;
  frames: OutputJournalFrame[];
  /** Pagination coverage only: never means a model run completed. */
  complete: boolean;
  uncommittedTail?: boolean;
}

class JournalError extends Error {
  constructor(
    readonly status: OutputJournalPage["status"],
    message: string,
  ) {
    super(message);
  }
}
function invalid(message: string): never {
  throw new JournalError("cursor_invalid", message);
}
function boundedInt(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalid("Invalid output journal page bound");
  }
  return value as number;
}
function token(identity: string, position: Position): string {
  return Buffer.from(JSON.stringify({ identity, ...position })).toString("base64url");
}
function cursor(value: unknown, identity: string): Cursor {
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    invalid("Invalid output cursor");
  let result: Cursor;
  try {
    result = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return invalid("Invalid output cursor");
  }
  if (
    !result ||
    result.identity !== identity ||
    !Number.isSafeInteger(result.sequence) ||
    result.sequence < 0 ||
    !Number.isSafeInteger(result.offset) ||
    result.offset < 0 ||
    !/^[a-f0-9]{64}$/.test(result.hash)
  )
    invalid("Output cursor belongs to another journal");
  return result;
}
function openRegular(path: string, flags: number): number {
  const fd = openSync(
    path,
    flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    0o600,
  );
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new JournalError("unavailable", "Output journal is not a regular file");
  }
  return fd;
}
function readBounded(fd: number, size: number): string {
  if (fstatSync(fd).size > size)
    throw new JournalError("incomplete", "Session metadata exceeds its bound");
  const buffer = Buffer.alloc(fstatSync(fd).size);
  let offset = 0;
  while (offset < buffer.length) {
    const n = readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (!n) break;
    offset += n;
  }
  if (offset !== buffer.length) invalid("Session metadata changed");
  return buffer.toString("utf8");
}
function sessionLocation(root: string, sessionId: string) {
  if (!SAFE_ID.test(sessionId) || sessionId.includes("..")) invalid("Invalid Session id");
  const canonicalRoot = realpathSync(root);
  const directory = join(canonicalRoot, sessionId);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid("Invalid Session directory");
  const statePath = join(directory, "state.json");
  const stateFd = openRegular(statePath, constants.O_RDONLY);
  let state: {
    sessionId?: string;
    startedAt?: number;
    runId?: string;
    ephemeral?: boolean;
    outputRecoveryIncomplete?: boolean;
    outputJournalIdentity?: string;
  };
  try {
    state = JSON.parse(readBounded(stateFd, 1024 * 1024));
  } finally {
    closeSync(stateFd);
  }
  if (state.sessionId !== sessionId || !Number.isFinite(state.startedAt))
    invalid("Invalid Session identity");
  if (
    state.outputJournalIdentity !== undefined &&
    !/^[a-f0-9]{64}$/.test(state.outputJournalIdentity)
  )
    throw new JournalError("incomplete", "Invalid output journal identity pin");
  if (state.ephemeral || sessionId.startsWith("qchat-"))
    throw new JournalError("unavailable", "Ephemeral Session output is process-local");
  return {
    root: canonicalRoot,
    directory,
    statePath,
    state,
    stat,
    file: join(directory, "output-journal.jsonl"),
  };
}

/** Constant-memory, bounded-record reader. It never skips malformed committed records. */
function* lines(
  fd: number,
  start: number,
  end: number,
  maxRecordBytes = MAX_RECORD_BYTES,
): Generator<{ text: string; end: number }> {
  let offset = start;
  let pending = Buffer.alloc(0);
  while (offset < end) {
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - offset));
    const n = readSync(fd, buffer, 0, buffer.length, offset);
    if (!n) invalid("Output journal was truncated");
    offset += n;
    pending = Buffer.concat([pending, buffer.subarray(0, n)]);
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const record = pending.subarray(0, newline);
      if (record.length > maxRecordBytes)
        throw new JournalError("incomplete", "Output record exceeds its bound");
      // Fatal decoding prevents a split/corrupt UTF-8 record from changing its identity.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(record);
      pending = pending.subarray(newline + 1);
      yield { text, end: offset - pending.length };
    }
    if (pending.length > maxRecordBytes)
      throw new JournalError("incomplete", "Output record exceeds its bound");
  }
}
/** Exact bounded cutover base; reads the old prefix, never the current huge reply. */
export function readOutputJournalLegacyBase(
  root: string,
  sessionId: string,
  throughEventId: string | undefined,
): { complete: boolean; events: TranscriptEvent[] } {
  let fd: number | undefined;
  try {
    if (!throughEventId || throughEventId.length > 512) return { complete: false, events: [] };
    const location = sessionLocation(root, sessionId);
    fd = openRegular(join(location.directory, "transcript.jsonl"), constants.O_RDONLY);
    const events: TranscriptEvent[] = [];
    for (const line of lines(fd, 0, Math.min(fstatSync(fd).size, MAX_PAGE_BYTES), MAX_PAGE_BYTES)) {
      const event = JSON.parse(line.text) as TranscriptEvent;
      if (
        !event ||
        typeof event.id !== "string" ||
        typeof event.type !== "string" ||
        !event.data ||
        typeof event.data !== "object"
      )
        throw new Error("Invalid legacy event");
      events.push(event);
      if (events.length > 4096 || events[0].type !== "session_meta") break;
      if (event.id === throughEventId) {
        const final = lstatSync(location.directory);
        if (final.ino !== location.stat.ino || final.dev !== location.stat.dev) break;
        return { complete: true, events };
      }
    }
  } catch {
    /* A partial base never releases the recovery barrier. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { complete: false, events: [] };
}
function readHeader(fd: number, location: ReturnType<typeof sessionLocation>) {
  const first = lines(fd, 0, Math.min(fstatSync(fd).size, MAX_RECORD_BYTES + 1)).next();
  if (first.done) throw new JournalError("incomplete", "Missing output journal header");
  const header = JSON.parse(first.value.text) as Header;
  if (
    header.version !== 1 ||
    header.sessionId !== location.state.sessionId ||
    header.startedAt !== location.state.startedAt ||
    !/^[a-f0-9]{64}$/.test(header.storageScope) ||
    typeof header.sessionIncarnation !== "string" ||
    typeof header.journalId !== "string"
  )
    invalid("Output journal identity changed");
  const file = fstatSync(fd);
  // Chain integrity is intrinsic to the file. Cursor ownership additionally
  // binds its current canonical root and inode: a restored/copied Session can
  // retain its verified output but must restart recovery in a new cursor domain.
  const seed = digest(first.value.text + "\n");
  if (
    location.state.outputJournalIdentity !== undefined &&
    location.state.outputJournalIdentity !== seed
  )
    invalid("Pinned output journal identity changed");
  const identity = digest(
    `${digest(location.root)}\n${first.value.text}\n${location.stat.dev}:${location.stat.ino}\n${file.dev}:${file.ino}`,
  );
  return { header, identity, start: { sequence: 0, offset: first.value.end, hash: seed } };
}
function parseRecord(
  line: { text: string; end: number },
  previous: Position,
): { value: RecordValue; position: Position } {
  const stored = JSON.parse(line.text) as RecordValue & { hash: string };
  const { hash, ...value } = stored;
  if (
    value.sequence !== previous.sequence + 1 ||
    value.previousHash !== previous.hash ||
    typeof value.runId !== "string" ||
    !!value.event === !!value.fragment ||
    hash !== digest(JSON.stringify(value))
  )
    throw new JournalError("incomplete", "Output journal continuity failed");
  if (value.event && (typeof value.event !== "object" || typeof value.event.type !== "string"))
    throw new JournalError("incomplete", "Invalid output event");
  if (
    value.fragment &&
    (typeof value.fragment.id !== "string" ||
      !Number.isSafeInteger(value.fragment.index) ||
      !Number.isSafeInteger(value.fragment.total) ||
      value.fragment.total < 2 ||
      value.fragment.total > MAX_EVENT_BYTES / CHUNK_BYTES ||
      value.fragment.index < 0 ||
      value.fragment.index >= value.fragment.total ||
      typeof value.fragment.data !== "string" ||
      value.fragment.data.length > Math.ceil(CHUNK_BYTES / 3) * 4)
  )
    throw new JournalError("incomplete", "Invalid output fragment");
  return { value, position: { sequence: value.sequence, offset: line.end, hash } };
}
function scan(fd: number, start: Position, size: number, checkpoints?: Checkpoint[]): Position {
  if (size > MAX_JOURNAL_BYTES)
    throw new JournalError("incomplete", "Output journal exceeds its storage budget");
  let current = start;
  let committed = start;
  let fragment: { id: string; index: number; total: number } | undefined;
  let checkpoint = start;
  for (const line of lines(fd, start.offset, size)) {
    const parsed = parseRecord(line, current);
    current = parsed.position;
    const part = parsed.value.fragment;
    if (part) {
      if (!fragment && part.index !== 0)
        throw new JournalError("incomplete", "Output fragment has no beginning");
      if (
        fragment &&
        (part.id !== fragment.id ||
          part.total !== fragment.total ||
          part.index !== fragment.index + 1)
      )
        throw new JournalError("incomplete", "Output fragment continuity failed");
      fragment = part;
      if (part.index === part.total - 1) {
        fragment = undefined;
        committed = current;
      }
    } else {
      if (fragment) throw new JournalError("incomplete", "Output fragment was interrupted");
      committed = current;
    }
    if (
      checkpoints &&
      (current.sequence - checkpoint.sequence >= MAX_PAGE_FRAMES ||
        current.offset - checkpoint.offset >= MAX_PAGE_BYTES)
    ) {
      checkpoints.push({ ...current, committed: !fragment });
      checkpoint = current;
    }
  }
  // An isolated unfinished final whole-event group cannot become coverage.
  while (checkpoints?.length && checkpoints.at(-1)!.sequence > committed.sequence)
    checkpoints.pop();
  return committed;
}
function verifiedFile(fd: number, file: string, start: Position, size: number): VerifiedFile {
  const stamp = fileStamp(fd),
    cached = verifiedFiles.get(file);
  if (cached?.stamp === stamp) {
    verifiedFiles.delete(file);
    verifiedFiles.set(file, cached);
    return cached;
  }
  const checkpoints: Checkpoint[] = [{ ...start, committed: true }];
  const head = scan(fd, start, size, checkpoints);
  const result = { stamp, head, checkpoints };
  // A concurrent append may leave the frozen scan valid, but its new stamp
  // cannot certify the unseen tail. Rebuild on the next request instead.
  if (fileStamp(fd) === stamp) {
    verifiedFiles.delete(file);
    verifiedFiles.set(file, result);
    if (verifiedFiles.size > MAX_VERIFIED_FILES)
      verifiedFiles.delete(verifiedFiles.keys().next().value!);
  }
  return result;
}
function verifyPosition(fd: number, value: Position, verified: VerifiedFile, wholeEvent: boolean) {
  let checkpoint = verified.checkpoints[0]!;
  for (const item of verified.checkpoints) {
    if (item.sequence > value.sequence) break;
    checkpoint = item;
  }
  let current: Position = checkpoint;
  let committed = checkpoint.committed;
  if (current.sequence !== value.sequence) {
    for (const line of lines(fd, checkpoint.offset, value.offset)) {
      const parsed = parseRecord(line, current);
      current = parsed.position;
      committed =
        !parsed.value.fragment || parsed.value.fragment.index === parsed.value.fragment.total - 1;
      if (current.sequence >= value.sequence) break;
    }
  }
  if (
    current.sequence !== value.sequence ||
    current.offset !== value.offset ||
    current.hash !== value.hash ||
    (wholeEvent && !committed)
  )
    invalid("Output cursor no longer identifies a committed prefix");
}

/** Reads only this Session root. The returned cursor survives Main/Hub/worker restarts. */
export function readOutputJournal(
  root: string,
  sessionId: string,
  options: OutputJournalOptions = {},
): OutputJournalPage {
  let fd: number | undefined;
  let pinned = false;
  try {
    if (!options || typeof options !== "object" || Array.isArray(options))
      invalid("Invalid output journal options");
    const maxBytes = boundedInt(options.maxBytes, MAX_PAGE_BYTES, MAX_PAGE_BYTES);
    const maxFrames = boundedInt(options.maxFrames, MAX_PAGE_FRAMES, MAX_PAGE_FRAMES);
    const location = sessionLocation(root, sessionId);
    pinned = location.state.outputJournalIdentity !== undefined;
    if (location.state.outputRecoveryIncomplete)
      throw new JournalError("incomplete", "This Session recorded an output persistence failure");
    fd = openRegular(location.file, constants.O_RDONLY);
    const size = fstatSync(fd).size;
    const { header, identity, start } = readHeader(fd, location);
    if (!pinned)
      throw new JournalError("incomplete", "Output journal identity was never committed");
    const verified = verifiedFile(fd, location.file, start, size);
    const after = options.after === undefined ? start : cursor(options.after, identity);
    // The first request freezes a verified prefix. Later pages retain that prefix
    // while independent appends may advance the current file beyond it.
    const through =
      options.through === undefined ? verified.head : cursor(options.through, identity);
    if (
      after.offset < start.offset ||
      after.sequence > through.sequence ||
      after.offset > through.offset ||
      through.offset > verified.head.offset ||
      through.sequence > verified.head.sequence
    )
      invalid("Output cursor is outside the committed prefix");
    // The entire prefix is verified under this exact file stamp. Sparse
    // positions bound seeks without allowing a cursor to skip damaged output.
    verifyPosition(fd, after, verified, false);
    verifyPosition(fd, through, verified, true);
    const frames: OutputJournalFrame[] = [];
    let bytes = 0;
    let next = after;
    let current = after;
    for (const line of lines(fd, after.offset, through.offset)) {
      const parsed = parseRecord(line, current);
      current = parsed.position;
      const frame = {
        cursor: token(identity, current),
        sequence: current.sequence,
        runId: parsed.value.runId,
        ...(parsed.value.event
          ? { event: parsed.value.event }
          : { fragment: parsed.value.fragment }),
      };
      const frameBytes = Buffer.byteLength(JSON.stringify(frame));
      if (bytes + frameBytes > maxBytes) {
        // A too-small request cannot falsely return an empty completed page.
        if (!frames.length) invalid("Page byte budget is smaller than one output frame");
        break;
      }
      frames.push(frame);
      bytes += frameBytes;
      next = current;
      if (frames.length >= maxFrames) break;
    }
    if (fileStamp(fd) !== verified.stamp) {
      // Appends do not invalidate a frozen page. A changed file must re-prove
      // that complete old prefix, including all bytes before `after`.
      const frozen = scan(fd, start, through.offset);
      if (
        frozen.sequence !== through.sequence ||
        frozen.hash !== through.hash ||
        frozen.offset !== through.offset
      )
        invalid("Output prefix changed during recovery");
    }
    const finalFile = lstatSync(location.file),
      openFile = fstatSync(fd);
    if (
      !finalFile.isFile() ||
      finalFile.isSymbolicLink() ||
      finalFile.dev !== openFile.dev ||
      finalFile.ino !== openFile.ino
    )
      invalid("Output journal was replaced during recovery");
    const finalDirectory = lstatSync(location.directory);
    if (finalDirectory.dev !== location.stat.dev || finalDirectory.ino !== location.stat.ino)
      invalid("Session was replaced during recovery");
    return {
      version: 1,
      status: "ok",
      from: token(identity, after),
      through: token(identity, through),
      next: token(identity, next),
      coverageStart: token(identity, start),
      legacyBaseThroughEventId: header.legacyBaseThroughEventId,
      frames,
      complete: next.sequence === through.sequence,
      ...(size > through.offset && options.through === undefined ? { uncommittedTail: true } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      version: 1,
      status:
        error instanceof JournalError
          ? error.status
          : code === "ENOENT" && !pinned
            ? "unavailable"
            : "incomplete",
      frames: [],
      complete: false,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One run owner. Each append holds the same short synchronous lock as state CAS. */
export class SessionOutputJournal {
  private readonly location: ReturnType<typeof sessionLocation>;
  private readonly identity: string;
  private position: Position;
  private readonly fileIdentity: { dev: number; ino: number };
  readonly identityPin: string;
  constructor(
    root: string,
    sessionId: string,
    private readonly runId: string,
    legacyBaseThroughEventId?: string,
  ) {
    this.location = sessionLocation(root, sessionId);
    const release = lockSync(this.location.statePath, { realpath: false, retries: 0 });
    let fd: number | undefined;
    try {
      this.location.state = this.assertOwner(true).state;
      try {
        fd = openRegular(
          this.location.file,
          constants.O_RDWR |
            (this.location.state.outputJournalIdentity ? 0 : constants.O_CREAT | constants.O_EXCL),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        fd = openRegular(this.location.file, constants.O_RDWR);
      }
      if (!fstatSync(fd).size) {
        if (this.location.state.outputJournalIdentity)
          throw new JournalError("incomplete", "Pinned output journal was lost or truncated");
        const header: Header = {
          version: 1,
          storageScope: digest(this.location.root),
          sessionIncarnation: randomUUID(),
          journalId: randomUUID(),
          sessionId,
          startedAt: this.location.state.startedAt!,
          ...(legacyBaseThroughEventId ? { legacyBaseThroughEventId } : {}),
        };
        this.write(fd, JSON.stringify(header) + "\n", 0);
        fsyncSync(fd);
        // Make first materialization durable along with its directory entry.
        if (process.platform !== "win32") {
          const dir = openSync(this.location.directory, constants.O_RDONLY);
          try {
            fsyncSync(dir);
          } finally {
            closeSync(dir);
          }
        }
      }
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
      const loaded = readHeader(fd, this.location);
      this.identity = loaded.identity;
      this.identityPin = loaded.start.hash;
      this.position = scan(fd, loaded.start, fstatSync(fd).size);
      if (!this.location.state.outputJournalIdentity) {
        if (this.position.sequence > 0)
          throw new JournalError(
            "incomplete",
            "Unpinned output journal contains published records",
          );
        this.persistPin(this.identityPin);
      }
      // Isolate only a non-newline tail or an unfinished final whole-event
      // fragment group, including complete lines. Never skip interior damage.
      if (this.position.offset !== fstatSync(fd).size) {
        ftruncateSync(fd, this.position.offset);
        fsyncSync(fd);
      }
      this.fileIdentity = fstatSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
      release();
    }
  }
  private assertOwner(allowUnpinned = false): ReturnType<typeof sessionLocation> {
    const current = sessionLocation(this.location.root, this.location.state.sessionId!);
    if (current.state.outputRecoveryIncomplete)
      throw new JournalError(
        "incomplete",
        "Session output recovery is incomplete; repair is required",
      );
    if (
      current.stat.dev !== this.location.stat.dev ||
      current.stat.ino !== this.location.stat.ino ||
      current.state.startedAt !== this.location.state.startedAt ||
      current.state.runId !== this.runId
    )
      invalid("Output owner was superseded or deleted");
    if (
      this.identityPin !== undefined &&
      current.state.outputJournalIdentity !== this.identityPin &&
      !(allowUnpinned && current.state.outputJournalIdentity === undefined)
    )
      invalid("Output journal identity pin was removed or replaced");
    return current;
  }
  private persistPin(pin: string): void {
    const current = this.assertOwner(true);
    const temporary = join(this.location.directory, `.output-pin-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openRegular(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      this.write(fd, JSON.stringify({ ...current.state, outputJournalIdentity: pin }) + "\n", 0);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.location.statePath);
      if (process.platform !== "win32") {
        const dir = openSync(this.location.directory, constants.O_RDONLY);
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  private write(fd: number, text: string, offset: number): void {
    const data = Buffer.from(text);
    let written = 0;
    while (written < data.length) {
      const n = writeSync(fd, data, written, data.length - written, offset + written);
      if (!n) throw new Error("Output journal write made no progress");
      written += n;
    }
  }
  append(event: StreamEvent): string {
    const serialized = JSON.stringify({
      ...event,
      outputCursor: undefined,
      outputRecovery: undefined,
    });
    const data = Buffer.from(serialized);
    if (data.length > MAX_EVENT_BYTES)
      throw new JournalError("incomplete", "Output event exceeds the 16 MiB recovery bound");
    const values: Array<Pick<RecordValue, "event" | "fragment">> = [];
    if (data.length <= CHUNK_BYTES) values.push({ event: JSON.parse(serialized) });
    else {
      const id = randomUUID();
      const total = Math.ceil(data.length / CHUNK_BYTES);
      for (let index = 0; index < total; index++)
        values.push({
          fragment: {
            id,
            index,
            total,
            data: data.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
          },
        });
    }
    const release = lockSync(this.location.statePath, { realpath: false, retries: 0 });
    let fd: number | undefined;
    try {
      this.assertOwner();
      fd = openRegular(this.location.file, constants.O_RDWR);
      const stat = fstatSync(fd);
      if (
        stat.dev !== this.fileIdentity.dev ||
        stat.ino !== this.fileIdentity.ino ||
        stat.size !== this.position.offset
      )
        invalid("Output journal changed under its owner");
      let next = this.position;
      const linesToWrite: string[] = [];
      for (const payload of values) {
        const value: RecordValue = {
          sequence: next.sequence + 1,
          runId: this.runId,
          ...payload,
          previousHash: next.hash,
        };
        const hash = digest(JSON.stringify(value));
        const line = JSON.stringify({ ...value, hash }) + "\n";
        next = { sequence: value.sequence, offset: next.offset + Buffer.byteLength(line), hash };
        linesToWrite.push(line);
      }
      if (next.offset > MAX_JOURNAL_BYTES)
        throw new JournalError("incomplete", "Output recovery storage budget exhausted");
      this.write(fd, linesToWrite.join(""), this.position.offset);
      // Every published cursor covers fsync-completed records; terminal events
      // receive the same guarantee, rather than relying on eventual close.
      fsyncSync(fd);
      this.assertOwner();
      this.position = next;
      return token(this.identity, next);
    } finally {
      if (fd !== undefined) closeSync(fd);
      release();
    }
  }
}
