import type { ParsedRpc } from "./agent-bridge-fallback.js";

export interface PreparedAgentRunMetadata {
  parsed: ParsedRpc;
  outLine: string;
  cwd?: string;
  sessionId?: string;
  bucket?: string;
  browserPartition?: string;
}

export function prepareAgentRunMetadata(
  line: string,
  isProjectTrusted: (cwd: string) => boolean,
): PreparedAgentRunMetadata {
  let parsed: ParsedRpc = {};
  try {
    parsed = JSON.parse(line) as ParsedRpc;
  } catch {
    return { parsed, outLine: line };
  }
  if (parsed.method !== "agent/run") return { parsed, outLine: line };

  const paramsRecord =
    parsed.params && typeof parsed.params === "object"
      ? (parsed.params as Record<string, unknown>)
      : undefined;
  const cwd = typeof paramsRecord?.cwd === "string" ? paramsRecord.cwd : undefined;
  const sessionId =
    typeof paramsRecord?.sessionId === "string" ? paramsRecord.sessionId : undefined;
  const bucket = typeof paramsRecord?.bucket === "string" ? paramsRecord.bucket : undefined;
  const browserPartition =
    typeof paramsRecord?.browserPartition === "string" ? paramsRecord.browserPartition : undefined;

  if (paramsRecord) {
    delete paramsRecord.bucket;
    delete paramsRecord.browserPartition;
    paramsRecord.projectTrusted = cwd ? isProjectTrusted(cwd) : false;
    return { parsed, outLine: JSON.stringify(parsed), cwd, sessionId, bucket, browserPartition };
  }

  return { parsed, outLine: line, cwd, sessionId, bucket, browserPartition };
}

export function resolveCredentialSessionCwd(
  sessionId: string,
  sessionCwd: ReadonlyMap<string, string>,
  readPersistedCwd: (sessionId: string) => string | undefined,
): string {
  const cwd = sessionCwd.get(sessionId) ?? readPersistedCwd(sessionId);
  if (!cwd) {
    throw new Error(`no cwd registered for session ${sessionId}`);
  }
  return cwd;
}
