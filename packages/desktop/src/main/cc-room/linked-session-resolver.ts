import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { encodeCwd } from "@cjhyy/code-shell-capability-coding/orchestration";
import type { LinkedSessionTarget, RoomKind } from "@cjhyy/code-shell-server/mobile-remote";

const MAX_CLAUDE_IDENTITY_BYTES = 4 * 1024;
const MAX_CODEX_META_BYTES = 64 * 1024;
const SAFE_EXTERNAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

export interface LinkedSessionResolverOptions {
  claudeHome?: string;
  codexHome?: string;
}

interface SessionIdentity {
  externalSessionId: string;
  cwd: string;
}

/**
 * Resolve an external session from the CLI's authoritative on-disk identity.
 * The resolver deliberately returns no transcript path or contents: callers
 * receive only the canonical kind + id + cwd tuple needed to bind a read-only
 * room. Any missing or ambiguous identity fails closed.
 */
export function resolveLinkedSessionFromDisk(
  target: Readonly<LinkedSessionTarget>,
  options: LinkedSessionResolverOptions = {},
): LinkedSessionTarget | null {
  if (!validTarget(target)) return null;
  const requestedCwd = resolve(target.cwd);
  const identity =
    target.kind === "claude-code"
      ? resolveClaudeIdentity(
          target.externalSessionId,
          requestedCwd,
          options.claudeHome ?? join(homedir(), ".claude"),
        )
      : resolveCodexIdentity(
          target.externalSessionId,
          requestedCwd,
          options.codexHome ?? join(homedir(), ".codex"),
        );
  if (!identity) return null;
  return {
    externalSessionId: identity.externalSessionId,
    cwd: resolve(identity.cwd),
    kind: target.kind,
  };
}

function validTarget(target: Readonly<LinkedSessionTarget>): boolean {
  return (
    SAFE_EXTERNAL_SESSION_ID.test(target.externalSessionId) &&
    typeof target.cwd === "string" &&
    target.cwd.trim() === target.cwd &&
    isAbsolute(target.cwd) &&
    validKind(target.kind)
  );
}

function validKind(kind: unknown): kind is RoomKind {
  return kind === "claude-code" || kind === "codex";
}

function resolveClaudeIdentity(
  externalSessionId: string,
  requestedCwd: string,
  claudeHome: string,
): SessionIdentity | null {
  const file = join(claudeHome, "projects", encodeCwd(requestedCwd), `${externalSessionId}.jsonl`);
  if (!isRegularFile(file)) return null;
  const prefix = readBoundedPrefix(file, MAX_CLAUDE_IDENTITY_BYTES);
  if (prefix === null) return null;

  // Claude writes cwd/sessionId before the potentially large message payload.
  // Do not scan into message content merely to make a stale locator succeed.
  const messageIndex = prefix.indexOf('"message"');
  const identityPrefix = messageIndex >= 0 ? prefix.slice(0, messageIndex) : prefix;
  const cwd = jsonStringField(identityPrefix, "cwd");
  const sessionId = jsonStringField(identityPrefix, "sessionId");
  if (
    cwd === null ||
    sessionId !== externalSessionId ||
    !isAbsolute(cwd) ||
    resolve(cwd) !== requestedCwd
  ) {
    return null;
  }
  return { externalSessionId: sessionId, cwd };
}

function resolveCodexIdentity(
  externalSessionId: string,
  requestedCwd: string,
  codexHome: string,
): SessionIdentity | null {
  const sessionsRoot = join(codexHome, "sessions");
  for (const file of rolloutFiles(sessionsRoot)) {
    const firstLine = readFirstLine(file, MAX_CODEX_META_BYTES);
    if (firstLine === null) continue;
    let record: unknown;
    try {
      record = JSON.parse(firstLine);
    } catch {
      continue;
    }
    const meta = record as { type?: unknown; payload?: { id?: unknown; cwd?: unknown } };
    if (
      meta.type !== "session_meta" ||
      typeof meta.payload?.id !== "string" ||
      typeof meta.payload.cwd !== "string" ||
      meta.payload.id !== externalSessionId ||
      !isAbsolute(meta.payload.cwd) ||
      resolve(meta.payload.cwd) !== requestedCwd
    ) {
      continue;
    }
    return { externalSessionId: meta.payload.id, cwd: meta.payload.cwd };
  }
  return null;
}

function* rolloutFiles(root: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* rolloutFiles(file);
    } else if (
      entry.isFile() &&
      entry.name.startsWith("rollout-") &&
      entry.name.endsWith(".jsonl")
    ) {
      yield file;
    }
  }
}

function isRegularFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readBoundedPrefix(file: string, maximum: number): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(maximum);
    const count = readSync(fd, buffer, 0, maximum, 0);
    return buffer.toString("utf-8", 0, count);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function readFirstLine(file: string, maximum: number): string | null {
  const prefix = readBoundedPrefix(file, maximum);
  if (prefix === null) return null;
  const newline = prefix.indexOf("\n");
  // A full buffer without a line boundary is not a bounded metadata record.
  if (newline < 0 && Buffer.byteLength(prefix, "utf-8") >= maximum) return null;
  return (newline < 0 ? prefix : prefix.slice(0, newline)).trim();
}

function jsonStringField(prefix: string, field: "cwd" | "sessionId"): string | null {
  const marker = `"${field}"`;
  const start = prefix.indexOf(marker);
  if (start < 0) return null;
  const tail = prefix.slice(start + marker.length);
  const match = tail.match(/^\s*:\s*("(?:\\.|[^"\\])*")/u);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as unknown;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
