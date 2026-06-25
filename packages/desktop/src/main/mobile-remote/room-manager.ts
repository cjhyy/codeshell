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

export type RoomPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/**
 * Tools whose `can_use_tool` control request is a request for a STRUCTURED host
 * response (not a permission gate). A plain allow/deny can't satisfy them and
 * they emit the request regardless of permission mode, so we auto-allow them
 * rather than show a dead-end approval card. claude then degrades gracefully
 * (e.g. AskUserQuestion asks in-conversation).
 */
const INTERACTIVE_INPUT_TOOLS = new Set(["AskUserQuestion", "Skill"]);

export interface RoomMeta {
  id: string;
  name: string;
  cwd: string;
  kind: "claude-code";
  permissionMode: RoomPermissionMode;
  createdAt: number;
  lastActiveAt: number;
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
  /** Called when a room's resident agent requests tool-use approval. */
  onApprovalRequest?: (
    roomId: string,
    req: { requestId: string; toolName: string; displayName?: string; input: unknown; description?: string },
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
  private now: () => number;

  constructor(private readonly opts: RoomManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    mkdirSync(opts.rootDir, { recursive: true });
  }

  private roomDir(id: string): string {
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
    permissionMode?: RoomPermissionMode;
    claudeSessionId?: string;
  }): RoomMeta {
    const id = `room_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const meta: RoomMeta = {
      id,
      name: input.name ?? input.cwd.split("/").filter(Boolean).pop() ?? "room",
      cwd: input.cwd,
      kind: "claude-code",
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

  getMessages(id: string, sinceSeq = 0): RoomMessage[] {
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
  ): { roomId: string; status: "running" | "missing" } {
    const existing = claudeSessionId
      ? this.listRooms().find((r) => r.claudeSessionId === claudeSessionId)
      : undefined;
    const meta =
      existing ?? this.createRoom({ cwd, permissionMode: mode, claudeSessionId: claudeSessionId || undefined });
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
    decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string },
  ): boolean {
    const agent = this.agents.get(roomId);
    if (!agent?.respondControl) return false;
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
        this.append(id, { from: "agent", type: "tool", tool: event.tool, summary: event.summary });
        break;
      case "tool_result":
        this.append(id, { from: "agent", type: "tool_result", summary: event.summary, isError: event.isError });
        break;
      case "turn_end":
        this.append(id, { from: "agent", type: "turn_end", reason: event.reason });
        break;
      case "error":
        this.append(id, { from: "system", type: "error", text: event.error });
        break;
      case "approval_request":
        // Some tools route through can_use_tool not for permission but to
        // request a structured host response (AskUserQuestion wants the user's
        // choice; Skill its args). A plain allow/deny card can't satisfy those —
        // approving without an answer makes claude report "did not answer". They
        // also emit a control_request even under bypassPermissions. So auto-allow
        // them here (claude then degrades to asking in-conversation) instead of
        // surfacing a dead-end approval card.
        if (INTERACTIVE_INPUT_TOOLS.has(event.toolName)) {
          this.agents.get(id)?.respondControl?.(event.requestId, { behavior: "allow", updatedInput: event.input });
          break;
        }
        this.append(id, { from: "agent", type: "approval", tool: event.toolName, summary: event.description ?? "" });
        this.opts.onApprovalRequest?.(id, event);
        break;
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
