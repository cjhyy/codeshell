import {
  DEFAULT_DISCOVER_LIMIT,
  DEFAULT_DISCOVER_SINCE_MS,
  countRelatedSessions,
  discoverRelatedSessions,
  listRelatedCodexSessions,
  readCodexRecentHistory,
  readRecentHistory,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import type { CliHistory, CliList } from "../../shared/cc-room-reads.js";

/** Full-file scans and JSONL parsing execute on the history worker thread. */
export function externalSessions({ cwd, kind, all }: CliList) {
  const opts = all ? {} : { limit: DEFAULT_DISCOVER_LIMIT, sinceMs: DEFAULT_DISCOVER_SINCE_MS };
  if (kind === "codex") return listRelatedCodexSessions(cwd, opts);
  const sessions = discoverRelatedSessions("claude", cwd, opts);
  return { sessions, total: all ? sessions.length : countRelatedSessions("claude", cwd) };
}
export function externalHistory({ kind, cwd, sessionId, limit, before }: CliHistory) {
  return (kind === "codex" ? readCodexRecentHistory : readRecentHistory)(
    cwd,
    sessionId,
    limit,
    undefined,
    before,
  );
}
