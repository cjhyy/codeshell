import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
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
import {
  readRoomHistoryPage,
  scanRoomHistory,
  scanRoomHistoryAsync,
  type RoomHistoryRequest,
  type RoomHistoryPage,
} from "./room-history.js";
export type { RoomHistoryPage, RoomHistoryRequest } from "./room-history.js";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResidentAgentEvent } from "./resident-agent.js";
import type { InputAttachmentMeta } from "../attachment-service.js";
import { createRoomModelTrace } from "./room-model-tracing.js";

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

function syncRoomDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

/** Room metadata names are capped at this many UTF-16 units by parseRoomMeta. */
const MAX_ROOM_NAME_LENGTH = 512;

/**
 * Default room name: the cwd's last path segment. Windows drive and UNC paths
 * also split on backslashes. Bounded to the metadata name limit, without
 * leaving half of a surrogate pair, so the reader accepts what we write.
 */
function defaultRoomName(cwd: string): string {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd);
  const segment =
    cwd
      .split(windows ? /[\\/]/ : "/")
      .filter(Boolean)
      .pop() ?? "room";
  if (segment.length <= MAX_ROOM_NAME_LENGTH) return segment;
  const end = /[\uD800-\uDBFF]/.test(segment[MAX_ROOM_NAME_LENGTH - 1]!)
    ? MAX_ROOM_NAME_LENGTH - 1
    : MAX_ROOM_NAME_LENGTH;
  return segment.slice(0, end);
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
    raw.name.length > MAX_ROOM_NAME_LENGTH ||
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
    ...(typeof raw.claudeSessionId === "string" ? { claudeSessionId: raw.claudeSessionId } : {}),
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
  for (const field of [
    "text",
    "tool",
    "summary",
    "reason",
    "toolId",
    "transcriptSource",
    "clientMessageId",
    "clientDeviceId",
    "clientIntentHash",
  ] as const) {
    const item = raw[field];
    if (item !== undefined && (typeof item !== "string" || item.includes("\0"))) return undefined;
  }
  if (raw.isError !== undefined && typeof raw.isError !== "boolean") return undefined;
  if (
    raw.args !== undefined &&
    (!raw.args || typeof raw.args !== "object" || Array.isArray(raw.args))
  ) {
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

type AskUserQuestionPrompt = {
  question: string;
  header?: string;
  options: string[];
  multiSelect: boolean;
};

function parseAskUserQuestion(value: unknown): AskUserQuestionPrompt | undefined {
  const q = value as
    | { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown }
    | undefined;
  if (!q || typeof q.question !== "string") return undefined;
  const options = Array.isArray(q.options)
    ? q.options
        .map((o) => (o as { label?: unknown })?.label)
        .filter((l): l is string => typeof l === "string")
    : [];
  return {
    question: q.question,
    header: typeof q.header === "string" ? q.header : undefined,
    options,
    multiSelect: q.multiSelect === true,
  };
}

/**
 * Parse an AskUserQuestion input into the first question's prompt/header/options
 * so the UI can render a choice card. Returns undefined for a non-AskUser /
 * malformed input (no questions), which the caller treats as "fall back to
 * auto-allow".
 */
export function askUserPrompt(input: unknown): AskUserQuestionPrompt | undefined {
  const obj = (input ?? {}) as Record<string, unknown>;
  return parseAskUserQuestion(Array.isArray(obj.questions) ? obj.questions[0] : undefined);
}

/** Every well-formed question of one AskUserQuestion request, in order. One
 * control request carries them all and is answered exactly once, so the UI
 * must collect every answer before responding. */
function askUserQuestions(input: unknown): AskUserQuestionPrompt[] {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(obj.questions)) return [];
  return obj.questions.flatMap((q) => parseAskUserQuestion(q) ?? []);
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

/** Why a room cannot change its spawn-time permission mode right now. */
export type RoomBusyReason = "switching" | "retiring" | "turn" | "approval";

const ROOM_BUSY_MESSAGES: Record<RoomBusyReason, string> = {
  switching: "该 CLI 会话正在切换权限模式，请稍后重试。",
  retiring:
    "该 CLI 会话的旧进程仍未确认退出；为避免两个进程同时写入同一会话，暂不启动新进程，请稍后重试。",
  turn: "该 CLI 会话仍有任务在运行或排队，请先停止或等待完成后再切换权限模式。",
  approval: "该 CLI 会话有待处理的审批或提问，请先处理后再切换权限模式。",
};

export class RoomBusyError extends Error {
  constructor(readonly reason: RoomBusyReason) {
    super(ROOM_BUSY_MESSAGES[reason]);
    this.name = "RoomBusyError";
  }
}

/** The room or its process changed between planning and applying a mode change. */
export class RoomStateChangedError extends Error {
  constructor(message = "CLI 会话状态已变化，请重新选择权限模式。") {
    super(message);
    this.name = "RoomStateChangedError";
  }
}

/**
 * Read-only plan for opening an external CLI session under a mode. A Host may
 * ask for authorization between plan and apply; apply re-validates every field.
 */
export interface RoomSessionOpenPlan {
  /** Existing room id, or an id reserved for the room apply() will create. */
  roomId: string;
  created: boolean;
  sessionId: string;
  /** Canonical directory the CLI process will run in. */
  cwd: string;
  kind: RoomKind;
  /** Live process mode, else persisted mode; undefined for a new room. */
  fromMode?: RoomPermissionMode;
  toMode: RoomPermissionMode;
  /** False when metadata and any live process already run in toMode. */
  change: boolean;
  /** True when a process is live now (an unchanged open will reuse it). */
  live: boolean;
  observing: boolean;
  revision: number;
}

export interface RoomSessionOpenResult {
  roomId: string;
  status: RoomOpenStatus;
  mode: RoomPermissionMode;
  changed: boolean;
}

function canonicalDirectory(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

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
  /** Durable external transcript provenance, scoped to its actual file incarnation. */
  transcriptSource?: string;
  attachments?: Array<{ name: string; mime?: string; size: number; path: string }>;
  /** Exact mobile intent receipt, durable alongside its accepted user turn. */
  clientMessageId?: string;
  clientDeviceId?: string;
  clientIntentHash?: string;
}
export interface RoomInputReceipt {
  clientMessageId: string;
  clientDeviceId: string;
  clientIntentHash: string;
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
  /** Stop, then resolve true only after the process has really exited. A
   * replacement for the same external session must not start before that. */
  stopAndWait?(timeoutMs: number): Promise<boolean>;
  /** True while a turn process is alive. Codex spawns one child per turn and
   * that child can outlive the parsed turn_end. Agents without this hook are
   * tracked by accepted-input / turn_end accounting. */
  isBusy?(): boolean;
  /** Resolves once the spawned process exists; rejects for a failed spawn. */
  whenStarted?(): Promise<void>;
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
  /** Explicit Host-owned model history target; never derived from room/client input. */
  modelTracing?: {
    storageDir: string;
    parameters?: (room: Readonly<RoomMeta>) => Record<string, unknown>;
  };
  /** Locate an already-running external CLI transcript without starting a CLI.
   * Returning null means the transcript is absent. The returned identity is
   * checked again here so a stale or mismatched locator fails closed. */
  resolveLinkedSession?: (
    target: Readonly<LinkedSessionTarget>,
  ) => LinkedSessionTarget | null | undefined;
  /** Throws while a background task (DriveAgent) may still be writing this
   * external session. Checked before any resident agent can start on it, so
   * desktop and phone entry points share one ownership gate. */
  assertExternalSessionAvailable?: (externalSessionId: string, kind: RoomKind) => void;
  /** Host start policy, checked before ANY resident agent is created (open,
   * send's implicit open, session open, takeover). Throwing refuses the start.
   * Persisted metadata alone is never an authorization: the Host decides. */
  authorizeStart?: (room: Readonly<RoomMeta>) => void;
  /** Bound on waiting for a retired process during a mode handoff. */
  processExitTimeoutMs?: number;
  /** Called after an explicit close() (not after a process exit). */
  onRoomClosed?: (roomId: string) => void;
  /** Called when a room's process state changed without a caller to report
   * it: a failed mode handoff after the old process exited, a failed first
   * start, or a retired process finally proven gone. Hosts republish the
   * room's authoritative state to every view. */
  onRoomStateChanged?: (roomId: string) => void;
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
      askUser?: AskUserQuestionPrompt & { questions?: AskUserQuestionPrompt[] };
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
  /** Permission mode each live agent was spawned with. The mode is a spawn-time
   * CLI argument, so room metadata alone cannot prove what a process runs. */
  private agentModes = new WeakMap<RoomAgent, RoomPermissionMode>();
  /** Accepted inputs minus turn_end per room, for agents without isBusy(). A
   * Claude resident process queues several inputs; each ends with a result. */
  private turnCounts = new Map<string, number>();
  /** In-flight mode handoff per room. close() deletes it, so a handoff that is
   * waiting for the old process can never reopen a room the user closed. */
  private transitions = new Map<string, symbol>();
  /** Detached processes not yet proven exited. This is a process-safety fence,
   * independent of any operation: close() and cancellation leave it in place,
   * and no agent may start for the room until the process has really exited,
   * so one external session never has two writers. */
  private retiring = new Map<string, RoomAgent>();
  private retiringProbes = new Map<string, Promise<boolean>>();
  /** Bumped on every change to a room's process or mode, so a Host approval
   * granted for one state cannot be applied to another. */
  private revisions = new Map<string, number>();
  private modelTraces = new Map<string, ReturnType<typeof createRoomModelTrace>>();
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
  private readonly transcriptSources = new Map<string, Set<string>>();
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
  private readonly messageStampByRoom = new Map<string, string>();
  private messageStamp(id: string): string {
    const stat = lstatSync(this.msgPath(id));
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  }
  private lastSeqByRoom = new Map<string, number>();
  /** Throttled lastActiveAt bookkeeping — see touchLastActive. */
  private pendingLastActive = new Map<string, number>();
  private lastActiveWrittenAt = new Map<string, number>();
  private now: () => number;
  private readonly rootRealPath: string;
  private readonly rootIdentity: string;
  private readonly failedWrites = new Set<string>();
  private readonly preparingInputReceipts = new Map<string, Promise<void>>();
  private readonly inputReceipts = new Map<
    string,
    { stamp: string; intents: Map<string, string> }
  >();

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
    this.rootIdentity = `${rootInfo.dev}:${rootInfo.ino}`;
    if (process.platform !== "win32") chmodSync(opts.rootDir, 0o700);
  }

  private assertRootUnchanged(): void {
    const info = lstatSync(this.opts.rootDir);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      realpathSync(this.opts.rootDir) !== this.rootRealPath ||
      `${info.dev}:${info.ino}` !== this.rootIdentity
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
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
        throw new Error(`invalid room file: ${path}`);
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
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, target);
      syncRoomDirectory(this.roomDir(id));
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
    const created = !existsSync(target);
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
      fsyncSync(fd);
      if (created) syncRoomDirectory(this.roomDir(id));
    } catch (error) {
      this.failedWrites.add(id);
      throw error;
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
    return this.createRoomWithId(this.mintRoomId(), input);
  }

  private mintRoomId(): string {
    return `room_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private createRoomWithId(id: string, input: Parameters<RoomManager["createRoom"]>[0]): RoomMeta {
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
    if (!isValidRoomId(id) || existsSync(this.roomDir(id))) throw new RoomStateChangedError();
    const meta: RoomMeta = {
      id,
      name: input.name ?? defaultRoomName(input.cwd),
      cwd: input.cwd,
      kind: input.kind ?? "claude-code",
      permissionMode: input.permissionMode ?? "default",
      createdAt: this.now(),
      lastActiveAt: this.now(),
      claudeSessionId: input.claudeSessionId,
      linkedSessionMode: input.linkedSessionMode,
    };
    mkdirSync(this.roomDir(id), { recursive: true, mode: 0o700 });
    syncRoomDirectory(this.opts.rootDir);
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
    if (this.failedWrites.has(id))
      throw new Error("room persistence failed; reopen after inspecting its history");
    const cached = this.lastSeqByRoom.get(id);
    if (cached !== undefined) {
      if (this.messageStampByRoom.get(id) !== this.messageStamp(id)) {
        this.failedWrites.add(id);
        throw new Error("room history changed outside this writer; inspect it before reopening");
      }
      const next = cached + 1;
      this.lastSeqByRoom.set(id, next);
      return next;
    }
    const path = this.msgPath(id);
    const next = existsSync(path) ? scanRoomHistory(path, parseRoomMessage) + 1 : 1;
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
      const stamp = this.messageStamp(id);
      this.messageStampByRoom.set(id, stamp);
      const receipts = this.inputReceipts.get(id);
      if (receipts) {
        receipts.stamp = stamp;
        if (msg.clientMessageId && msg.clientDeviceId && msg.clientIntentHash)
          receipts.intents.set(
            JSON.stringify([msg.clientDeviceId, msg.clientMessageId]),
            msg.clientIntentHash,
          );
      }
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

  getHistoryPage(id: string, request: RoomHistoryRequest = {}): RoomHistoryPage<RoomMessage> {
    if (!this.getRoom(id)) throw new Error("room is missing or its metadata is corrupt");
    return readRoomHistoryPage(this.roomDir(id), id, request, parseRoomMessage);
  }

  latestSeq(id: string): number {
    if (this.failedWrites.has(id)) throw new Error("room persistence failed");
    const cached = this.lastSeqByRoom.get(id);
    if (cached !== undefined) return cached;
    const path = this.msgPath(id);
    return existsSync(path) ? scanRoomHistory(path, parseRoomMessage) : 0;
  }

  hasTranscriptHistory(id: string): boolean {
    let found = false;
    const file = this.msgPath(id);
    if (existsSync(file))
      scanRoomHistory(file, parseRoomMessage, (message) => {
        if (message.transcriptSource) found = true;
      });
    return found;
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
    if (!messages.length) return;
    if (!this.transcriptFollowedRooms.has(id) || !this.getRoom(id))
      throw new Error("transcript room is not active");
    let sources = this.transcriptSources.get(id);
    if (!sources) {
      sources = new Set<string>();
      const path = this.msgPath(id);
      if (existsSync(path))
        scanRoomHistory(path, parseRoomMessage, (message) => {
          if (message.transcriptSource) sources!.add(message.transcriptSource);
        });
      this.transcriptSources.set(id, sources);
    }
    for (const message of messages) {
      const source = message.transcriptSource;
      if (
        source !== undefined &&
        (typeof source !== "string" ||
          source.length > 200 ||
          !/^[0-9a-f-]{36}:[0-9]+:[0-9]+$/.test(source))
      )
        throw new Error("invalid transcript source coordinate");
      if (source && sources.has(source)) continue;
      if (message.from === "user" && typeof message.text === "string") {
        const text = stripRoomAttachmentBlock(message.text);
        const pending = this.pendingTranscriptUserEchoes.get(id);
        const cutoff = this.now() - 60_000;
        while (pending?.length && pending[0]!.ts < cutoff) pending.shift();
        const matched = pending?.[0]?.text === text;
        if (matched) pending!.shift();
        if (pending?.length === 0) this.pendingTranscriptUserEchoes.delete(id);
        if (!matched) this.append(id, { ...message, text });
        else if (source)
          this.append(id, { from: "system", type: "transcript_echo", transcriptSource: source });
      } else {
        this.append(id, message);
      }
      if (source) sources.add(source);
    }
  }

  /** Monotonic per-room state revision; see `revisions`. */
  roomRevision(id: string): number {
    return this.revisions.get(id) ?? 0;
  }

  private bumpRevision(id: string): void {
    this.revisions.set(id, this.roomRevision(id) + 1);
  }

  /** The room bound to an external session. Reuse must match BOTH id and kind:
   * a codex thread id and a claude session id share the `claudeSessionId`
   * field, so a bare id match could hand back the other CLI's room. */
  findSessionRoom(sessionId: string, kind: RoomKind): RoomMeta | undefined {
    if (!sessionId) return undefined;
    return this.listRooms().find((r) => r.claudeSessionId === sessionId && r.kind === kind);
  }

  /** Spawn-time mode of the room's live process, if one is running. */
  liveMode(id: string): RoomPermissionMode | undefined {
    const agent = this.agents.get(id);
    return agent ? this.agentModes.get(agent) : undefined;
  }

  /**
   * Why the room cannot change its process now. A mode change stops the
   * process, so it must not interrupt queued/active turns, a pending tool
   * approval or AskUserQuestion, or a decision that already left the approval
   * bridge but has not been consumed here yet (its entry stays in the pending
   * maps until respondApproval consumes it).
   */
  roomBusyReason(id: string): RoomBusyReason | undefined {
    if (this.transitions.has(id)) return "switching";
    if (this.deferredEmitRooms.has(id)) return "turn";
    const agent = this.agents.get(id);
    if (agent && (agent.isBusy ? agent.isBusy() : (this.turnCounts.get(id) ?? 0) > 0))
      return "turn";
    const prefix = `${id}:`;
    for (const key of this.pendingAskUser.keys()) if (key.startsWith(prefix)) return "approval";
    for (const key of this.pendingApprovalInputs.keys())
      if (key.startsWith(prefix)) return "approval";
    return undefined;
  }

  /**
   * Plan opening an external session's room under `mode` without changing
   * anything. Throws for a cwd that differs from the room's bound directory,
   * an occupied external session, or a busy room whose mode would change.
   */
  planSessionOpen(input: {
    sessionId: string;
    cwd: string;
    kind: RoomKind;
    mode: RoomPermissionMode;
  }): RoomSessionOpenPlan {
    const { sessionId, kind, mode } = input;
    if (typeof sessionId !== "string" || !sessionId) throw new Error("CLI session id is required");
    this.opts.assertExternalSessionAvailable?.(sessionId, kind);
    const cwd = canonicalDirectory(input.cwd);
    const existing = this.findSessionRoom(sessionId, kind);
    if (!existing) {
      return {
        roomId: this.mintRoomId(),
        created: true,
        sessionId,
        cwd,
        kind,
        toMode: mode,
        change: true,
        live: false,
        observing: false,
        revision: 0,
      };
    }
    // The approval and the process must name the same directory.
    if (canonicalDirectory(existing.cwd) !== cwd)
      throw new Error("该 CLI 会话已绑定到另一个目录，不能在当前目录打开。");
    const liveMode = this.liveMode(existing.id);
    const observing = existing.linkedSessionMode === "observe-only";
    const change =
      !observing &&
      (existing.permissionMode !== mode || (liveMode !== undefined && liveMode !== mode));
    if (this.transitions.has(existing.id)) throw new RoomBusyError("switching");
    // Refused before any Host approval is asked for. settleSessionRoom()
    // re-probes the retired process, so a later attempt succeeds once it exits.
    if (!observing && this.retiring.has(existing.id)) throw new RoomBusyError("retiring");
    if (change) {
      const busy = this.roomBusyReason(existing.id);
      if (busy) throw new RoomBusyError(busy);
    }
    return {
      roomId: existing.id,
      created: false,
      sessionId,
      cwd,
      kind,
      fromMode: liveMode ?? existing.permissionMode,
      toMode: mode,
      change,
      live: liveMode !== undefined,
      observing,
      revision: this.roomRevision(existing.id),
    };
  }

  /**
   * Apply a plan from planSessionOpen. `authorize` runs before anything is
   * changed and again right before the replacement process is created; a
   * throw leaves metadata untouched (or restores it) and never starts a CLI.
   * `revalidate` re-checks asynchronous Host facts after every wait for a
   * retired process, before that final `authorize`, while the room's handoff
   * is still owned by this call.
   */
  async applySessionOpen(
    plan: RoomSessionOpenPlan,
    options: { authorize?: () => void; revalidate?: () => Promise<void> } = {},
  ): Promise<RoomSessionOpenResult> {
    const authorize = (): void => options.authorize?.();
    if (plan.created) {
      if (this.findSessionRoom(plan.sessionId, plan.kind) || this.getRoom(plan.roomId))
        throw new RoomStateChangedError();
      authorize();
      this.opts.assertExternalSessionAvailable?.(plan.sessionId, plan.kind);
      this.createRoomWithId(plan.roomId, {
        cwd: plan.cwd,
        kind: plan.kind,
        permissionMode: plan.toMode,
        claudeSessionId: plan.sessionId,
      });
      this.bumpRevision(plan.roomId);
      try {
        const status = await this.startAgent(plan.roomId);
        return { roomId: plan.roomId, status, mode: plan.toMode, changed: true };
      } catch (error) {
        // The room now exists but nothing runs in it; every view must see that.
        this.notifyRoomState(plan.roomId);
        throw error;
      }
    }
    // Plans are checked against the retired-process fence again after it had a
    // chance to be proven gone; an unproven process still refuses the start.
    // No await (and so no gap) unless a retired process is actually fenced.
    if (this.transitions.has(plan.roomId)) throw new RoomBusyError("switching");
    if (this.retiring.has(plan.roomId)) {
      if (!(await this.settleRetiring(plan.roomId))) throw new RoomBusyError("retiring");
      await options.revalidate?.();
    }
    const meta = this.getRoom(plan.roomId);
    if (
      !meta ||
      meta.claudeSessionId !== plan.sessionId ||
      meta.kind !== plan.kind ||
      canonicalDirectory(meta.cwd) !== plan.cwd ||
      this.roomRevision(plan.roomId) !== plan.revision
    )
      throw new RoomStateChangedError();
    if (plan.observing) {
      authorize();
      return {
        roomId: plan.roomId,
        status: "observing",
        mode: meta.permissionMode,
        changed: false,
      };
    }
    if (!plan.change) {
      if (this.transitions.has(plan.roomId)) throw new RoomBusyError("switching");
      authorize();
      // Reuses a live process untouched; starts a dormant one in its own mode.
      const status = await this.startAgent(plan.roomId);
      return { roomId: plan.roomId, status, mode: meta.permissionMode, changed: false };
    }
    const status = await this.transitionRoom(plan.roomId, {
      toMode: plan.toMode,
      expectedMode: meta.permissionMode,
      authorize,
      ...(options.revalidate ? { revalidate: options.revalidate } : {}),
    });
    return { roomId: plan.roomId, status, mode: plan.toMode, changed: true };
  }

  /**
   * Open (or create) the room bound to an external session id, deduping by
   * that id so a given session maps to exactly one room. A different mode is
   * applied by a guarded process handoff. Hosts that must authorize a mode
   * use planSessionOpen/applySessionOpen directly.
   */
  async openForSession(
    claudeSessionId: string,
    cwd: string,
    mode: RoomPermissionMode,
    kind: RoomKind = "claude-code",
  ): Promise<{ roomId: string; status: RoomOpenStatus; mode: RoomPermissionMode }> {
    // Inline (not settleSessionRoom) so an unfenced room adds no await gap.
    const existing = this.findSessionRoom(claudeSessionId, kind);
    if (existing && this.retiring.has(existing.id) && !this.transitions.has(existing.id))
      await this.settleRetiring(existing.id);
    const plan = this.planSessionOpen({ sessionId: claudeSessionId, cwd, kind, mode });
    const result = await this.applySessionOpen(plan);
    return { roomId: result.roomId, status: result.status, mode: result.mode };
  }

  /**
   * Re-probe a retired process of the session's room (see `retiring`), so a
   * plan made right afterwards is refused only while that process is really
   * still alive. Never starts anything.
   */
  async settleSessionRoom(sessionId: string, kind: RoomKind): Promise<void> {
    const room = this.findSessionRoom(sessionId, kind);
    // A handoff in progress owns its retired process; the plan reports it busy.
    if (room && this.retiring.has(room.id) && !this.transitions.has(room.id))
      await this.settleRetiring(room.id);
  }

  /** Resolves true once no retired process of the room can still be alive. */
  private settleRetiring(id: string): Promise<boolean> {
    const agent = this.retiring.get(id);
    if (!agent) return Promise.resolve(true);
    const inFlight = this.retiringProbes.get(id);
    if (inFlight) return inFlight;
    const probe: Promise<boolean> = this.probeRetired(id, agent).finally(() => {
      if (this.retiringProbes.get(id) === probe) this.retiringProbes.delete(id);
    });
    this.retiringProbes.set(id, probe);
    return probe;
  }

  private async probeRetired(id: string, agent: RoomAgent): Promise<boolean> {
    let exited: boolean;
    try {
      if (agent.stopAndWait) {
        exited = await agent.stopAndWait(this.opts.processExitTimeoutMs ?? 5_000);
      } else {
        agent.stop();
        exited = true;
      }
    } catch {
      exited = false;
    }
    if (exited && this.retiring.get(id) === agent) {
      this.retiring.delete(id);
      // The shared probe owns publication, so concurrent waiters notify once.
      if (!this.transitions.has(id)) this.notifyRoomState(id);
    }
    return !this.retiring.has(id);
  }

  /** Synchronous entry points cannot wait: refuse, and re-probe in the
   * background so the next attempt succeeds once the process is gone. */
  private assertNotRetiring(id: string): void {
    if (!this.retiring.has(id)) return;
    this.watchRetired(id);
    throw new RoomBusyError("retiring");
  }

  /** Request an exit probe; the shared probe publishes a proven exit once.
   * A handoff that still owns the room reports its own outcome. */
  private watchRetired(id: string): void {
    void this.settleRetiring(id);
  }

  private notifyRoomState(id: string): void {
    try {
      this.opts.onRoomStateChanged?.(id);
    } catch {
      // A Host broadcast failure must not change the room's outcome.
    }
  }

  /**
   * Replace a room's process with one in `toMode`. permissionMode is a
   * spawn-time CLI argument (`--permission-mode` / codex sandbox flags), so a
   * live process cannot change it. Order matters:
   *  1. refuse a busy room, before touching anything;
   *  2. detach the old process, so its late output/exit belongs to nobody, and
   *     wait (bounded) until it has really exited — never two writers;
   *  3. re-authorize, then persist the mode and start the replacement;
   *  4. on any failure restore the previous mode. The old process is already
   *     gone at that point, so the room reports not running instead of
   *     pretending the old state came back, and every view is told so.
   * The detached process stays in `retiring` until its exit is proven: a
   * timeout, close() or cancellation ends this operation but not the fence.
   * Transcript followers are not ended: the external session continues.
   */
  private async transitionRoom(
    id: string,
    input: {
      toMode: RoomPermissionMode;
      expectedMode: RoomPermissionMode;
      authorize: () => void;
      /** Async Host re-checks after the old process exited (token held). */
      revalidate?: () => Promise<void>;
      patch?: Partial<Pick<RoomMeta, "cwd" | "linkedSessionMode">>;
    },
  ): Promise<RoomOpenStatus> {
    const busy = this.roomBusyReason(id);
    if (busy) throw new RoomBusyError(busy);
    if (this.retiring.has(id)) throw new RoomBusyError("retiring");
    // A background task writing this external session refuses the switch
    // before the live process is touched, not after it has been stopped.
    const before = this.getRoom(id);
    if (before?.claudeSessionId)
      this.opts.assertExternalSessionAvailable?.(before.claudeSessionId, before.kind);
    input.authorize();
    const token = Symbol(id);
    this.transitions.set(id, token);
    this.bumpRevision(id);
    let snapshot: RoomMeta | undefined;
    let metadataWritten = false;
    /** False only while the detached process may still be alive. */
    let oldProcessGone = true;
    let failed = false;
    try {
      const agent = this.agents.get(id);
      if (agent) {
        // Fence first: from here until its exit is proven nothing may start.
        this.retiring.set(id, agent);
        oldProcessGone = false;
        this.agents.delete(id);
        this.turnCounts.delete(id);
        this.modelTraces.get(id)?.finish("cancelled");
        this.modelTraces.delete(id);
        this.pendingTranscriptUserEchoes.delete(id);
        oldProcessGone = await this.settleRetiring(id);
        if (!oldProcessGone)
          throw new Error(
            "旧 CLI 进程未能在时限内退出；为避免两个进程同时写入同一会话，没有启动新模式。",
          );
        // Facts proven before the wait may have changed during it. The token
        // still owns the room, so nothing else can start while this awaits.
        if (this.transitions.get(id) === token) await input.revalidate?.();
      }
      if (this.transitions.get(id) !== token)
        throw new RoomStateChangedError("CLI 会话已被关闭，权限模式切换已取消。");
      // The requester and its grant are re-checked right before the
      // replacement exists; a cancellation leaves the room really stopped.
      input.authorize();
      snapshot = this.getRoom(id);
      if (!snapshot || snapshot.permissionMode !== input.expectedMode)
        throw new RoomStateChangedError();
      this.writeRoomMeta(id, { ...snapshot, ...input.patch, permissionMode: input.toMode });
      metadataWritten = true;
      const status = await this.startAgent(id, token);
      if (status !== "running") throw new Error("新模式的 CLI 进程未能启动。");
      return status;
    } catch (error) {
      // A process that may still be alive is not reported as stopped; the
      // fence is re-probed and the room republished once it is proven gone.
      if (!oldProcessGone) this.watchRetired(id);
      if (metadataWritten && snapshot) {
        try {
          const current = this.getRoom(id);
          if (current)
            this.writeRoomMeta(id, {
              ...current,
              cwd: snapshot.cwd,
              permissionMode: snapshot.permissionMode,
              linkedSessionMode: snapshot.linkedSessionMode,
            });
        } catch {
          // Surface the original failure; the room reports not running.
        }
      }
      failed = true;
      throw error;
    } finally {
      if (this.transitions.get(id) === token) this.transitions.delete(id);
      this.bumpRevision(id);
      // Only the requester receives the error; every other phone and Desktop
      // window learns the room's real (stopped, restored-mode) state here.
      if (failed && oldProcessGone) this.notifyRoomState(id);
    }
  }

  /** Start (or reuse) the room's agent and wait until a spawned process exists. */
  private async startAgent(id: string, transition?: symbol): Promise<RoomOpenStatus> {
    if (transition !== undefined && this.transitions.get(id) !== transition)
      throw new RoomStateChangedError("CLI 会话已被关闭，权限模式切换已取消。");
    if (transition === undefined && this.transitions.has(id))
      throw new RoomBusyError("switching");
    const { status } = this.openAgent(id);
    if (status !== "running") return status;
    const agent = this.agents.get(id);
    if (!agent?.whenStarted) return status;
    try {
      await agent.whenStarted();
    } catch (error) {
      if (this.agents.get(id) === agent) {
        this.agents.delete(id);
        this.turnCounts.delete(id);
        try {
          agent.stop();
        } catch {
          // Preserve the spawn error.
        }
        this.bumpRevision(id);
      }
      throw new Error(
        `CLI 进程启动失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return this.agents.get(id) === agent && agent.isRunning() ? "running" : "missing";
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
  async takeOverLinkedSession(
    roomId: string,
    externalSessionId: string,
    cwd: string,
    kind: RoomKind,
  ): Promise<{
    roomId: string;
    status: "running";
    mode: RoomPermissionMode;
    cwd: string;
  }> {
    const target = this.requireLinkedSessionTarget({ externalSessionId, cwd, kind });
    this.opts.assertExternalSessionAvailable?.(target.externalSessionId, target.kind);
    if (this.transitions.has(roomId)) throw new RoomBusyError("switching");
    if (this.retiring.has(roomId) && !(await this.settleRetiring(roomId)))
      throw new RoomBusyError("retiring");
    const meta = this.getRoom(roomId);
    if (
      !meta ||
      meta.claudeSessionId !== target.externalSessionId ||
      meta.kind !== target.kind ||
      resolve(meta.cwd) !== target.cwd
    ) {
      throw new Error("linked session does not match the requested room");
    }
    if (this.transitions.has(roomId)) throw new RoomBusyError("switching");
    // Observe-only navigation never asks the user to approve a stored
    // permission mode. A prior bypassPermissions value must not be inherited
    // silently when takeover starts a new process.
    const patch = { cwd: target.cwd, linkedSessionMode: undefined };
    const liveMode = this.liveMode(roomId);
    let status: RoomOpenStatus;
    if (liveMode !== undefined && liveMode !== "default") {
      // Another view runs this session under a different mode. Replace that
      // process only when it is idle, and only after it has exited.
      status = await this.transitionRoom(roomId, {
        toMode: "default",
        expectedMode: meta.permissionMode,
        authorize: () => undefined,
        patch,
      });
    } else {
      this.writeRoomMeta(roomId, { ...meta, ...patch, permissionMode: "default" });
      this.bumpRevision(roomId);
      status = await this.startAgent(roomId);
    }
    if (status !== "running") {
      throw new Error("linked session room is unavailable");
    }
    return { roomId, status, mode: "default", cwd: target.cwd };
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
    if (!resolvedTarget) {
      throw new Error("linked session transcript was not found for the requested session");
    }
    if (
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
      | {
          behavior: "allow";
          updatedInput?: unknown;
          answer?: string;
          answers?: Record<string, string>;
        }
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

    // A control response consumes exactly one server-observed request. The
    // bridge can settle multiple waiters when a duplicate control ID arrives;
    // only the first settlement may reach the resident process. This also
    // rejects unsolicited and late replies after a room has been closed.
    if (!hasPendingAsk && !hasOriginalInput) return false;

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
      // `answers` (keyed by question text) answers every question of a
      // multi-question request; the legacy single `answer` maps to the first.
      const prompt = askUserPrompt(pending);
      const answersByQuestion =
        decision.answers ?? (prompt ? { [prompt.question]: decision.answer ?? "" } : {});
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
    // A mode handoff owns the room until its replacement process exists.
    if (this.transitions.has(id)) throw new RoomBusyError("switching");
    return this.openAgent(id);
  }

  private openAgent(id: string): { status: RoomOpenStatus } {
    const meta = this.getRoom(id);
    if (!meta) return { status: "missing" };
    if (meta.linkedSessionMode === "observe-only") return { status: "observing" };
    if (!this.agents.has(id)) {
      // Every start path ends here: no second writer while a detached
      // process of this room may still be alive.
      this.assertNotRetiring(id);
      if (meta.claudeSessionId)
        this.opts.assertExternalSessionAvailable?.(meta.claudeSessionId, meta.kind);
      // Host policy, e.g. a stored bypassPermissions needs a live Host grant.
      this.opts.authorizeStart?.(meta);
      let agent: RoomAgent | undefined = undefined;
      agent = this.opts.createAgent(meta, (event) => {
        // stop() sends a signal; an old process can still drain output or emit
        // exit after the room has reopened. Only the current process owns its
        // transcript, pending approvals, and terminal lifecycle transition.
        if (agent && this.agents.get(id) === agent) this.onAgentEvent(id, event);
      });
      this.agents.set(id, agent);
      this.agentModes.set(agent, meta.permissionMode);
      this.turnCounts.delete(id);
      this.bumpRevision(id);
      try {
        agent.start();
      } catch (error) {
        if (this.agents.get(id) === agent) this.agents.delete(id);
        this.bumpRevision(id);
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
    // Turn accounting must see every event, including the turn_end that the
    // transcript-follow filter below hides from the stdout mirror.
    if (event.type === "turn_end") {
      const remaining = (this.turnCounts.get(id) ?? 0) - 1;
      if (remaining > 0) this.turnCounts.set(id, remaining);
      else this.turnCounts.delete(id);
    } else if (event.type === "exit") {
      this.turnCounts.delete(id);
      this.bumpRevision(id);
    }
    const trace = this.modelTraces.get(id);
    trace?.observe(event);
    if (trace?.ended) this.modelTraces.delete(id);
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
          const prompt = askUserPrompt(event.input);
          if (prompt) {
            const questions = askUserQuestions(event.input);
            const askUser = questions.length > 1 ? { ...prompt, questions } : prompt;
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

  /** Prepare cold receipts outside the synchronous send path; concurrent intents share one scan. */
  async prepareInputReceipts(id: string): Promise<void> {
    if (this.inputReceipts.has(id)) {
      this.currentInputReceipts(id);
      return;
    }
    const pending = this.preparingInputReceipts.get(id);
    if (pending) return pending;
    const work = this.buildInputReceipts(id).finally(() => {
      if (this.preparingInputReceipts.get(id) === work) this.preparingInputReceipts.delete(id);
    });
    this.preparingInputReceipts.set(id, work);
    return work;
  }

  private async buildInputReceipts(id: string): Promise<void> {
    if (this.failedWrites.has(id)) throw new Error("room persistence failed");
    const path = this.msgPath(id);
    const intents = new Map<string, string>();
    const proof = existsSync(path)
      ? await scanRoomHistoryAsync(path, parseRoomMessage, (message) => {
          if (!message.clientMessageId) return;
          if (!message.clientDeviceId || !message.clientIntentHash)
            throw new Error("room input receipt is incomplete");
          const key = JSON.stringify([message.clientDeviceId, message.clientMessageId]);
          const previous = intents.get(key);
          if (previous && previous !== message.clientIntentHash)
            throw new Error("conflicting room input receipts");
          intents.set(key, message.clientIntentHash);
        })
      : { sequence: 0, stamp: "" };
    if ((existsSync(path) ? this.messageStamp(id) : "") !== proof.stamp)
      throw new Error("room input history changed; reload before retrying");
    this.inputReceipts.set(id, { stamp: proof.stamp, intents });
    // Avoid a second synchronous history scan when the cold Room first appends.
    if (proof.stamp && !this.lastSeqByRoom.has(id)) {
      this.lastSeqByRoom.set(id, proof.sequence);
      this.messageStampByRoom.set(id, proof.stamp);
    }
  }

  private currentInputReceipts(id: string) {
    const cached = this.inputReceipts.get(id);
    if (!cached) throw new Error("room input receipts must be prepared before send");
    const path = this.msgPath(id);
    if (cached.stamp !== (existsSync(path) ? this.messageStamp(id) : ""))
      throw new Error("room input history changed; reload before retrying");
    return cached;
  }

  /** A replay never opens a new CLI, reclaims an attachment, or reuses a changed intent. */
  hasAcceptedInput(id: string, receipt: RoomInputReceipt): boolean {
    if (
      !receipt.clientMessageId ||
      receipt.clientMessageId.length > 200 ||
      !receipt.clientDeviceId ||
      receipt.clientDeviceId.length > 256 ||
      !/^[a-f0-9]{64}$/.test(receipt.clientIntentHash)
    )
      throw new Error("invalid room input receipt");
    if (this.failedWrites.has(id)) throw new Error("room persistence failed");
    const cached = this.currentInputReceipts(id);
    const known = cached.intents.get(
      JSON.stringify([receipt.clientDeviceId, receipt.clientMessageId]),
    );
    if (known && known !== receipt.clientIntentHash)
      throw new Error("同一输入的内容已改变，请核对草稿后作为新消息发送。");
    return known !== undefined;
  }

  /** Post a user message: persist it, ensure agent running, feed it. */
  send(
    id: string,
    text: string,
    attachments: InputAttachmentMeta[] = [],
    receipt?: RoomInputReceipt,
  ): boolean {
    const meta = this.getRoom(id);
    if (!meta) return false;
    if (receipt && this.hasAcceptedInput(id, receipt)) return true;
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
    // Counted before the buffered events replay, so a synchronous turn_end
    // settles exactly this input.
    if (this.agents.get(id) === agent)
      this.turnCounts.set(id, (this.turnCounts.get(id) ?? 0) + 1);

    if (this.opts.modelTracing) {
      try {
        let trace = this.modelTraces.get(id);
        if (!trace || trace.ended) {
          trace = createRoomModelTrace({
            storageDir: this.opts.modelTracing.storageDir,
            workspacePath: meta.cwd,
            roomId: id,
            kind: meta.kind ?? "claude",
            parameters: this.opts.modelTracing.parameters?.(meta),
          });
          this.modelTraces.set(id, trace);
        }
        trace.submit(agentText);
      } catch {
        // Observability cannot change an already accepted external submission.
      }
    }

    this.append(id, {
      from: "user",
      type: "text",
      text: displayText,
      ...(receipt ?? {}),
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
    // An explicit close cancels a pending mode handoff: the handoff checks its
    // token before starting the replacement, so it can never reopen the room.
    // The retired-process fence is deliberately kept: until the old process is
    // proven gone, an immediate reopen or send is refused, not double-started.
    this.transitions.delete(id);
    this.bumpRevision(id);
    // A room going quiet must record its REAL last activity, not the last
    // throttled write.
    this.flushLastActive(id);
    const agent = this.agents.get(id);
    this.modelTraces.get(id)?.finish("cancelled");
    this.modelTraces.delete(id);
    // stop() only signals: the process can outlive it by the SIGTERM grace
    // period. Fence the room before signalling so an immediate send/open/
    // reopen cannot start a second writer on the same external session. An
    // agent without stopAndWait() has no exit to wait for (stop() is its exit).
    const fenced = !!agent?.stopAndWait && !this.retiring.has(id);
    if (fenced) this.retiring.set(id, agent!);
    try {
      agent?.stop();
    } finally {
      if (!agent || this.agents.get(id) === agent) this.agents.delete(id);
      this.turnCounts.delete(id);
      this.clearPendingApprovals(id);
      this.pendingTranscriptUserEchoes.delete(id);
      this.deferredEmitRooms.delete(id);
      this.deferredEmits.delete(id);
      this.opts.onRoomEnded?.(id);
      try {
        this.opts.onRoomClosed?.(id);
      } catch {
        // A Host bookkeeping failure must not keep the process alive.
      }
      // Prove the exit in the background; the room is republished once it is
      // gone. Until then isOpen() stays true and every start is refused.
      if (fenced) this.watchRetired(id);
    }
  }

  closeAll(): void {
    const ids = new Set([...this.agents.keys(), ...this.transcriptFollowedRooms]);
    let firstError: unknown;
    for (const trace of this.modelTraces.values()) trace.finish("cancelled");
    this.modelTraces.clear();
    for (const agent of this.agents.values()) {
      try {
        agent.stop();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.agents.clear();
    this.transitions.clear();
    this.turnCounts.clear();
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

  /** True while the room's process runs, or a retired one is not yet proven
   * gone (a view must not be told the room stopped while it may still write). */
  isOpen(id: string): boolean {
    return (this.agents.get(id)?.isRunning() ?? false) || this.retiring.has(id);
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
      if (this.isOpen(meta.id) || this.transitions.has(meta.id)) continue; // never reap a live session
      rmSync(this.roomDir(meta.id), { recursive: true, force: true });
      this.agents.delete(meta.id);
      // Drop the cached seq with the files, so a room id that somehow comes back
      // re-derives its counter from disk instead of continuing a dead sequence.
      this.lastSeqByRoom.delete(meta.id);
      this.inputReceipts.delete(meta.id);
      removed.push(meta.id);
    }
    return removed;
  }
}
