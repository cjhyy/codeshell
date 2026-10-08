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
  };
  try {
    state = JSON.parse(readBounded(stateFd, 1024 * 1024));
  } finally {
    closeSync(stateFd);
  }
  if (state.sessionId !== sessionId || !Number.isFinite(state.startedAt))
    invalid("Invalid Session identity");
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
    header.storageScope !== digest(location.root) ||
    typeof header.sessionIncarnation !== "string" ||
    typeof header.journalId !== "string"
  )
    invalid("Output journal identity changed");
  const file = fstatSync(fd);
  const identity = digest(`${first.value.text}\n${file.dev}:${file.ino}`);
  return { header, identity, start: { sequence: 0, offset: first.value.end, hash: identity } };
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
function scan(fd: number, start: Position, size: number): Position {
  if (size > MAX_JOURNAL_BYTES)
    throw new JournalError("incomplete", "Output journal exceeds its storage budget");
  let current = start;
  let committed = start;
  let fragment: { id: string; index: number; total: number } | undefined;
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
  }
  return committed;
}

/** Reads only this Session root. The returned cursor survives Main/Hub/worker restarts. */
export function readOutputJournal(
  root: string,
  sessionId: string,
  options: OutputJournalOptions = {},
): OutputJournalPage {
  let fd: number | undefined;
  try {
    if (!options || typeof options !== "object" || Array.isArray(options))
      invalid("Invalid output journal options");
    const maxBytes = boundedInt(options.maxBytes, MAX_PAGE_BYTES, MAX_PAGE_BYTES);
    const maxFrames = boundedInt(options.maxFrames, MAX_PAGE_FRAMES, MAX_PAGE_FRAMES);
    const location = sessionLocation(root, sessionId);
    if (location.state.outputRecoveryIncomplete)
      throw new JournalError("incomplete", "This Session recorded an output persistence failure");
    fd = openRegular(location.file, constants.O_RDONLY);
    const size = fstatSync(fd).size;
    const { header, identity, start } = readHeader(fd, location);
    const after = options.after === undefined ? start : cursor(options.after, identity);
    // The first request freezes a verified prefix. Later pages retain that prefix
    // while independent appends may advance the current file beyond it.
    const through =
      options.through === undefined ? scan(fd, start, size) : cursor(options.through, identity);
    if (
      after.offset < start.offset ||
      after.sequence > through.sequence ||
      after.offset > through.offset ||
      through.offset > size
    )
      invalid("Output cursor is outside the committed prefix");
    // Verify supplied positions against the actual chain, including corruption
    // before `after`: a cursor must never turn a damaged prefix into coverage.
    let verified = start;
    let afterSeen =
      after.sequence === 0 && after.offset === start.offset && after.hash === start.hash;
    let throughSeen =
      through.sequence === 0 && through.offset === start.offset && through.hash === start.hash;
    const frames: OutputJournalFrame[] = [];
    let bytes = 0;
    let next = after;
    let fragment: Fragment | undefined;
    for (const line of lines(fd, start.offset, through.offset)) {
      const parsed = parseRecord(line, verified);
      verified = parsed.position;
      const part = parsed.value.fragment;
      if (part) {
        if (
          (!fragment && part.index !== 0) ||
          (fragment &&
            (part.id !== fragment.id ||
              part.total !== fragment.total ||
              part.index !== fragment.index + 1))
        )
          throw new JournalError("incomplete", "Output fragment continuity failed");
        fragment = part.index === part.total - 1 ? undefined : part;
      } else if (fragment) {
        throw new JournalError("incomplete", "Output fragment was interrupted");
      }
      if (verified.sequence === after.sequence)
        afterSeen = verified.offset === after.offset && verified.hash === after.hash;
      if (verified.sequence === through.sequence)
        throughSeen = verified.offset === through.offset && verified.hash === through.hash;
      if (verified.sequence <= after.sequence || frames.length >= maxFrames) continue;
      const frame = {
        cursor: token(identity, verified),
        sequence: verified.sequence,
        runId: parsed.value.runId,
        ...(parsed.value.event
          ? { event: parsed.value.event }
          : { fragment: parsed.value.fragment }),
      };
      const frameBytes = Buffer.byteLength(JSON.stringify(frame));
      if (bytes + frameBytes > maxBytes) {
        // A too-small request cannot falsely return an empty completed page.
        if (!frames.length) invalid("Page byte budget is smaller than one output frame");
        continue;
      }
      // Once a page is full, never skip a larger record and include later ones.
      if (next.sequence !== verified.sequence - 1) continue;
      frames.push(frame);
      bytes += frameBytes;
      next = verified;
    }
    if (!afterSeen || !throughSeen || fragment)
      invalid("Output cursor no longer identifies a committed prefix");
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
          : code === "ENOENT"
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
      this.assertOwner();
      try {
        fd = openRegular(
          this.location.file,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        fd = openRegular(this.location.file, constants.O_RDWR);
      }
      if (!fstatSync(fd).size) {
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
      this.position = scan(fd, loaded.start, fstatSync(fd).size);
      // Only a non-newline final fragment can be uncommitted. Never skip a bad
      // interior record or manufacture a new identity around corruption.
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
  private assertOwner(): void {
    const current = sessionLocation(this.location.root, this.location.state.sessionId!);
    if (
      current.stat.dev !== this.location.stat.dev ||
      current.stat.ino !== this.location.stat.ino ||
      current.state.startedAt !== this.location.state.startedAt ||
      current.state.runId !== this.runId
    )
      invalid("Output owner was superseded or deleted");
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
