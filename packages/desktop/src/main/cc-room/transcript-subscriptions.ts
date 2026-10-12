import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unwatchFile,
  watchFile,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  encodeCwd,
  findCodexRolloutFile,
  parseClaudeTranscriptLine,
  parseCodexRecentHistory,
  parseCodexTranscriptLine,
  parseRecentHistory,
  type HistoryMessage,
  type SessionTailEvent,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import type { RoomKind, RoomMessage } from "@cjhyy/code-shell-server/mobile-remote";
import { TranscriptCheckpointStore, type TranscriptCheckpoint } from "./transcript-checkpoints.js";

interface TranscriptTarget {
  roomId: string;
  cwd: string;
  sessionId: string;
  kind: RoomKind;
}
export interface TranscriptSubscribeRequest extends TranscriptTarget {
  subscriberId: string;
  limit: number;
}
export interface TranscriptSubscriptionSnapshot {
  active: boolean;
  messages: HistoryMessage[];
  hasMore: boolean;
  totalCount: number;
  /** Room-local boundary; never a native Session or Run cursor. */
  roomCursor: number;
}
type RoomMessageInput = Omit<RoomMessage, "seq" | "ts">;
export interface TranscriptSubscriptionOptions {
  onStart(roomId: string): void;
  onStop(roomId: string): void;
  roomCursor(roomId: string): number;
  onMessages(roomId: string, messages: RoomMessageInput[]): void;
  /** Production supplies owned Host state; tests may deliberately use RAM only. */
  checkpointDir?: string;
  hasTranscriptHistory?(roomId: string): boolean;
  onFailure?(roomId: string, message: string): void;
  resolveFile?: (target: TranscriptTarget) => string | undefined;
  pollIntervalMs?: number;
}
interface FollowRecord extends TranscriptTarget {
  file: string;
  checkpoint: TranscriptCheckpoint;
  subscribers: Set<string>;
  listener: (curr: Stats, prev: Stats) => void;
}
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`;
const stamp = (stat: Stats) => `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

