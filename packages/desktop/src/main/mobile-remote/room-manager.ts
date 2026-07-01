import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type { ResidentAgentEvent } from "./resident-agent.js";

/**
 * The exact shape createRoom() generates: `room_<base36>_<base36>`. Anything
 * else — path separators, `..`, NUL, empty — is rejected before it can reach a
 * filesystem path, closing the room-storage traversal via client-supplied
 * event.roomId.
 */
const ROOM_ID_RE = /^room_[a-z0-9]+_[a-z0-9]+$/;

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
  /** Pending AskUserQuestion control requests, keyed by `${roomId}:${requestId}`.
   *  Holds the raw tool input so respondApproval can bake the user's answer into
   *  the `answers` record the CLI expects. Cleared on response. */
  private pendingAskUser = new Map<string, unknown>();
  private now: () => number;

  constructor(private readonly opts: RoomManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    mkdirSync(opts.rootDir, { recursive: true });
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
    return join(this.opts.rootDir, id);
  }
  private metaPath(id: string): string {
    return join(this.roomDir(id), "room.json");
  }
  private msgPath(id: string): string {
    return join(this.roomDir(id), "messages.jsonl");
  }

  createRoom(input: {
    name?: string;
    cwd: string;
    kind?: RoomKind;
    permissionMode?: RoomPermissionMode;
    claudeSessionId?: string;
  }): RoomMeta {
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
    };
    mkdirSync(this.roomDir(id), { recursive: true });
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2), "utf-8");
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
    for (const entry of readdirSync(this.opts.rootDir)) {
      const p = join(this.opts.rootDir, entry, "room.json");
      if (!existsSync(p)) continue;
      try {
        rooms.push(JSON.parse(readFileSync(p, "utf-8")) as RoomMeta);
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
    const p = this.metaPath(id);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as RoomMeta;
    } catch {
      return undefined;
    }
  }

  private nextSeq(id: string): number {
    const msgs = this.getMessages(id, 0);
    return msgs.length === 0 ? 1 : msgs[msgs.length - 1]!.seq + 1;
  }

  private append(id: string, partial: Omit<RoomMessage, "seq" | "ts">): RoomMessage {
    const ts = this.now();
    const msg: RoomMessage = { seq: this.nextSeq(id), ts, ...partial };
    appendFileSync(this.msgPath(id), JSON.stringify(msg) + "\n", "utf-8");
    // Touch lastActiveAt so idle-based pruning measures real activity, not just
    // creation time — a room chatted with daily should never be reaped.
    this.touchLastActive(id, ts);
    this.opts.onMessage(id, msg);
    return msg;
  }

  private touchLastActive(id: string, ts: number): void {
    const meta = this.getRoom(id);
    if (!meta) return;
    writeFileSync(this.metaPath(id), JSON.stringify({ ...meta, lastActiveAt: ts }, null, 2), "utf-8");
  }

  /** Persist the room's resume id (claude session_id / codex thread_id) so the
   *  next open() can continue the same conversation. No-op if unchanged. */
  setRoomSessionId(id: string, sessionId: string): void {
    const meta = this.getRoom(id);
    if (!meta || meta.claudeSessionId === sessionId) return;
    writeFileSync(this.metaPath(id), JSON.stringify({ ...meta, claudeSessionId: sessionId }, null, 2), "utf-8");
  }

  getMessages(id: string, sinceSeq = 0): RoomMessage[] {
    if (!isValidRoomId(id)) return [];
    const p = this.msgPath(id);
    if (!existsSync(p)) return [];
    const out: RoomMessage[] = [];
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as RoomMessage;
        if (m.seq > sinceSeq) out.push(m);
      } catch {
        /* skip */
      }
    }
    return out;
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
  ): { roomId: string; status: "running" | "missing" } {
    // Reuse must match BOTH id and kind: a codex thread id and a claude session
    // id live in the same `claudeSessionId` field, so a bare id match could
    // otherwise hand back a claude room when a codex room was asked for.
    const existing = claudeSessionId
      ? this.listRooms().find((r) => r.claudeSessionId === claudeSessionId && r.kind === kind)
      : undefined;
    const meta =
      existing ??
      this.createRoom({ cwd, kind, permissionMode: mode, claudeSessionId: claudeSessionId || undefined });
    // permissionMode is a spawn-time CLI arg (--permission-mode), so it can't be
    // changed on a live process. If the caller reopens an existing room under a
    // DIFFERENT mode, persist the new mode and restart the resident agent;
    // otherwise reopening keeps the running process and the picked mode would be
    // silently ignored (the "bypassPermissions still prompts" bug).
    if (existing && existing.permissionMode !== mode) {
      writeFileSync(this.metaPath(meta.id), JSON.stringify({ ...meta, permissionMode: mode }, null, 2), "utf-8");
      this.close(meta.id); // stop the old-mode process so open() respawns fresh
    }
    const { status } = this.open(meta.id);
    return { roomId: meta.id, status };
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
    const agent = this.agents.get(roomId);
    if (!agent?.respondControl) return false;

    // AskUserQuestion: an "allow" carries the user's chosen answer string, which
    // main (the single source of truth) bakes into the `answers` record keyed by
    // question text — the only shape the CLI accepts. The raw input was stashed
    // on approval_request. Deny passes through (claude treats it as "did not
    // answer", same as the desktop CLI's own cancel).
    const askKey = `${roomId}:${requestId}`;
    const pending = this.pendingAskUser.get(askKey);
    if (pending !== undefined) {
      this.pendingAskUser.delete(askKey);
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

    agent.respondControl(requestId, decision);
    return true;
  }

  /** Open a room: start its resident agent if not already running. */
  open(id: string): { status: "running" | "missing" } {
    const meta = this.getRoom(id);
    if (!meta) return { status: "missing" };
    if (!this.agents.has(id)) {
      const agent = this.opts.createAgent(meta, (event) => this.onAgentEvent(id, event));
      this.agents.set(id, agent);
      agent.start();
    }
    return { status: "running" };
  }

  private onAgentEvent(id: string, event: ResidentAgentEvent): void {
    switch (event.type) {
      case "text":
        this.append(id, { from: "agent", type: "text", text: event.text });
        break;
      case "tool":
        this.append(id, { from: "agent", type: "tool", tool: event.tool, summary: event.summary, toolId: event.id, args: event.input });
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
          this.agents.get(id)?.respondControl?.(event.requestId, { behavior: "allow", updatedInput: event.input });
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
            this.append(id, { from: "agent", type: "approval", tool: event.toolName, summary: askUser.question });
            this.opts.onApprovalRequest?.(id, { ...event, askUser });
            break;
          }
          // Malformed AskUser (no questions) → auto-allow so the turn isn't
          // wedged forever waiting on an answer that can't be collected.
          this.agents.get(id)?.respondControl?.(event.requestId, { behavior: "allow", updatedInput: event.input });
          break;
        }
        this.append(id, { from: "agent", type: "approval", tool: event.toolName, summary: event.description ?? "" });
        this.opts.onApprovalRequest?.(id, event);
        break;
      }
      case "exit":
        this.agents.delete(id);
        this.append(id, { from: "system", type: "agent_exit", reason: String(event.code ?? event.signal ?? "") });
        break;
    }
  }

  /** Post a user message: persist it, ensure agent running, feed it. */
  send(id: string, text: string): boolean {
    const meta = this.getRoom(id);
    if (!meta) return false;
    this.open(id);
    this.append(id, { from: "user", type: "text", text });
    return this.agents.get(id)?.send(text) ?? false;
  }

  close(id: string): void {
    this.agents.get(id)?.stop();
    this.agents.delete(id);
  }

  closeAll(): void {
    for (const agent of this.agents.values()) agent.stop();
    this.agents.clear();
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
    const cutoff = this.now() - maxAgeMs;
    const removed: string[] = [];
    for (const meta of this.listRooms()) {
      if (meta.lastActiveAt > cutoff) continue;
      if (this.isOpen(meta.id)) continue; // never reap a live session
      rmSync(this.roomDir(meta.id), { recursive: true, force: true });
      this.agents.delete(meta.id);
      removed.push(meta.id);
    }
    return removed;
  }
}
