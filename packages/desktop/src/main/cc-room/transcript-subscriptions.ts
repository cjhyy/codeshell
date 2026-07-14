import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
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
} from "@cjhyy/code-shell-capability-coding";
import type { RoomKind, RoomMessage } from "../mobile-remote/room-manager.js";

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
  /** Room-message cursor captured at the same boundary as `messages`. The
   * client asks roomHistory(cursor) after replaying the snapshot to close the
   * tiny subscribe-response delivery window without duplicates. */
  roomCursor: number;
}

type RoomMessageInput = Omit<RoomMessage, "seq" | "ts">;

export interface TranscriptSubscriptionOptions {
  onStart(roomId: string): void;
  onStop(roomId: string): void;
  roomCursor(roomId: string): number;
  onMessages(roomId: string, messages: RoomMessageInput[]): void;
  /** Test seam; production resolves Claude/Codex's real home layouts. */
  resolveFile?: (target: TranscriptTarget) => string | undefined;
  pollIntervalMs?: number;
}

interface FollowRecord extends TranscriptTarget {
  file: string;
  offset: number;
  carry: Buffer;
  subscribers: Set<string>;
  listener: (curr: Stats, prev: Stats) => void;
}

const EMPTY_HISTORY = { messages: [] as HistoryMessage[], hasMore: false, totalCount: 0 };

/**
 * Ref-counted `tail -f` for external Claude Code / Codex JSONL transcripts.
 *
 * One watcher is shared by all desktop windows and phones viewing a room. New
 * lines are normalized into RoomMessage inputs, so delivery, seq-based catchup,
 * and desktop+mobile fan-out reuse RoomManager's existing real-time push path.
 */
export class TranscriptSubscriptionManager {
  private readonly follows = new Map<string, FollowRecord>();
  private readonly roomBySubscriber = new Map<string, string>();
  private readonly resolveFile: (target: TranscriptTarget) => string | undefined;
  private readonly pollIntervalMs: number;

  constructor(private readonly opts: TranscriptSubscriptionOptions) {
    this.resolveFile = opts.resolveFile ?? resolveTranscriptFile;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
  }

  subscribe(request: TranscriptSubscribeRequest): TranscriptSubscriptionSnapshot {
    this.unsubscribeSubscriber(request.subscriberId);

    let record = this.follows.get(request.roomId);
    if (record) {
      // Pull any size change that happened before watchFile's next poll, then
      // take this late subscriber's snapshot/cursor at the resulting boundary.
      this.drain(record);
      const snapshot = readSnapshot(record.file, record.offset, request.kind, request.limit);
      const roomCursor = this.opts.roomCursor(request.roomId);
      record.subscribers.add(request.subscriberId);
      this.roomBySubscriber.set(request.subscriberId, request.roomId);
      return { active: true, ...snapshot.history, roomCursor };
    }

    const target: TranscriptTarget = request;
    const file = this.resolveFile(target);
    if (!file || !existsSync(file)) {
      return { active: false, ...EMPTY_HISTORY, roomCursor: this.opts.roomCursor(request.roomId) };
    }

    let initial: ReturnType<typeof readSnapshot>;
    try {
      initial = readSnapshot(file, undefined, request.kind, request.limit);
    } catch {
      return { active: false, ...EMPTY_HISTORY, roomCursor: this.opts.roomCursor(request.roomId) };
    }

    const listener = (curr: Stats, _prev: Stats): void => {
      const current = this.follows.get(request.roomId);
      if (!current) return;
      if (curr.nlink === 0) {
        this.endRoom(request.roomId);
        return;
      }
      this.drain(current);
    };
    record = {
      ...target,
      file,
      offset: initial.size,
      carry: initial.carry,
      subscribers: new Set([request.subscriberId]),
      listener,
    };

    // Mark the room as transcript-driven before the first drain. RoomManager
    // then suppresses its own stdout mirror for this room, avoiding duplicates
    // when CodeShell itself sends the next turn into the resumed CLI process.
    this.opts.onStart(request.roomId);
    const roomCursor = this.opts.roomCursor(request.roomId);
    this.follows.set(request.roomId, record);
    this.roomBySubscriber.set(request.subscriberId, request.roomId);
    watchFile(file, { interval: this.pollIntervalMs, persistent: false }, listener);
    // Close the stat→watch registration race synchronously. Any complete lines
    // appended meanwhile land after roomCursor and are recoverable via history.
    this.drain(record);

    return { active: true, ...initial.history, roomCursor };
  }

  unsubscribe(subscriberId: string, roomId: string): void {
    if (this.roomBySubscriber.get(subscriberId) !== roomId) return;
    this.unsubscribeSubscriber(subscriberId);
  }

