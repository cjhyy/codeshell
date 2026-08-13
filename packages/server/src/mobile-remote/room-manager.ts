import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResidentAgentEvent } from "./resident-agent.js";
import type { InputAttachmentMeta } from "../attachment-service.js";

/**
 * The exact shape createRoom() generates: `room_<base36>_<base36>`. Anything
 * else — path separators, `..`, NUL, empty — is rejected before it can reach a
 * filesystem path, closing the room-storage traversal via client-supplied
 * event.roomId.
 */
const ROOM_ID_RE = /^room_[a-z0-9]+_[a-z0-9]+$/;

/**
 * Minimum gap between room.json rewrites for `lastActiveAt`.
 *
 * The field only drives idle pruning, which is measured in hours, so writing it
 * per message bought nothing and cost a full file rewrite each time.
 */
const LAST_ACTIVE_THROTTLE_MS = 10_000;
const MAX_ROOM_META_BYTES = 64 * 1024;
const MAX_ROOM_ENTRIES = 10_000;
const MAX_ROOM_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_ROOM_HISTORY_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_ROOM_HISTORY_MESSAGES = 10_000;

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readBoundedUtf8File(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("file exceeds the size limit");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const count = readSync(fd, buffer, total, buffer.byteLength - total, total);
      if (count === 0) break;
      total += count;
    }
    if (total > maxBytes) throw new Error("file exceeds the size limit");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseRoomMeta(value: unknown, expectedId?: string): RoomMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !isValidRoomId(raw.id) ||
    (expectedId !== undefined && raw.id !== expectedId) ||
    typeof raw.name !== "string" ||
    !raw.name ||
    raw.name.length > 512 ||
    raw.name.includes("\0") ||
    typeof raw.cwd !== "string" ||
    !raw.cwd ||
    raw.cwd.length > 32_768 ||
    raw.cwd.includes("\0") ||
    (raw.kind !== "claude-code" && raw.kind !== "codex") ||
    (raw.permissionMode !== "default" &&
      raw.permissionMode !== "acceptEdits" &&
      raw.permissionMode !== "bypassPermissions") ||
    typeof raw.createdAt !== "number" ||
    !Number.isFinite(raw.createdAt) ||
    typeof raw.lastActiveAt !== "number" ||
    !Number.isFinite(raw.lastActiveAt) ||
    (raw.claudeSessionId !== undefined &&
      (typeof raw.claudeSessionId !== "string" ||
        raw.claudeSessionId.length > 4_096 ||
        raw.claudeSessionId.includes("\0"))) ||
    (raw.linkedSessionMode !== undefined && raw.linkedSessionMode !== "observe-only")
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    name: raw.name,
    cwd: raw.cwd,
    kind: raw.kind,
    permissionMode: raw.permissionMode,
    createdAt: raw.createdAt,
    lastActiveAt: raw.lastActiveAt,
    ...(typeof raw.claudeSessionId === "string"
      ? { claudeSessionId: raw.claudeSessionId }
      : {}),
    ...(raw.linkedSessionMode === "observe-only"
      ? { linkedSessionMode: raw.linkedSessionMode }
      : {}),
  };
}

function parseRoomMessage(value: unknown): RoomMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.seq !== "number" ||
    !Number.isSafeInteger(raw.seq) ||
    raw.seq <= 0 ||
    typeof raw.ts !== "number" ||
    !Number.isFinite(raw.ts) ||
    (raw.from !== "user" && raw.from !== "agent" && raw.from !== "system") ||
    typeof raw.type !== "string" ||
    !raw.type ||
    raw.type.length > 128
  ) {
    return undefined;
  }
  for (const field of ["text", "tool", "summary", "reason", "toolId"] as const) {
    const item = raw[field];
    if (item !== undefined && (typeof item !== "string" || item.includes("\0"))) return undefined;
  }
  if (raw.isError !== undefined && typeof raw.isError !== "boolean") return undefined;
  if (raw.args !== undefined && (!raw.args || typeof raw.args !== "object" || Array.isArray(raw.args))) {
    return undefined;
  }
  if (raw.attachments !== undefined && !Array.isArray(raw.attachments)) return undefined;
  return raw as unknown as RoomMessage;
}

export function isValidRoomId(id: unknown): id is string {
  return typeof id === "string" && ROOM_ID_RE.test(id);
}

export type RoomPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/**
 * Tools whose `can_use_tool` control request is a structured host call, not a
 * yes/no permission gate, AND for which we have nothing to collect from the
 * user — so a plain allow/deny card is a dead end and we auto-allow instead
 * (echoing the original input back as updatedInput). Skill is the only one:
 * it just needs its args echoed.
 *
 * AskUserQuestion is handled separately (NOT here): it needs the user's actual
 * choice, baked into updatedInput.answers — auto-allowing the unanswered input
 * is what made claude report "The user did not answer the questions".
 */
const AUTO_ALLOW_TOOLS = new Set(["Skill"]);

/**
 * Build the `updatedInput` that answers an AskUserQuestion `can_use_tool`
 * request. Empirically (claude CLI, verified against the live control protocol
 * + the Agent SDK docs), the answer must go in an `answers` RECORD keyed by each
 * question's `question` text, with STRING values (arrays/objects fail schema
 * validation). For multiSelect the caller joins chosen labels with ", ". The
 * original `questions` array is passed through (claude validates against it).
 * `answersByQuestion` maps question text → answer string.
 */
export function buildAskUserUpdatedInput(
  input: unknown,
  answersByQuestion: Record<string, string>,
): Record<string, unknown> {
  const obj = (input ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(obj.questions) ? obj.questions : [];
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const text = (q as { question?: unknown })?.question;
    if (typeof text === "string" && typeof answersByQuestion[text] === "string") {
      answers[text] = answersByQuestion[text];
    }
  }
  return { ...obj, answers };
}