/** Shared observer of actual external CLI files, with crash-retry provenance. */
export class TranscriptSubscriptionManager {
  private readonly follows = new Map<string, FollowRecord>();
  private readonly roomBySubscriber = new Map<string, string>();
  private readonly failures = new Map<string, Error>();
  private readonly checkpoints?: TranscriptCheckpointStore;
  private readonly resolveFile: (target: TranscriptTarget) => string | undefined;
  private readonly pollIntervalMs: number;
  constructor(private readonly opts: TranscriptSubscriptionOptions) {
    this.resolveFile = opts.resolveFile ?? resolveTranscriptFile;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    if (opts.checkpointDir) this.checkpoints = new TranscriptCheckpointStore(opts.checkpointDir);
  }
  subscribe(request: TranscriptSubscribeRequest): TranscriptSubscriptionSnapshot {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500)
      throw new Error("invalid transcript history limit");
    const prior = this.follows.get(request.roomId);
    if (prior && !sameTarget(prior, request))
      throw new Error("transcript identity does not match the followed room");
    // A repeat subscription from the only viewer must not stop/rebaseline its
    // live follower before draining the bytes appended since the previous poll.
    if (this.roomBySubscriber.get(request.subscriberId) !== request.roomId)
      this.unsubscribeSubscriber(request.subscriberId);
    const failed = this.failures.get(request.roomId);
    if (failed) throw failed;
    let record = this.follows.get(request.roomId);
    if (record) {
      this.drain(record);
      const snapshot = snapshotAt(
        readTranscript(record.file),
        record.checkpoint,
        request.kind,
        request.limit,
      );
      record.subscribers.add(request.subscriberId);
      this.roomBySubscriber.set(request.subscriberId, request.roomId);
      return { active: true, ...snapshot, roomCursor: this.opts.roomCursor(request.roomId) };
    }
    const file = this.resolveFile(request);
    if (!file) throw new Error("external transcript is missing");
    let checkpoint = this.checkpoints?.load(request.roomId);
    let current: ReturnType<typeof readTranscript>;
    if (checkpoint && (!sameTarget(checkpoint, request) || checkpoint.file !== file))
      throw new Error("transcript checkpoint identity mismatch");
    try {
      current = readTranscript(file);
      if (checkpoint) verifyPrefix(current, checkpoint);
    } catch (error) {
      if (checkpoint) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.failures.set(request.roomId, failure);
        this.checkpoints?.save({
          ...checkpoint,
          status: "failed",
          reason: failure.message.slice(0, 1024),
        });
        this.opts.onFailure?.(request.roomId, failure.message);
      }
      throw error;
    }
    if (checkpoint) {
      if (!sameTarget(checkpoint, request) || checkpoint.file !== file)
        throw new Error("transcript checkpoint identity mismatch");
      if (checkpoint.status === "failed")
        throw new Error(checkpoint.reason ?? "transcript requires recovery");
      verifyPrefix(current, checkpoint);
      if (this.opts.roomCursor(request.roomId) < checkpoint.roomCursor)
        throw new Error("room history is behind its transcript checkpoint");
    } else {
      if (this.opts.hasTranscriptHistory?.(request.roomId))
        throw new Error("transcript checkpoint is missing; recovery is required");
      checkpoint = {
        version: 1,
        roomId: request.roomId,
        cwd: request.cwd,
        sessionId: request.sessionId,
        kind: request.kind,
        file,
        identity: current.identity,
        sourceId: randomUUID(),
        offset: current.complete,
        digest: digest(current.bytes.subarray(0, current.complete)),
        roomCursor: this.opts.roomCursor(request.roomId),
        status: "committed",
      };
      this.checkpoints?.save(checkpoint);
    }
    const listener = (_curr: Stats, _prev: Stats) => {
      const active = this.follows.get(request.roomId);
      if (!active) return;
      try {
        this.drain(active);
      } catch {
        /* failure was latched and surfaced */
      }
    };
    record = {
      ...request,
      file,
      checkpoint,
      subscribers: new Set([request.subscriberId]),
      listener,
    };
    this.opts.onStart(request.roomId);
    this.follows.set(request.roomId, record);
    this.roomBySubscriber.set(request.subscriberId, request.roomId);
    try {
      // A pending checkpoint replays from its previous committed newline. Room
      // persistence deduplicates the actual incarnation/line/event coordinates.
      this.drain(record);
      const snapshot = snapshotAt(
        readTranscript(file),
        record.checkpoint,
        request.kind,
        request.limit,
      );
      const roomCursor = this.opts.roomCursor(request.roomId);
      watchFile(file, { interval: this.pollIntervalMs, persistent: false }, listener);
      this.drain(record);
      return { active: true, ...snapshot, roomCursor };
    } catch (error) {
      this.stopRecord(record);
      throw error;
    }
  }
  unsubscribe(subscriberId: string, roomId: string): void {
    if (this.roomBySubscriber.get(subscriberId) === roomId)
      this.unsubscribeSubscriber(subscriberId);
  }
  unsubscribeSubscriber(subscriberId: string): void {
    const roomId = this.roomBySubscriber.get(subscriberId);
    if (!roomId) return;
    this.roomBySubscriber.delete(subscriberId);
    const record = this.follows.get(roomId);
    if (!record) return;
    record.subscribers.delete(subscriberId);
    if (!record.subscribers.size) {
      // Do not lose the final append in the unsubscribe -> next subscribe gap.
      try {
        this.drain(record);
      } catch {
        /* onFailure already surfaced the barrier */
      } finally {
        this.stopRecord(record);
      }
    }
  }
  endRoom(roomId: string): void {
    const record = this.follows.get(roomId);
    if (!record) return;
    try {
      this.drain(record);
    } catch {
      /* terminal hooks must still release the watcher */
    } finally {
      this.stopRecord(record);
    }
  }
  closeAll(): void {
    for (const record of [...this.follows.values()]) {
      try {
        this.drain(record);
      } catch {
        /* onFailure reports the durable barrier */
      }
      this.stopRecord(record);
    }
  }
  private drain(record: FollowRecord): void {
    let current: ReturnType<typeof readTranscript>;
    try {
      current = readTranscript(record.file);
      verifyPrefix(current, record.checkpoint);
    } catch (error) {
      this.fail(record, error, true);
      throw error;
    }
    const before = record.checkpoint;
    if (current.complete === before.offset && before.status !== "pending") return;
    const messages: RoomMessageInput[] = [];
    try {
      let offset = before.offset;
      while (offset < current.complete) {
        const end = current.bytes.indexOf(0x0a, offset) + 1;
        const line = decoder.decode(current.bytes.subarray(offset, end - 1));
        const events =
          record.kind === "codex"
            ? parseCodexTranscriptLine(line)
            : parseClaudeTranscriptLine(line);
        messages.push(
          ...events.map((event, index) => ({
            ...tailEventToRoomMessage(event),
            transcriptSource: `${before.sourceId}:${end}:${index}`,
          })),
        );
        if (messages.length > 10_000)
          throw new Error("external transcript catchup exceeds 10,000 normalized events");
        offset = end;
      }
    } catch (error) {
      this.fail(record, error, true);
      throw error;
    }
    try {
      this.checkpoints?.save({ ...before, status: "pending" });
      if (messages.length) this.opts.onMessages(record.roomId, messages);
      const committed: TranscriptCheckpoint = {
        ...before,
        status: "committed",
        offset: current.complete,
        digest: digest(current.bytes.subarray(0, current.complete)),
        roomCursor: this.opts.roomCursor(record.roomId),
      };
      this.checkpoints?.save(committed);
      record.checkpoint = committed;
    } catch (error) {
      // Keep the last committed offset in the durable pending checkpoint. A
      // fresh Host retries it against idempotent Room provenance, never EOF.
      this.fail(record, error, false);
      throw error;
    }
  }
  private fail(record: FollowRecord, error: unknown, permanent: boolean): void {
    if (this.failures.has(record.roomId)) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.failures.set(record.roomId, failure);
    if (permanent) {
      try {
        this.checkpoints?.save({
          ...record.checkpoint,
          status: "failed",
          reason: failure.message.slice(0, 1024),
        });
      } catch {
        /* preserve the original failure; subscribers still see a barrier */
      }
    }
    this.stopRecord(record);
    this.opts.onFailure?.(record.roomId, failure.message);
  }
  private stopRecord(record: FollowRecord): void {
    if (this.follows.get(record.roomId) !== record) return;
    unwatchFile(record.file, record.listener);
    this.follows.delete(record.roomId);
    for (const subscriberId of record.subscribers)
      if (this.roomBySubscriber.get(subscriberId) === record.roomId)
        this.roomBySubscriber.delete(subscriberId);
    this.opts.onStop(record.roomId);
  }
}
function sameTarget(a: TranscriptTarget, b: TranscriptTarget): boolean {
  return (
    a.roomId === b.roomId && a.kind === b.kind && a.cwd === b.cwd && a.sessionId === b.sessionId
  );
}
function resolveTranscriptFile(target: TranscriptTarget): string | undefined {
  if (target.kind === "claude-code")
    return join(
      homedir(),
      ".claude",
      "projects",
      encodeCwd(target.cwd),
      `${target.sessionId}.jsonl`,
    );
  return findCodexRolloutFile(join(homedir(), ".codex"), target.cwd, target.sessionId);
}
function readTranscript(file: string): { bytes: Buffer; complete: number; identity: string } {
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > MAX_TRANSCRIPT_BYTES
  )
    throw new Error("external transcript is unsafe or exceeds 64 MiB");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (stamp(before) !== stamp(info)) throw new Error("external transcript changed while opening");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("external transcript was truncated while reading");
      offset += count;
    }
    if (stamp(before) !== stamp(fstatSync(fd)) || stamp(before) !== stamp(lstatSync(file)))
      throw new Error("external transcript changed while reading; retry subscription");
    const complete = bytes.lastIndexOf(0x0a) + 1;
    let start = 0;
    while (start < complete) {
      const end = bytes.indexOf(0x0a, start);
      if (end - start > MAX_LINE_BYTES) throw new Error("external transcript line exceeds 4 MiB");
      const line = decoder.decode(bytes.subarray(start, end));
      if (line.trim()) {
        const value = JSON.parse(line);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          typeof value.type !== "string"
        )
          throw new Error("external transcript contains an invalid record");
        if (
          (value.type === "assistant" || value.type === "user") &&
          (!value.message ||
            typeof value.message !== "object" ||
            (typeof value.message.content !== "string" && !Array.isArray(value.message.content)))
        ) {
          throw new Error("external transcript contains an invalid message record");
        }
        if (
          (value.type === "response_item" || value.type === "event_msg") &&
          (!value.payload ||
            typeof value.payload !== "object" ||
            typeof value.payload.type !== "string")
        ) {
          throw new Error("external transcript contains an invalid payload record");
        }
      }
      start = end + 1;
    }
    if (bytes.length - complete > MAX_LINE_BYTES)
      throw new Error("external transcript partial line exceeds 4 MiB");
    return { bytes, complete, identity: identity(before) };
  } finally {
    closeSync(fd);
  }
}
function verifyPrefix(
  current: ReturnType<typeof readTranscript>,
  checkpoint: TranscriptCheckpoint,
): void {
  if (current.identity !== checkpoint.identity)
    throw new Error("external transcript file incarnation changed; recovery is required");
  if (current.bytes.length < checkpoint.offset || current.complete < checkpoint.offset)
    throw new Error("external transcript shrank; recovery is required");
  if (digest(current.bytes.subarray(0, checkpoint.offset)) !== checkpoint.digest)
    throw new Error("external transcript prefix was rewritten; recovery is required");
}
function snapshotAt(
  current: ReturnType<typeof readTranscript>,
  checkpoint: TranscriptCheckpoint,
  kind: RoomKind,
  limit: number,
) {
  verifyPrefix(current, checkpoint);
  const offset = checkpoint.offset;
  if (offset > current.complete) throw new Error("external transcript snapshot is incomplete");
  const text = decoder.decode(current.bytes.subarray(0, offset));
  return kind === "codex" ? parseCodexRecentHistory(text, limit) : parseRecentHistory(text, limit);
}

function tailEventToRoomMessage(event: SessionTailEvent): RoomMessageInput {
  switch (event.type) {
    case "user":
      return { from: "user", type: "text", text: event.text };
    case "assistant":
      return { from: "agent", type: "text", text: event.text };
    case "tool":
      return {
        from: "agent",
        type: "tool",
        tool: event.name,
        summary: event.summary,
        toolId: event.id,
        args: event.args,
      };
    case "tool_result":
      return {
        from: "agent",
        type: "tool_result",
        summary: event.result,
        isError: event.isError,
        toolId: event.id,
      };
    case "turn_end":
      return { from: "agent", type: "turn_end", reason: event.reason };
  }
}