  unsubscribeSubscriber(subscriberId: string): void {
    const roomId = this.roomBySubscriber.get(subscriberId);
    if (!roomId) return;
    this.roomBySubscriber.delete(subscriberId);
    const record = this.follows.get(roomId);
    if (!record) return;
    record.subscribers.delete(subscriberId);
    if (record.subscribers.size === 0) this.stopRecord(record);
  }

  /** Stop a room after its resident process exits or the room is explicitly
   * closed. External CLI files have no portable "writer closed" signal, so
   * process-backed rooms use this natural terminal hook. */
  endRoom(roomId: string): void {
    const record = this.follows.get(roomId);
    if (!record) return;
    // A resident process can exit before watchFile's next 200ms poll. Drain its
    // final flushed bytes synchronously, then release the watcher, so terminal
    // output is not lost merely because process exit won the scheduling race.
    this.drain(record);
    if (this.follows.get(roomId) === record) this.stopRecord(record);
  }

  closeAll(): void {
    for (const record of [...this.follows.values()]) this.stopRecord(record);
  }

  private drain(record: FollowRecord): void {
    let size: number;
    try {
      size = statSync(record.file).size;
    } catch {
      this.stopRecord(record);
      return;
    }
    if (size < record.offset) {
      // A rewrite/rotation is a new stream boundary. Start at its current EOF
      // instead of replaying a whole replacement file into an existing view.
      record.offset = size;
      record.carry = Buffer.alloc(0);
      return;
    }
    if (size === record.offset) return;

    let appended: Buffer;
    try {
      appended = readRange(record.file, record.offset, size);
    } catch {
      return;
    }
    record.offset += appended.length;
    const data = record.carry.length > 0 ? Buffer.concat([record.carry, appended]) : appended;
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      record.carry = data;
      return;
    }
    const complete = data.subarray(0, lastNewline).toString("utf-8");
    record.carry = Buffer.from(data.subarray(lastNewline + 1));

    const messages: RoomMessageInput[] = [];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      const events =
        record.kind === "codex" ? parseCodexTranscriptLine(line) : parseClaudeTranscriptLine(line);
      messages.push(...events.map(tailEventToRoomMessage));
    }
    if (messages.length > 0) this.opts.onMessages(record.roomId, messages);
  }

  private stopRecord(record: FollowRecord): void {
    if (this.follows.get(record.roomId) !== record) return;
    unwatchFile(record.file, record.listener);
    this.follows.delete(record.roomId);
    for (const subscriberId of record.subscribers) {
      if (this.roomBySubscriber.get(subscriberId) === record.roomId) {
        this.roomBySubscriber.delete(subscriberId);
      }
    }
    this.opts.onStop(record.roomId);
  }
}

function resolveTranscriptFile(target: TranscriptTarget): string | undefined {
  if (target.kind === "claude-code") {
    return join(
      homedir(),
      ".claude",
      "projects",
      encodeCwd(target.cwd),
      `${target.sessionId}.jsonl`,
    );
  }
  return findCodexRolloutFile(join(homedir(), ".codex"), target.cwd, target.sessionId);
}

function readSnapshot(
  file: string,
  maxSize: number | undefined,
  kind: RoomKind,
  limit: number,
): {
  size: number;
  carry: Buffer;
  history: { messages: HistoryMessage[]; hasMore: boolean; totalCount: number };
} {
  const size = Math.min(maxSize ?? statSync(file).size, statSync(file).size);
  const raw = readRange(file, 0, size);
  const lastNewline = raw.lastIndexOf(0x0a);
  let snapshot = raw;
  let carry = Buffer.alloc(0);
  if (lastNewline < raw.length - 1) {
    const fragment = raw.subarray(lastNewline + 1);
    // A final valid JSON value is a complete line even if the writer has not
    // flushed its trailing newline yet. Invalid fragments stay buffered.
    try {
      JSON.parse(fragment.toString("utf-8"));
    } catch {
      snapshot = lastNewline < 0 ? Buffer.alloc(0) : raw.subarray(0, lastNewline + 1);
      carry = Buffer.from(fragment);
    }
  }
  const text = snapshot.toString("utf-8");
  const history =
    kind === "codex" ? parseCodexRecentHistory(text, limit) : parseRecentHistory(text, limit);
  return { size, carry, history };
}

function readRange(file: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const fd = openSync(file, "r");
  let total = 0;
  try {
    while (total < length) {
      const read = readSync(fd, buffer, total, length - total, start + total);
      if (read === 0) break;
      total += read;
    }
  } finally {
    closeSync(fd);
  }
  return total === length ? buffer : buffer.subarray(0, total);
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