/**
 * Parse an AskUserQuestion input into the first question's prompt/header/options
 * so the UI can render a choice card. The room UI answers one question at a time
 * (the first); returns undefined for a non-AskUser / malformed input (no
 * questions), which the caller treats as "fall back to auto-allow".
 */
export function askUserPrompt(
  input: unknown,
): { question: string; header?: string; options: string[]; multiSelect: boolean } | undefined {
  const obj = (input ?? {}) as Record<string, unknown>;
  const q0 = (Array.isArray(obj.questions) ? obj.questions[0] : undefined) as
    | { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown }
    | undefined;
  if (!q0 || typeof q0.question !== "string") return undefined;
  const options = Array.isArray(q0.options)
    ? q0.options
        .map((o) => (o as { label?: unknown })?.label)
        .filter((l): l is string => typeof l === "string")
    : [];
  return {
    question: q0.question,
    header: typeof q0.header === "string" ? q0.header : undefined,
    options,
    multiSelect: q0.multiSelect === true,
  };
}

/** Which external CLI backs the room. "claude-code" drives `claude` (long-lived
 *  stdin process with per-tool approval); "codex" drives `codex exec` (one
 *  process per turn, resumed by thread id, no per-tool approval — the sandbox
 *  tier chosen at open is the only guardrail). */
export type RoomKind = "claude-code" | "codex";

/** Exact external-session identity proved by the host's transcript locator.
 * RoomManager deliberately does not know CLI-specific transcript paths; the
 * host resolves those paths and returns the identity read from disk. */
export interface LinkedSessionTarget {
  externalSessionId: string;
  cwd: string;
  kind: RoomKind;
}

export interface RoomMeta {
  id: string;
  name: string;
  cwd: string;
  kind: RoomKind;
  permissionMode: RoomPermissionMode;
  createdAt: number;
  lastActiveAt: number;
  /** Session/thread id to resume: claude's session_id OR codex's thread_id.
   *  (Named claudeSessionId for back-compat with persisted room.json files.) */
  claudeSessionId?: string;
  /** Persisted capability boundary for a room bound from an external CLI
   * transcript. While set, ordinary open/send calls cannot start an agent;
   * only takeOverLinkedSession may clear it after revalidating the tuple. */
  linkedSessionMode?: "observe-only";
}

export type RoomOpenStatus = "running" | "missing" | "observing";

export interface RoomMessage {
  seq: number;
  ts: number;
  from: "user" | "agent" | "system";
  type: string;
  text?: string;
  tool?: string;
  summary?: string;
  reason?: string;
  isError?: boolean;
  /** claude's tool_use block id — present on `tool` (the start) and
   *  `tool_result` (the matching result) so the UI can pair them by id rather
   *  than guessing "the last open tool". Absent on legacy messages. */
  toolId?: string;
  /** Full structured tool_use input (e.g. a sub-agent's `prompt`) on `tool`
   *  messages. `summary` is a lossy one-field preview; `args` is what the tool
   *  card expands to so the real parameters are visible. Absent on legacy
   *  messages that predate args persistence. */
  args?: Record<string, unknown>;
  attachments?: Array<{ name: string; mime?: string; size: number; path: string }>;
}

const ROOM_ATTACHMENT_START = "<codeshell-image-attachments>";
const ROOM_ATTACHMENT_END = "</codeshell-image-attachments>";

function roomAttachmentSummary(
  attachments: InputAttachmentMeta[],
): NonNullable<RoomMessage["attachments"]> {
  return attachments.map((attachment) => ({
    name: attachment.originalName ?? attachment.relPath ?? attachment.path,
    mime: attachment.mime,
    size: attachment.size,
    path: attachment.relPath ?? attachment.path,
  }));
}

export function roomTurnText(text: string, attachments: InputAttachmentMeta[]): string {
  if (attachments.length === 0) return text;
  const paths = attachments.map(
    (attachment) => `- ${attachment.relPath ?? attachment.path} (${attachment.mime ?? "image"})`,
  );
  return [
    text.trim(),
    ROOM_ATTACHMENT_START,
    "The following images are available as workspace-relative files:",
    ...paths,
    ROOM_ATTACHMENT_END,
  ]
    .filter(Boolean)
    .join("\n");
}

export function stripRoomAttachmentBlock(text: string): string {
  const start = text.indexOf(ROOM_ATTACHMENT_START);
  if (start < 0) return text;
  const end = text.indexOf(ROOM_ATTACHMENT_END, start);
  return (
    end < 0
      ? text.slice(0, start)
      : `${text.slice(0, start)}${text.slice(end + ROOM_ATTACHMENT_END.length)}`
  ).trim();
}

/**
 * Minimal interface a resident agent must satisfy, so RoomManager can be unit
 * tested with a fake (no real claude process).
 */
export interface RoomAgent {
  start(): void;
  send(text: string): boolean;
  isRunning(): boolean;
  stop(): void;
  respondControl?(
    requestId: string,
    decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string },
  ): void;
}

export interface RoomAgentFactory {
  (room: RoomMeta, onEvent: (event: ResidentAgentEvent) => void): RoomAgent;
}

