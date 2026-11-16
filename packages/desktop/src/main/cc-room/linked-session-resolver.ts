import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { encodeCwd, findCodexRolloutFile } from "@cjhyy/code-shell-capability-coding/orchestration";
import type { LinkedSessionTarget, RoomKind } from "@cjhyy/code-shell-server/mobile-remote";

const MAX_CLAUDE_IDENTITY_BYTES = 256 * 1024;
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

  // Claude opens transcripts with records that carry no cwd (mode,
  // last-prompt, permission-mode, queue-operation, file-history-snapshot) and
  // SessionStart hook attachments that can run to several KB. The identity is
  // the first complete record that has a cwd; one cut off by the bound fails
  // closed instead of being pattern-matched.
  const record = firstRecordWithCwd(prefix, MAX_CLAUDE_IDENTITY_BYTES);
  if (!record) return null;
  const { cwd, sessionId } = record;
  if (
    typeof cwd !== "string" ||
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
  // The shared finder checks authoritative metadata after narrowing modern
  // UUID-named rollouts; opening one task must not read every session's prefix.
  return findCodexRolloutFile(codexHome, requestedCwd, externalSessionId)
    ? { externalSessionId, cwd: requestedCwd }
    : null;
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

function firstRecordWithCwd(
  prefix: string,
  maximum: number,
): { cwd: unknown; sessionId: unknown } | null {
  const lines = prefix.split("\n");
  // Without a trailing newline the last line is complete only at EOF.
  if (Buffer.byteLength(prefix, "utf-8") >= maximum) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const { cwd, sessionId } = record as { cwd?: unknown; sessionId?: unknown };
    if (cwd !== undefined) return { cwd, sessionId };
  }
  return null;
}
