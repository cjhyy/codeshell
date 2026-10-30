import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { transcriptToStreamEvents } from "@cjhyy/code-shell-web";
import type { Snapshot } from "../SessionSnapshotStore.js";

const LIMIT = 1024 * 1024;
export class LegacyHistoryUnavailable extends Error {}
const TYPES = new Set([
  "session_meta",
  "message",
  "tool_use",
  "tool_result",
  "turn_boundary",
  "run_result",
  "turn_stopped",
  "error",
  "summary",
  "context_note",
  "context_checkpoint",
  "context_transfer",
  "model_request_boundary",
  "model_request_attempt",
  "range_archive",
  "content_replace",
  "file_history",
  "plan_operation",
  "external_file_changes",
  "turn_diff",
  "goal_progress",
  "subagent",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value;
function validContent(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every((block) => {
        if (!object(block)) return false;
        if (block.type === "text") return typeof block.text === "string";
        if (block.type === "reasoning")
          return typeof block.reasoningContent === "string" || typeof block.text === "string";
        if (block.type === "tool_use")
          return nonempty(block.id) && nonempty(block.name) && object(block.input);
        if (block.type === "tool_result")
          return nonempty(block.tool_use_id) && validContent(block.content);
        return block.type === "image" && object(block.source);
      }))
  );
}
function validDisplayPayload(record: { type: string; data: Record<string, unknown> }): boolean {
  const data = record.data;
  if (record.type === "message")
    return (
      ["user", "assistant", "tool"].includes(String(data.role)) &&
      validContent(data.content) &&
      (data.role !== "tool" || nonempty(data.tool_call_id))
    );
  if (record.type === "tool_use")
    return nonempty(data.toolCallId) && nonempty(data.toolName) && object(data.args);
  if (record.type === "tool_result")
    return (
      nonempty(data.toolCallId) &&
      (typeof data.result === "string" ||
        typeof data.error === "string" ||
        validContent(data.content ?? data.contentBlocks) ||
        (data.result === undefined &&
          data.error === undefined &&
          data.content === undefined &&
          data.contentBlocks === undefined))
    );
  if (record.type === "subagent")
    return (
      nonempty(data.agentId) &&
      (data.name === undefined || typeof data.name === "string") &&
      (data.description === undefined || typeof data.description === "string")
    );
  if (record.type === "error") return typeof data.error === "string";
  return true;
}

function boundedFile(path: string, maxBytes = LIMIT): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes))
      throw new Error("Legacy history file is unavailable");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      offset !== Number(before.size) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw new Error("Legacy history file changed");
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/** Only a genuinely pre-journal, completed external transcript can use the
 * legacy display path. Absence of a journal alone is never proof of history. */
export function readLegacyExternalHistory(root: string, sessionId: string) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(sessionId) || sessionId.includes(".."))
    throw new Error("Invalid legacy Session");
  const canonicalRoot = realpathSync(root);
  const directory = join(canonicalRoot, sessionId);
  const before = lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(directory) !== directory)
    throw new Error("Legacy Session location changed");
  const stateBytes = boundedFile(join(directory, "state.json"));
  const state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stateBytes));
  if (
    state.sessionId !== sessionId ||
    !["claude-code", "codex"].includes(state.provider) ||
    state.kind === "pet" ||
    state.parentSessionId ||
    state.ephemeral ||
    Object.keys(state).some((key) => key.startsWith("output")) ||
    readdirSync(directory).some((name) => name.startsWith("output-"))
  )
    return undefined;
  if (
    !["completed", "model_error", "aborted_streaming", "failed", "cancelled"].includes(state.status)
  )
    throw new LegacyHistoryUnavailable("Legacy Session is not terminal");
  try {
    const transcriptBytes = boundedFile(join(directory, "transcript.jsonl"), 32 * LIMIT);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(transcriptBytes);
    if (!source.endsWith("\n")) throw new Error("Legacy transcript is truncated");
    const records = source
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const ids = new Set<string>();
    for (const record of records) {
      if (
        !record ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        typeof record.id !== "string" ||
        !record.id ||
        ids.has(record.id) ||
        !TYPES.has(record.type) ||
        !record.data ||
        typeof record.data !== "object" ||
        Array.isArray(record.data) ||
        !validDisplayPayload(record)
      )
        throw new Error("Legacy transcript is unsupported");
      ids.add(record.id);
    }
    if (
      records[0]?.type !== "session_meta" ||
      records[0]?.data.sessionId !== sessionId ||
      records.some(
        (record) => record.type === "session_meta" && record.data.sessionId !== sessionId,
      ) ||
      !records.some((record) => record.type === "message" && record.data.role === "assistant")
    )
      throw new Error("Legacy transcript is incomplete");
    // Older resumptions append same-Session metadata updates. They are not a
    // second conversation and must not reset the already projected history.
    const events = transcriptToStreamEvents(
      records.filter((record, index) => index === 0 || record.type !== "session_meta"),
    );
    if (Buffer.byteLength(JSON.stringify(events)) > 32 * LIMIT)
      throw new Error("Legacy history exceeds its display bound");
    const after = lstatSync(directory, { bigint: true });
    if (
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !boundedFile(join(directory, "state.json")).equals(stateBytes) ||
      !boundedFile(join(directory, "transcript.jsonl"), 32 * LIMIT).equals(transcriptBytes) ||
      readdirSync(directory).some((name) => name.startsWith("output-"))
    )
      throw new Error("Legacy Session changed during recovery");
    return {
      identity: createHash("sha256")
        .update(`${canonicalRoot}:${before.dev}:${before.ino}\n`)
        .update(stateBytes)
        .update("\0")
        .update(transcriptBytes)
        .digest("hex"),
      events,
      throughEventId: records.at(-1)!.id as string,
      sourceBytes: transcriptBytes.length,
    };
  } catch {
    throw new LegacyHistoryUnavailable("Legacy transcript cannot be displayed completely");
  }
}

export function isUntouchedLegacySnapshot(snapshot: Snapshot | undefined): boolean {
  return (
    !!snapshot &&
    snapshot.nextSeq === 1 &&
    !snapshot.events.length &&
    !snapshot.topLevelRunning &&
    !snapshot.outputCursor &&
    !snapshot.outputUnpaired &&
    !snapshot.outputInputIds?.length &&
    !snapshot.outputJournalIdentity &&
    !snapshot.historicalGap
  );
}
