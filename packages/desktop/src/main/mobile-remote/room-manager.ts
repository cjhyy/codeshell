import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ResidentAgentEvent } from "./resident-agent.js";

export type RoomPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface RoomMeta {
  id: string;
  name: string;
  cwd: string;
  kind: "claude-code";
  permissionMode: RoomPermissionMode;
  createdAt: number;
  lastActiveAt: number;
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
}

export interface RoomAgentFactory {
  (room: RoomMeta, onEvent: (event: ResidentAgentEvent) => void): RoomAgent;
}

export interface RoomManagerOptions {
  rootDir: string; // <userData>/mobile-remote/rooms
  createAgent: RoomAgentFactory;
  /** Called whenever a room gains a new persisted message (push to phone). */
  onMessage: (roomId: string, msg: RoomMessage) => void;
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
    };
    mkdirSync(this.roomDir(id), { recursive: true });
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2), "utf-8");
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
    const msg: RoomMessage = { seq: this.nextSeq(id), ts: this.now(), ...partial };
    appendFileSync(this.msgPath(id), JSON.stringify(msg) + "\n", "utf-8");
    this.opts.onMessage(id, msg);
    return msg;
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
}