export interface RoomManagerOptions {
  rootDir: string; // <userData>/mobile-remote/rooms
  createAgent: RoomAgentFactory;
  /** Locate an already-running external CLI transcript without starting a CLI.
   * Returning null means the transcript is absent. The returned identity is
   * checked again here so a stale or mismatched locator fails closed. */
  resolveLinkedSession?: (
    target: Readonly<LinkedSessionTarget>,
  ) => LinkedSessionTarget | null | undefined;
  /** Called whenever a room gains a new persisted message (push to phone). */
  onMessage: (roomId: string, msg: RoomMessage) => void;
  /** Called when a room's resident agent requests tool-use approval. For
   *  AskUserQuestion, `askUser` carries the parsed prompt + options so the UI
   *  renders a choice card; the user's pick is routed back via respondApproval's
   *  `answer` field and baked into updatedInput.answers here in main. */
  onApprovalRequest?: (
    roomId: string,
    req: {
      requestId: string;
      toolName: string;
      displayName?: string;
      input: unknown;
      description?: string;
      askUser?: { question: string; header?: string; options: string[]; multiSelect: boolean };
    },
  ) => void;
  /** Called after a room's resident process exits or the room is explicitly
   * closed. Live transcript followers use it as their natural terminal hook. */
  onRoomEnded?: (roomId: string) => void;
  now?: () => number;
}

/**
 * Owns room lifecycle and the on-disk message log (the authoritative source).
 * A room's resident agent is started on open() and its normalized events are
 * appended to messages.jsonl and mirrored via onMessage. seq is monotonic per
 * room so the phone can sync incrementally.
 */
export class RoomManager {
  private agents = new Map<string, RoomAgent>();
  /** Rooms whose visible output is currently sourced from the external CLI's
   * transcript tail. While present, the resident agent's stdout mirror is
   * suppressed so the same CLI output is not pushed twice. */
  private transcriptFollowedRooms = new Set<string>();
  /** Pending AskUserQuestion control requests, keyed by `${roomId}:${requestId}`.
   *  Holds the raw tool input so respondApproval can bake the user's answer into
   *  the `answers` record the CLI expects. Cleared on response. */
  private pendingAskUser = new Map<string, unknown>();
  /** Original server-observed tool inputs for ordinary approvals. The response
   * client may approve or deny, but must not replace the command/path it saw. */
  private pendingApprovalInputs = new Map<string, unknown>();
  /** User turns are echoed immediately for responsive room UX. When a
   * transcript follower later sees the same CLI-written user line, this queue
   * suppresses that duplicate. */
  private pendingTranscriptUserEchoes = new Map<string, Array<{ text: string; ts: number }>>();
  /**
   * Rooms whose agent events must be buffered instead of handled immediately.
   *
   * Only set for the duration of `agent.send()` inside `send()`: acceptance has
   * to be known before the user turn is persisted, but the user turn must still
   * come FIRST in the history. An agent that emits synchronously from send()
   * would otherwise have its reply appended ahead of the prompt it answers.
   */
  private deferredEmitRooms = new Set<string>();
  private deferredEmits = new Map<string, ResidentAgentEvent[]>();
  /**
   * Last assigned message seq per room, so appends do not re-read the whole
   * JSONL. Seeded lazily from disk on the first append after startup; dropped
   * when the room's messages are deleted so the next append re-derives it.
   */
  private lastSeqByRoom = new Map<string, number>();
  /** Throttled lastActiveAt bookkeeping — see touchLastActive. */
  private pendingLastActive = new Map<string, number>();
  private lastActiveWrittenAt = new Map<string, number>();
  private now: () => number;
  private readonly rootRealPath: string;

  /** Drop all pending AskUser entries for a room. Called when its agent goes
   *  away (exit/close) so a request that can no longer be answered doesn't leak
   *  in the map (small memory leak) and its approval card doesn't hang until the
   *  5-min timeout. Keys are `${roomId}:${requestId}`. */
  private clearPendingApprovals(roomId: string): void {
    const prefix = `${roomId}:`;
    for (const key of this.pendingAskUser.keys()) {
      if (key.startsWith(prefix)) this.pendingAskUser.delete(key);
    }
    for (const key of this.pendingApprovalInputs.keys()) {
      if (key.startsWith(prefix)) this.pendingApprovalInputs.delete(key);
    }
  }

