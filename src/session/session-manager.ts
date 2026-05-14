/**
 * Session lifecycle manager.
 */

import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { nanoid } from "nanoid";
import type { SessionState } from "../types.js";
import { Transcript } from "./transcript.js";
import { SessionError } from "../exceptions.js";

export interface SessionBundle {
  state: SessionState;
  transcript: Transcript;
}

export class SessionManager {
  private readonly sessionsDir: string;

  constructor(storageDir?: string) {
    this.sessionsDir = storageDir ?? join(homedir(), ".code-shell", "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  create(cwd: string, model: string, provider: string): SessionBundle {
    const sessionId = nanoid(16);
    const sessionDir = join(this.sessionsDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const state: SessionState = {
      sessionId,
      cwd,
      startedAt: Date.now(),
      model,
      provider,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      turnCount: 0,
      invokedSkills: [],
      status: "active",
    };

    writeFileSync(join(sessionDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");

    const transcript = new Transcript(join(sessionDir, "transcript.jsonl"));
    transcript.append("session_meta", {
      sessionId,
      cwd,
      model,
      provider,
      startedAt: state.startedAt,
    });

    return { state, transcript };
  }

  resume(sessionId: string): SessionBundle {
    const sessionDir = join(this.sessionsDir, sessionId);
    if (!existsSync(sessionDir)) {
      throw new SessionError(`Session not found: ${sessionId}`);
    }

    const stateFile = join(sessionDir, "state.json");
    if (!existsSync(stateFile)) {
      throw new SessionError(`Session state file not found: ${sessionId}`);
    }

    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
    const transcriptFile = join(sessionDir, "transcript.jsonl");
    const transcript = Transcript.loadFromFile(transcriptFile);

    state.status = "active";

    return { state, transcript };
  }

  saveState(state: SessionState): void {
    const sessionDir = join(this.sessionsDir, state.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    // Atomic write: stage to .tmp, then rename. Protects against two processes
    // clobbering each other's state.json mid-write.
    const target = join(sessionDir, "state.json");
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, target);
  }

  /**
   * Fork a session from a specific point.
   * Creates a new session that shares events up to the given turn,
   * then diverges independently.
   */
  fork(sourceSessionId: string, forkAtTurn?: number): SessionBundle {
    const source = this.resume(sourceSessionId);
    const events = source.transcript.getEvents();

    // Determine fork point
    const forkTurn = forkAtTurn ?? source.state.turnCount;

    // Create new session
    const newBundle = this.create(
      source.state.cwd,
      source.state.model,
      source.state.provider,
    );
    newBundle.state.parentSessionId = sourceSessionId;

    // Copy events up to the fork point
    for (const event of events) {
      if (event.type === "turn_boundary" && (event.data.turnNumber as number) > forkTurn) {
        break;
      }
      newBundle.transcript.append(event.type, event.data);
    }

    this.saveState(newBundle.state);
    return newBundle;
  }

  list(limit = 20): SessionListEntry[] {
    if (!existsSync(this.sessionsDir)) return [];

    const dirs = readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const sessions: SessionListEntry[] = [];
    for (const dir of dirs) {
      const stateFile = join(this.sessionsDir, dir, "state.json");
      if (!existsSync(stateFile)) continue;
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf-8")) as SessionState;
        const transcriptFile = join(this.sessionsDir, dir, "transcript.jsonl");
        const preview = readLastUserMessage(transcriptFile);
        const lastActiveAt = existsSync(transcriptFile)
          ? statSync(transcriptFile).mtimeMs
          : state.startedAt;
        sessions.push({ ...state, preview, lastActiveAt });
      } catch {
        // Skip corrupted sessions
      }
    }

    return sessions
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, limit);
  }
}

export type SessionListEntry = SessionState & {
  preview?: string;
  /** Last activity time — transcript mtime, falling back to startedAt. */
  lastActiveAt: number;
};

/**
 * Scan a transcript.jsonl for the LAST user message and return a short
 * preview. Walks the file from the bottom so cost is bounded by how recent
 * the user's last line is, not the total file size.
 *
 * Returns undefined if the session has no user messages yet.
 */
function readLastUserMessage(transcriptFile: string): string | undefined {
  if (!existsSync(transcriptFile)) return undefined;
  const raw = readFileSync(transcriptFile, "utf-8");
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let event: { type?: string; data?: { role?: string; content?: unknown } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "message") continue;
    if (event.data?.role !== "user") continue;
    const content = event.data.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.find((b: { type?: string; text?: string }) => b.type === "text")?.text ?? ""
        : "";
    if (!text.trim()) continue;
    return text.replace(/\s+/g, " ").trim();
  }
  return undefined;
}