  constructor(private readonly opts: RoomManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    mkdirSync(opts.rootDir, { recursive: true, mode: 0o700 });
    const rootInfo = lstatSync(opts.rootDir);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(`invalid room storage root: ${opts.rootDir}`);
    }
    this.rootRealPath = realpathSync(opts.rootDir);
    if (process.platform !== "win32") chmodSync(opts.rootDir, 0o700);
  }

  private assertRootUnchanged(): void {
    const info = lstatSync(this.opts.rootDir);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      realpathSync(this.opts.rootDir) !== this.rootRealPath
    ) {
      throw new Error(`invalid room storage root: ${this.opts.rootDir}`);
    }
  }

  private roomDir(id: string): string {
    // roomId reaches path-building from client WS events (room.open/history/
    // send/close all pass event.roomId straight through), so it is NOT always a
    // system-generated id — an authenticated device could send "../../etc" and
    // traverse out of rootDir. Enforce the generated shape (see createRoom:
    // `room_<base36>_<base36>`) at this single chokepoint so every path-builder
    // (metaPath/msgPath/getRoom/getMessages/open/send/close) is covered.
    if (!isValidRoomId(id)) {
      throw new Error(`invalid roomId: ${JSON.stringify(id)}`);
    }
    this.assertRootUnchanged();
    const dir = join(this.opts.rootDir, id);
    if (existsSync(dir)) {
      const info = lstatSync(dir);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        !isContained(this.rootRealPath, realpathSync(dir))
      ) {
        throw new Error(`invalid room directory: ${dir}`);
      }
    }
    return dir;
  }
  private checkedRoomFile(id: string, name: "room.json" | "messages.jsonl"): string {
    const path = join(this.roomDir(id), name);
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`invalid room file: ${path}`);
    }
    return path;
  }
  private metaPath(id: string): string {
    return this.checkedRoomFile(id, "room.json");
  }
  private msgPath(id: string): string {
    return this.checkedRoomFile(id, "messages.jsonl");
  }

  private writeRoomMeta(id: string, meta: RoomMeta): void {
    const target = this.metaPath(id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      renameSync(temporary, target);
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original metadata persistence error.
      }
    }
  }

  private appendRoomMessage(id: string, msg: RoomMessage): void {
    const target = this.msgPath(id);
    const serialized = JSON.stringify(msg);
    if (Buffer.byteLength(serialized, "utf8") > MAX_ROOM_MESSAGE_BYTES) {
      throw new Error("room message exceeds the size limit");
    }
    const fd = openSync(target, "a+", 0o600);
    try {
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
      const size = fstatSync(fd).size;
      let prefix = "";
      if (size > 0) {
        const lastByte = Buffer.allocUnsafe(1);
        readSync(fd, lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) prefix = "\n";
      }
      appendFileSync(fd, `${prefix}${serialized}\n`, "utf-8");
    } finally {
      closeSync(fd);
    }
  }

  createRoom(input: {
    name?: string;
    cwd: string;
    kind?: RoomKind;
    permissionMode?: RoomPermissionMode;
    claudeSessionId?: string;
    linkedSessionMode?: "observe-only";
  }): RoomMeta {
    if (
      !input ||
      typeof input.cwd !== "string" ||
      !input.cwd ||
      input.cwd.length > 32_768 ||
      input.cwd.includes("\0") ||
      (input.name !== undefined &&
        (typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.length > 512 ||
          input.name.includes("\0"))) ||
      (input.kind !== undefined && input.kind !== "claude-code" && input.kind !== "codex") ||
      (input.permissionMode !== undefined &&
        input.permissionMode !== "default" &&
        input.permissionMode !== "acceptEdits" &&
        input.permissionMode !== "bypassPermissions") ||
      (input.claudeSessionId !== undefined &&
        (typeof input.claudeSessionId !== "string" ||
          input.claudeSessionId.length > 4_096 ||
          input.claudeSessionId.includes("\0"))) ||
      (input.linkedSessionMode !== undefined && input.linkedSessionMode !== "observe-only")
    ) {
      throw new Error("invalid room metadata");
    }
    const id = `room_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const meta: RoomMeta = {
      id,
      name: input.name ?? input.cwd.split("/").filter(Boolean).pop() ?? "room",
      cwd: input.cwd,
      kind: input.kind ?? "claude-code",
      permissionMode: input.permissionMode ?? "default",
      createdAt: this.now(),
      lastActiveAt: this.now(),
      claudeSessionId: input.claudeSessionId,
      linkedSessionMode: input.linkedSessionMode,
    };
    mkdirSync(this.roomDir(id), { recursive: true, mode: 0o700 });
    this.writeRoomMeta(id, meta);
    // Audit anchor: the first line records how the room was opened (cwd +
    // permission mode), so messages.jsonl is self-describing for "what could
    // this room do" forensics.
    this.append(id, {
      from: "system",
      type: "room_created",
      text: `cwd=${meta.cwd} permission=${meta.permissionMode}`,
    });
    return meta;
  }

  listRooms(): RoomMeta[] {
    if (!existsSync(this.opts.rootDir)) return [];
    const rooms: RoomMeta[] = [];
    this.assertRootUnchanged();
    for (const entry of readdirSync(this.opts.rootDir).slice(0, MAX_ROOM_ENTRIES)) {
      if (!isValidRoomId(entry)) continue;
      try {
        const p = this.metaPath(entry);
        if (!existsSync(p)) continue;
        const room = parseRoomMeta(JSON.parse(readBoundedUtf8File(p, MAX_ROOM_META_BYTES)), entry);
        if (room) rooms.push(room);
      } catch {
        /* skip corrupt */
      }
    }
    return rooms.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  getRoom(id: string): RoomMeta | undefined {
    // Invalid ids resolve to "no such room" rather than throwing, so the WS
    // event handlers (which call this first) degrade to a missing response
    // instead of crashing on a malicious roomId.
    if (!isValidRoomId(id)) return undefined;
    try {
      const p = this.metaPath(id);
      if (!existsSync(p)) return undefined;
      return parseRoomMeta(JSON.parse(readBoundedUtf8File(p, MAX_ROOM_META_BYTES)), id);
    } catch {
      return undefined;
    }
  }

  private nextSeq(id: string): number {
    // Scan the file ONCE per room, then keep the counter in memory.
    //
    // This used to call getMessages(id, 0) on every append — a full synchronous
    // read + JSON.parse of the entire messages.jsonl just to learn the last seq.
    // Appending N messages therefore cost O(N²) parsing, all of it on the remote
    // host's event loop: a long-lived room progressively slowed down new
    // messages, heartbeats and every other WebSocket client. (Measured: ~32s to
    // write 2,000 short messages.)
    const cached = this.lastSeqByRoom.get(id);
    if (cached !== undefined) {
      const next = cached + 1;
      this.lastSeqByRoom.set(id, next);
      return next;
    }
    const msgs = this.getMessages(id, 0);
    const next = msgs.length === 0 ? 1 : msgs[msgs.length - 1]!.seq + 1;
    this.lastSeqByRoom.set(id, next);
    return next;
  }

  private append(id: string, partial: Omit<RoomMessage, "seq" | "ts">): RoomMessage {
    const ts = this.now();
    const previousCachedSeq = this.lastSeqByRoom.get(id);
    const seq = this.nextSeq(id);
    const msg: RoomMessage = { seq, ts, ...partial };
    try {
      this.appendRoomMessage(id, msg);
    } catch (error) {
      // Sequence assignment is a commit effect, not an attempt counter. A
      // failed serialization/write must not leave a phantom gap in memory.
      if (this.lastSeqByRoom.get(id) === seq) {
        if (previousCachedSeq === undefined) this.lastSeqByRoom.delete(id);
        else this.lastSeqByRoom.set(id, previousCachedSeq);
      }
      throw error;
    }
    // Touch lastActiveAt so idle-based pruning measures real activity, not just
    // creation time — a room chatted with daily should never be reaped.
    this.touchLastActive(id, ts);
    try {
      this.opts.onMessage(id, msg);
    } catch {
      // Persistence is authoritative. A broken live-push subscriber must not
      // make the caller retry a message that is already safely on disk.
    }
    return msg;
  }

  /**
   * Refresh the room's `lastActiveAt`, throttled.
   *
   * This re-read and rewrote the whole room.json on EVERY appended message. The
   * field only feeds idle-based pruning (measured in hours), so second-level
   * precision is worthless while the write cost is paid per message — together
   * with the old full-history seq scan it made a busy room progressively slower.
   *
   * Writes at most once per THROTTLE window per room; `flushLastActive` forces
   * one out at close/prune time so a room that goes quiet still records its real
   * last activity.
   */
  private touchLastActive(id: string, ts: number): void {
    this.pendingLastActive.set(id, ts);
    const lastWrite = this.lastActiveWrittenAt.get(id) ?? 0;
    if (ts - lastWrite < LAST_ACTIVE_THROTTLE_MS) return;
    this.flushLastActive(id);
  }

  /** Persist a pending lastActiveAt immediately, if there is one. */
  private flushLastActive(id: string): void {
    const ts = this.pendingLastActive.get(id);
    if (ts === undefined) return;
    this.pendingLastActive.delete(id);
    const meta = this.getRoom(id);
    if (!meta) return;
    this.lastActiveWrittenAt.set(id, ts);
    this.writeRoomMeta(id, { ...meta, lastActiveAt: ts });
  }

  /** Persist the room's resume id (claude session_id / codex thread_id) so the
   *  next open() can continue the same conversation. No-op if unchanged. */
  setRoomSessionId(id: string, sessionId: string): void {
    const meta = this.getRoom(id);
    if (!meta || meta.claudeSessionId === sessionId) return;
    this.writeRoomMeta(id, { ...meta, claudeSessionId: sessionId });
  }

  getMessages(id: string, sinceSeq = 0): RoomMessage[] {
    if (!isValidRoomId(id)) return [];
    const cursor = Number.isSafeInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
    let fd: number | undefined;
    try {
      const p = this.msgPath(id);
      if (!existsSync(p)) return [];
      fd = openSync(p, "r");
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - MAX_ROOM_HISTORY_SCAN_BYTES);
      const length = size - start;
      const buffer = Buffer.allocUnsafe(length);
      let total = 0;
      while (total < length) {
        const count = readSync(fd, buffer, total, length - total, start + total);
        if (count === 0) break;
        total += count;
      }
      let window = buffer.subarray(0, total);
      if (start > 0) {
        const firstNewline = window.indexOf(0x0a);
        if (firstNewline < 0) return [];
        window = window.subarray(firstNewline + 1);
      }
      const out: RoomMessage[] = [];
      for (const line of window.toString("utf8").split("\n")) {
        if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_ROOM_MESSAGE_BYTES) continue;
        try {
          const message = parseRoomMessage(JSON.parse(line) as unknown);
          if (message && message.seq > cursor) out.push(message);
        } catch {
          /* skip malformed/torn lines */
        }
        if (out.length > MAX_ROOM_HISTORY_MESSAGES * 2) {
          out.splice(0, out.length - MAX_ROOM_HISTORY_MESSAGES);
        }
      }
      return out.slice(-MAX_ROOM_HISTORY_MESSAGES);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  latestSeq(id: string): number {
    return this.getMessages(id).at(-1)?.seq ?? 0;
  }

  beginTranscriptFollow(id: string): void {
    if (this.getRoom(id)) this.transcriptFollowedRooms.add(id);
  }

  endTranscriptFollow(id: string): void {
    this.transcriptFollowedRooms.delete(id);
  }

  /** Persist normalized transcript-tail messages through the same seq/history/
   * broadcast path as resident-agent output. */
  ingestTranscriptMessages(id: string, messages: Omit<RoomMessage, "seq" | "ts">[]): void {
    if (!this.transcriptFollowedRooms.has(id) || !this.getRoom(id)) return;
    for (const message of messages) {
      if (message.from === "user" && typeof message.text === "string") {
        const text = stripRoomAttachmentBlock(message.text);
        const pending = this.pendingTranscriptUserEchoes.get(id);
        const cutoff = this.now() - 60_000;
        while (pending?.length && pending[0]!.ts < cutoff) pending.shift();
        const matched = pending?.[0]?.text === text;
        if (matched) pending!.shift();
        if (pending?.length === 0) this.pendingTranscriptUserEchoes.delete(id);
        // `send` already persisted and broadcast this exact user turn. The
        // transcript remains authoritative for agent/tool output, but must not
        // render a second copy of the prompt.
        if (!matched) this.append(id, { ...message, text });
      } else {
        this.append(id, message);
      }
    }
  }

  /**
   * Open (or create) the room bound to a claude session id, deduping by that id
   * so a given claude session maps to exactly one room. Returns the room id.
   */
  openForSession(
    claudeSessionId: string,
    cwd: string,
    mode: RoomPermissionMode,
    kind: RoomKind = "claude-code",
  ): { roomId: string; status: RoomOpenStatus } {
    // Reuse must match BOTH id and kind: a codex thread id and a claude session
    // id live in the same `claudeSessionId` field, so a bare id match could
    // otherwise hand back a claude room when a codex room was asked for.
    const existing = claudeSessionId
      ? this.listRooms().find((r) => r.claudeSessionId === claudeSessionId && r.kind === kind)
      : undefined;
    const meta =
      existing ??
      this.createRoom({
        cwd,
        kind,
        permissionMode: mode,
        claudeSessionId: claudeSessionId || undefined,
      });
    // permissionMode is a spawn-time CLI arg (--permission-mode), so it can't be
    // changed on a live process. If the caller reopens an existing room under a
    // DIFFERENT mode, persist the new mode and restart the resident agent;
    // otherwise reopening keeps the running process and the picked mode would be
    // silently ignored (the "bypassPermissions still prompts" bug).
    if (existing && existing.permissionMode !== mode) {
      this.writeRoomMeta(meta.id, { ...meta, permissionMode: mode });
      this.close(meta.id); // stop the old-mode process so open() respawns fresh
    }
    const { status } = this.open(meta.id);
    return { roomId: meta.id, status };
  }

  /** Bind an external CLI transcript to a room for observation only.
   *
   * This method never creates or starts a resident agent. The host must first
   * prove that an on-disk transcript exists for the exact kind + session id +
   * cwd tuple. A missing locator, missing transcript, or mismatched identity
   * fails closed before a room is created.
   */
  openLinkedSession(
    externalSessionId: string,
    cwd: string,
    kind: RoomKind,
  ): {
    roomId: string;
    status: "observing" | "running";
    mode: RoomPermissionMode;
    cwd: string;
  } {
    const target = this.requireLinkedSessionTarget({ externalSessionId, cwd, kind });
    const existing = this.listRooms().find(
      (room) => room.claudeSessionId === target.externalSessionId && room.kind === target.kind,
    );
    if (existing && resolve(existing.cwd) !== target.cwd) {
      throw new Error("linked session cwd does not match the existing room");
    }
    const isRunning = existing ? this.isOpen(existing.id) : false;
    let meta: RoomMeta;
    if (existing) {
      meta = {
        ...existing,
        cwd: target.cwd,
      };
      // Navigation must not turn an ordinary dormant room into a permanently
      // observe-only room. Existing linked rooms keep their boundary; ordinary
      // rooms are observed transiently and remain writable through the normal
      // open flow.
      if (meta.cwd !== existing.cwd) {
        this.writeRoomMeta(meta.id, meta);
      }
    } else {
      meta = this.createRoom({
        cwd: target.cwd,
        kind: target.kind,
        permissionMode: "default",
        claudeSessionId: target.externalSessionId,
        linkedSessionMode: "observe-only",
      });
    }
    const status = isRunning ? "running" : "observing";
    return { roomId: meta.id, status, mode: meta.permissionMode, cwd: meta.cwd };
  }

  /** Explicitly take control of a previously observed external CLI room.
   * This is the linked-session operation that may create/start an agent. The
   * external identity is revalidated at takeover time so stale links cannot
   * silently start a different session. */
  takeOverLinkedSession(
    roomId: string,
    externalSessionId: string,
    cwd: string,
    kind: RoomKind,
  ): {
    roomId: string;
    status: "running";
    mode: RoomPermissionMode;
    cwd: string;
  } {
    const target = this.requireLinkedSessionTarget({ externalSessionId, cwd, kind });
    const meta = this.getRoom(roomId);
    if (
      !meta ||
      meta.claudeSessionId !== target.externalSessionId ||
      meta.kind !== target.kind ||
      resolve(meta.cwd) !== target.cwd
    ) {
      throw new Error("linked session does not match the requested room");
    }
    const controllableMeta: RoomMeta = {
      ...meta,
      cwd: target.cwd,
      // Observe-only navigation never asks the user to approve a stored
      // permission mode. A prior bypassPermissions value must not be inherited
      // silently when takeover starts a new process.
      permissionMode: "default",
      linkedSessionMode: undefined,
    };
    this.writeRoomMeta(roomId, controllableMeta);
    const { status } = this.open(roomId);
    if (status !== "running") {
      throw new Error("linked session room is unavailable");
    }
    return { roomId, status, mode: controllableMeta.permissionMode, cwd: controllableMeta.cwd };
  }

  private requireLinkedSessionTarget(target: LinkedSessionTarget): LinkedSessionTarget {
    if (
      !target.externalSessionId.trim() ||
      !target.cwd.trim() ||
      (target.kind !== "claude-code" && target.kind !== "codex")
    ) {
      throw new Error("linked session id, cwd, and kind are required");
    }

    let resolvedTarget: LinkedSessionTarget | null | undefined;
    try {
      resolvedTarget = this.opts.resolveLinkedSession?.(target);
    } catch {
      throw new Error("linked session transcript is unavailable");
    }
    if (
      !resolvedTarget ||
      typeof resolvedTarget.externalSessionId !== "string" ||
      typeof resolvedTarget.cwd !== "string" ||
      resolvedTarget.externalSessionId !== target.externalSessionId ||
      resolvedTarget.kind !== target.kind ||
      resolve(resolvedTarget.cwd) !== resolve(target.cwd)
    ) {
      throw new Error("linked session transcript does not match the requested session");
    }
    return { ...target, cwd: resolve(resolvedTarget.cwd) };
  }

  /**
   * Forward a phone-side approval decision to the room's resident agent.
   * Returns false if the room has no live agent (or it can't take control
   * responses).
   */
  respondApproval(
    roomId: string,
    requestId: string,
    decision:
      | { behavior: "allow"; updatedInput?: unknown; answer?: string }
      | { behavior: "deny"; message: string },
  ): boolean {
    // Reap the stashed AskUser input FIRST, before the agent-existence check.
    // Otherwise, if the agent already exited, the early return below would skip
    // the delete and leak the pending entry (and the approval card would hang
    // until its timeout). Deleting up front is safe: a missing agent means the
    // request can no longer be answered anyway.
    const askKey = `${roomId}:${requestId}`;
    const hasPendingAsk = this.pendingAskUser.has(askKey);
    const pending = this.pendingAskUser.get(askKey);
    this.pendingAskUser.delete(askKey);
    const hasOriginalInput = this.pendingApprovalInputs.has(askKey);
    const originalInput = this.pendingApprovalInputs.get(askKey);
    this.pendingApprovalInputs.delete(askKey);

    const agent = this.agents.get(roomId);
    if (!agent?.respondControl) return false;

    // AskUserQuestion: an "allow" carries the user's chosen answer string, which
    // main (the single source of truth) bakes into the `answers` record keyed by
    // question text — the only shape the CLI accepts. The raw input was stashed
    // on approval_request. Deny passes through (claude treats it as "did not
    // answer", same as the desktop CLI's own cancel).
    if (hasPendingAsk) {
      if (decision.behavior === "deny") {
        agent.respondControl(requestId, decision);
        return true;
      }
      const prompt = askUserPrompt(pending);
      const answersByQuestion = prompt ? { [prompt.question]: decision.answer ?? "" } : {};
      agent.respondControl(requestId, {
        behavior: "allow",
        updatedInput: buildAskUserUpdatedInput(pending, answersByQuestion),
      });
      return true;
    }

    if (decision.behavior === "allow" && hasOriginalInput) {
      const updatedInput =
        originalInput && typeof originalInput === "object" && !Array.isArray(originalInput)
          ? originalInput
          : {};
      agent.respondControl(requestId, { behavior: "allow", updatedInput });
    } else {
      agent.respondControl(requestId, decision);
    }
    return true;
  }

  /** Open a room: start its resident agent if not already running. Observe-only
   * linked rooms fail closed until takeOverLinkedSession clears the boundary. */
  open(id: string): { status: RoomOpenStatus } {
    const meta = this.getRoom(id);
    if (!meta) return { status: "missing" };
    if (meta.linkedSessionMode === "observe-only") return { status: "observing" };
    if (!this.agents.has(id)) {
      const agent = this.opts.createAgent(meta, (event) => this.onAgentEvent(id, event));
      this.agents.set(id, agent);
      try {
        agent.start();
      } catch (error) {
        if (this.agents.get(id) === agent) this.agents.delete(id);
        this.clearPendingApprovals(id);
        try {
          agent.stop();
        } catch {
          // Preserve the original start error.
        }
        throw error;
      }
      // A start implementation may synchronously emit exit. Do not report a
      // running room after that callback already removed this exact agent.
      if (this.agents.get(id) !== agent || !agent.isRunning()) return { status: "missing" };
    }
    return { status: "running" };
  }

  private onAgentEvent(id: string, event: ResidentAgentEvent): void {
    // Buffered while send() is deciding acceptance — replayed right after the
    // user turn is appended, so a synchronous agent reply cannot precede it.
    if (this.deferredEmitRooms.has(id)) {
      const queued = this.deferredEmits.get(id) ?? [];
      queued.push(event);
      this.deferredEmits.set(id, queued);
      return;
    }
    if (
      this.transcriptFollowedRooms.has(id) &&
      (event.type === "text" ||
        event.type === "tool" ||
        event.type === "tool_result" ||
        event.type === "turn_end")
    ) {
      return;
    }
    switch (event.type) {
      case "text":
        this.append(id, { from: "agent", type: "text", text: event.text });
        break;
      case "tool":
        this.append(id, {
          from: "agent",
          type: "tool",
          tool: event.tool,
          summary: event.summary,
          toolId: event.id,
          args: event.input,
        });
        break;
      case "tool_result":
        this.append(id, {
          from: "agent",
          type: "tool_result",
          summary: event.summary,
          isError: event.isError,
          toolId: event.id,
        });
        break;
      case "turn_end":
        this.append(id, { from: "agent", type: "turn_end", reason: event.reason });
        break;
      case "error":
        this.append(id, { from: "system", type: "error", text: event.error });
        break;
      case "approval_request": {
        // Skill routes through can_use_tool only to deliver its args (nothing to
        // ask the user), and emits the request even under bypassPermissions —
        // auto-allow it, echoing the input back, rather than show a dead-end
        // card.
        if (AUTO_ALLOW_TOOLS.has(event.toolName)) {
          this.agents
            .get(id)
            ?.respondControl?.(event.requestId, { behavior: "allow", updatedInput: event.input });
          break;
        }
        // AskUserQuestion is NOT a permission gate — it needs the user's actual
        // choice. Parse the options (askUser) so the UI shows a choice card, and
        // stash the raw input so respondApproval can bake the answer into the
        // `answers` record the CLI requires. Auto-allowing the unanswered input
        // is what made claude report "The user did not answer the questions".
        if (event.toolName === "AskUserQuestion") {
          const askUser = askUserPrompt(event.input);
          if (askUser) {
            this.pendingAskUser.set(`${id}:${event.requestId}`, event.input);
            this.append(id, {
              from: "agent",
              type: "approval",
              tool: event.toolName,
              summary: askUser.question,
            });
            this.opts.onApprovalRequest?.(id, { ...event, askUser });
            break;
          }
          // Malformed AskUser (no questions) → auto-allow so the turn isn't
          // wedged forever waiting on an answer that can't be collected.
          this.agents
            .get(id)
            ?.respondControl?.(event.requestId, { behavior: "allow", updatedInput: event.input });
          break;
        }
        this.append(id, {
          from: "agent",
          type: "approval",
          tool: event.toolName,
          summary: event.description ?? "",
        });
        this.pendingApprovalInputs.set(`${id}:${event.requestId}`, event.input);
        this.opts.onApprovalRequest?.(id, event);
        break;
      }
      case "exit":
        this.agents.delete(id);
        this.clearPendingApprovals(id);
        // Let the transcript follower synchronously drain final file bytes
        // before appending the terminal marker. Otherwise an exit that beats
        // watchFile's poll can drop the last assistant line or place it after
        // agent_exit in the room stream.
        this.opts.onRoomEnded?.(id);
        this.append(id, {
          from: "system",
          type: "agent_exit",
          reason: String(event.code ?? event.signal ?? ""),
        });
        break;
    }
  }

  /** Post a user message: persist it, ensure agent running, feed it. */
  send(id: string, text: string, attachments: InputAttachmentMeta[] = []): boolean {
    const meta = this.getRoom(id);
    if (!meta) return false;
    const displayText = text.trim();
    if (!displayText && attachments.length === 0) return false;
    if (this.open(id).status !== "running") return false;
    const summaries = roomAttachmentSummary(attachments);
    const agentText = roomTurnText(displayText, attachments);

    // Decide acceptance BEFORE persisting, but keep the user turn first in the
    // history.
    //
    // The old order was append-then-send, with send()'s result returned straight
    // to the phone. `CodexRoomAgent.send()` returns false while a previous turn
    // is still running, so the phone showed "房间未就绪或已关闭" while the very
    // same text was already in messages.jsonl and broadcast to every other
    // client — a message that looks delivered but was never given to the agent.
    // With attachments it was worse: the handler released the upload claim,
    // leaving a history entry pointing at an attachment that never materialized.
    //
    // Simply moving append() after send() is not enough: an agent that emits its
    // reply synchronously from send() would land the reply BEFORE the user turn.
    // So buffer anything the agent emits during the call and flush it after the
    // user message is appended. (The real Codex agent spawns a child and emits
    // asynchronously, but ordering must not depend on that.)
    const agent = this.agents.get(id);
    if (!agent) return false;

    this.deferredEmitRooms.add(id);
    let accepted: boolean;
    try {
      accepted = agent.send(agentText);
    } catch (error) {
      this.deferredEmits.delete(id);
      throw error;
    } finally {
      this.deferredEmitRooms.delete(id);
    }

    const buffered = this.deferredEmits.get(id) ?? [];
    this.deferredEmits.delete(id);

    if (!accepted) {
      // Rejected: nothing about this turn reaches history or the phone.
      return false;
    }

    this.append(id, {
      from: "user",
      type: "text",
      text: displayText,
      ...(summaries.length ? { attachments: summaries } : {}),
    });
    if (this.transcriptFollowedRooms.has(id)) {
      const pending = this.pendingTranscriptUserEchoes.get(id) ?? [];
      pending.push({ text: displayText, ts: this.now() });
      this.pendingTranscriptUserEchoes.set(id, pending);
    }
    // Replay whatever the agent produced synchronously, now correctly ordered
    // after the user turn.
    for (const event of buffered) this.onAgentEvent(id, event);
    return true;
  }

  close(id: string): void {
    // A room going quiet must record its REAL last activity, not the last
    // throttled write.
    this.flushLastActive(id);
    const agent = this.agents.get(id);
    try {
      agent?.stop();
    } finally {
      if (!agent || this.agents.get(id) === agent) this.agents.delete(id);
      this.clearPendingApprovals(id);
      this.pendingTranscriptUserEchoes.delete(id);
      this.deferredEmitRooms.delete(id);
      this.deferredEmits.delete(id);
      this.opts.onRoomEnded?.(id);
    }
  }

  closeAll(): void {
    const ids = new Set([...this.agents.keys(), ...this.transcriptFollowedRooms]);
    let firstError: unknown;
    for (const agent of this.agents.values()) {
      try {
        agent.stop();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.agents.clear();
    this.pendingAskUser.clear();
    this.pendingApprovalInputs.clear();
    this.pendingTranscriptUserEchoes.clear();
    this.deferredEmitRooms.clear();
    this.deferredEmits.clear();
    for (const id of ids) {
      try {
        this.opts.onRoomEnded?.(id);
      } catch (error) {
        firstError ??= error;
      }
    }
    this.transcriptFollowedRooms.clear();
    if (firstError) throw firstError;
  }

  isOpen(id: string): boolean {
    return this.agents.get(id)?.isRunning() ?? false;
  }

  /**
   * Delete rooms whose last activity is older than maxAgeMs (idle-based GC,
   * replacing the removed one-shot /cc path's lack of cleanup). A room with a
   * currently running resident agent is NEVER reaped, regardless of age — only
   * truly dormant rooms (whole directory) are removed. Returns the ids deleted.
   */
  pruneStaleRooms(maxAgeMs: number): string[] {
    // Flush pending timestamps first: pruning reads lastActiveAt off disk, and a
    // throttled-but-unwritten value would make an active room look dormant.
    for (const id of [...this.pendingLastActive.keys()]) this.flushLastActive(id);
    const cutoff = this.now() - maxAgeMs;
    const removed: string[] = [];
    for (const meta of this.listRooms()) {
      if (meta.lastActiveAt > cutoff) continue;
      if (this.isOpen(meta.id)) continue; // never reap a live session
      rmSync(this.roomDir(meta.id), { recursive: true, force: true });
      this.agents.delete(meta.id);
      // Drop the cached seq with the files, so a room id that somehow comes back
      // re-derives its counter from disk instead of continuing a dead sequence.
      this.lastSeqByRoom.delete(meta.id);
      removed.push(meta.id);
    }
    return removed;
  }
}
