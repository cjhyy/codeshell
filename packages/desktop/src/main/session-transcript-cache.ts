import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";
import { mutateJsonFile } from "@cjhyy/code-shell-core/internal";
import type {
  SessionTranscriptCacheKey,
  SessionTranscriptCacheRead,
} from "../shared/session-catalog.js";

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_READ_BYTES = 512 * 1024;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type CachedMessage = Record<string, unknown> & { id: string; kind: string };
type CachedState = Record<string, unknown> & { messages: CachedMessage[] };
interface CacheFile {
  version: 1;
  state: CachedState | null;
  deleted?: true;
}

export interface SessionTranscriptCacheOptions {
  directory?: string;
  legacyDirectory?: string;
}

/**
 * Disposable renderer projections have individual files outside Chromium's
 * quota. This does not modify or replace authoritative Session transcript.jsonl.
 * Legacy files retain their exact original JSON until explicit session deletion.
 */
export class SessionTranscriptCache {
  private readonly directory: string;
  private readonly legacyDirectory: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: SessionTranscriptCacheOptions = {}) {
    const desktop = join(codeShellHome(), "desktop");
    this.directory = options.directory ?? join(desktop, "transcript-cache");
    this.legacyDirectory = options.legacyDirectory ?? join(desktop, "legacy-transcript-cache");
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  write(input: SessionTranscriptCacheKey & { value: string; legacy?: boolean }): Promise<void> {
    let key: string;
    let incoming: CachedState;
    try {
      key = checkedKey(input);
      incoming = parseState(input.value);
      if (input.legacy !== undefined && typeof input.legacy !== "boolean") {
        throw new Error("invalid legacy transcript flag");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const raw = input.value;
    const legacy = input.legacy === true;
    return this.enqueue(() => {
      this.mutate(key, (current) => {
        if (current?.deleted) return undefined;
        if (legacy) {
          // A distinct directory avoids recursively taking the cache's mutex.
          // Preserve even an older migration if the current cache already exists.
          mutateJsonFile<string>(join(this.legacyDirectory, key), {
            parse: (existing) => {
              if (existing !== undefined) parseState(existing);
              return existing ?? "";
            },
            serialize: (value) => value,
            mutation: (existing) => (existing ? {} : { value: raw }),
            maxBytes: MAX_INPUT_BYTES,
            mode: 0o600,
          });
          if (current) return undefined;
        }
        const state = current?.state ? mergeSnapshot(current.state, incoming) : incoming;
        return { version: 1, state };
      });
    });
  }

  read(
    input: SessionTranscriptCacheKey & { maxBytes?: number },
  ): Promise<SessionTranscriptCacheRead> {
    let key: string;
    const maxBytes = input.maxBytes ?? DEFAULT_READ_BYTES;
    try {
      key = checkedKey(input);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error("invalid transcript read budget");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() => {
      let result: SessionTranscriptCacheRead = { value: null, hasEarlier: false };
      this.mutate(key, (current) => {
        if (current?.state && !current.deleted) result = tailSnapshot(current.state, maxBytes);
        return undefined;
      });
      return result;
    });
  }

  delete(input: SessionTranscriptCacheKey): Promise<void> {
    let key: string;
    try {
      key = checkedKey(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() => {
      // A tombstone fences a slow renderer save or pending legacy migration.
      this.mutate(key, () => ({ version: 1, state: null, deleted: true }));
      rmSync(join(this.legacyDirectory, key), { force: true });
    });
  }

  private enqueue<T>(work: () => T): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private mutate(key: string, change: (current: CacheFile | null) => CacheFile | undefined): void {
    mutateJsonFile<CacheFile | null>(join(this.directory, key), {
      parse: (raw) => {
        if (raw === undefined) return null;
        const file = record(JSON.parse(raw), "transcript cache");
        if (file.version !== 1) throw new Error("unsupported transcript cache version");
        if (file.deleted === true && file.state === null)
          return { version: 1, state: null, deleted: true };
        return { version: 1, state: checkedState(file.state) };
      },
      serialize: (value) => JSON.stringify(value),
      mutation: (current) => ({ value: change(current) }),
      maxBytes: MAX_INPUT_BYTES + 4096,
      mode: 0o600,
    });
  }
}

function checkedKey(input: SessionTranscriptCacheKey): string {
  record(input, "transcript key");
  for (const value of [input.projectKey, input.sessionId]) {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 512 ||
      UNSAFE_KEYS.has(value) ||
      value === "." ||
      value === ".." ||
      /[\\/\x00-\x1f]/.test(value)
    )
      throw new Error("invalid transcript cache id");
  }
  // Hash a tuple, not joined user-controlled path segments or an ambiguous key.
  return `${createHash("sha256")
    .update(JSON.stringify([input.projectKey, input.sessionId]))
    .digest("hex")}.json`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid ${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`invalid ${label}`);
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`unsafe ${label} key`);
  }
  return value as Record<string, unknown>;
}

function parseState(raw: string): CachedState {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("transcript cache exceeds the input limit");
  }
  return checkedState(JSON.parse(raw));
}

function checkedState(value: unknown): CachedState {
  const state = record(value, "transcript state");
  if (!Array.isArray(state.messages)) throw new Error("transcript state must contain messages");
  for (const message of state.messages) {
    const row = record(message, "transcript message");
    if (typeof row.id !== "string" || !row.id || typeof row.kind !== "string") {
      throw new Error("invalid transcript message identity");
    }
  }
  return state as CachedState;
}

/** A tail hydrated into a renderer must not erase its earlier cached history. */
function mergeSnapshot(previous: CachedState, incoming: CachedState): CachedState {
  if (incoming.messages.length === 0) {
    return repairPointers({
      ...previous,
      ...incoming,
      ...mergeCursor(previous, incoming),
      messages: previous.messages,
    });
  }
  const stablePositions = new Map<string, number>();
  const turnIdentities: Array<string | null> = [];
  let turn: string | null = null;
  previous.messages.forEach((message, index) => {
    stablePositions.set(`${message.kind}|${message.id}`, index);
    const intent = userIntent(message);
    if (intent) stablePositions.set(intent, index);
    if (message.kind === "user") turn = intent;
    turnIdentities.push(turn);
  });
  const first = incoming.messages[0];
  // Stable renderer ids and durable user intent ids are strongest. A disk fold
  // regenerates many renderer ids, so compare content only as the fallback.
  let incomingStart = 0;
  let firstOverlap = previous.messages.findIndex((message) => stableMatch(message, first));
  if (firstOverlap < 0) {
    // A stable anchor later in an expanded page is stronger evidence than a
    // coincidentally identical first answer from another turn.
    for (let index = 1; index < incoming.messages.length; index += 1) {
      const message = incoming.messages[index];
      const intent = userIntent(message);
      const position =
        stablePositions.get(`${message.kind}|${message.id}`) ??
        (intent ? stablePositions.get(intent) : undefined);
      if (position === undefined) continue;
      firstOverlap = position;
      incomingStart = index;
      while (
        firstOverlap > 0 &&
        incomingStart > 0 &&
        semanticMatch(previous.messages[firstOverlap - 1], incoming.messages[incomingStart - 1])
      ) {
        firstOverlap -= 1;
        incomingStart -= 1;
      }
      break;
    }
  }
  if (firstOverlap < 0) {
    let longestMatch = 0;
    for (let start = 0; start < previous.messages.length; start += 1) {
      if (!semanticMatch(previous.messages[start], first)) continue;
      let length = 1;
      while (
        length < incoming.messages.length &&
        start + length < previous.messages.length &&
        (stableMatch(previous.messages[start + length], incoming.messages[length]) ||
          semanticMatch(previous.messages[start + length], incoming.messages[length]))
      )
        length += 1;
      // Prefer the longest shared sequence; ties select the latest occurrence
      // because reads return a tail. Repeated user intents with distinct durable
      // ids never match by text, so a new “continue” turn cannot erase an old one.
      if (length >= longestMatch) {
        longestMatch = length;
        firstOverlap = start;
      }
    }
  }
  // A renderer may finish saving an old page after another window completed
  // another turn. Overlap proves message identity, not that incoming covers the
  // entire suffix. Preserve both sides of the covered span and advance common
  // messages monotonically instead of truncating at the first shared id.
  if (firstOverlap < 0) {
    // An expanded page begins BEFORE our retained tail. Find a later shared
    // anchor and insert the new prefix ahead of it, rather than appending the
    // older page after the newer conversation. Index semantic candidates once
    // so a large expansion with unique text remains linear.
    const semanticPositions = new Map<string, number[]>();
    previous.messages.forEach((message, index) => {
      const key = semanticKey(message);
      if (key === undefined) return;
      const positions = semanticPositions.get(key) ?? [];
      positions.push(index);
      semanticPositions.set(key, positions);
    });
    let incomingTurn: string | null = null;
    for (let index = 0; index < incoming.messages.length; index += 1) {
      const message = incoming.messages[index];
      if (message.kind === "user") incomingTurn = userIntent(message);
      if (index === 0) continue;
      const intent = userIntent(message);
      let position = stablePositions.get(`${message.kind}|${message.id}`);
      if (position === undefined && intent) position = stablePositions.get(intent);
      if (position === undefined) {
        const key = semanticKey(message);
        const candidates = key === undefined ? [] : (semanticPositions.get(key) ?? []);
        let longest = 0;
        for (const start of candidates) {
          // An identical answer under a different durable question is a new
          // turn, not proof that the incoming page contains older history.
          if (incomingTurn !== null && incomingTurn !== turnIdentities[start]) continue;
          let length = 1;
          while (
            index + length < incoming.messages.length &&
            start + length < previous.messages.length &&
            (stableMatch(previous.messages[start + length], incoming.messages[index + length]) ||
              semanticMatch(previous.messages[start + length], incoming.messages[index + length]))
          )
            length += 1;
          if (length >= longest) {
            position = start;
            longest = length;
          }
        }
      }
      if (position === undefined) continue;
      firstOverlap = position;
      incomingStart = index;
      // Random renderer ids before a stable tool/intent anchor may still
      // describe the same contiguous rows; avoid retaining those twice.
      while (
        firstOverlap > 0 &&
        incomingStart > 0 &&
        semanticMatch(previous.messages[firstOverlap - 1], incoming.messages[incomingStart - 1])
      ) {
        firstOverlap -= 1;
        incomingStart -= 1;
      }
      break;
    }
  }
  const messages = [
    ...previous.messages.slice(0, firstOverlap < 0 ? undefined : firstOverlap),
    ...incoming.messages.slice(0, incomingStart),
  ];
  let cursor = firstOverlap < 0 ? previous.messages.length : firstOverlap;
  const mergedIds = new Map<string, string>();
  let incomingTurn: string | null = turnIdentities[cursor] ?? null;
  for (const message of incoming.messages.slice(incomingStart)) {
    if (message.kind === "user") incomingTurn = userIntent(message);
    const intent = userIntent(message);
    let position = stablePositions.get(`${message.kind}|${message.id}`);
    if (position === undefined && intent) position = stablePositions.get(intent);
    if (position !== undefined && position < cursor) position = undefined;
    if (
      position === undefined &&
      cursor < previous.messages.length &&
      incomingTurn === turnIdentities[cursor] &&
      (semanticMatch(previous.messages[cursor], message) ||
        progressiveTextMatch(previous.messages[cursor], message))
    ) {
      position = cursor;
    }
    if (position !== undefined) {
      messages.push(...previous.messages.slice(cursor, position));
      const merged = mergeMessageProgress(previous.messages[position], message);
      mergedIds.set(
        `${previous.messages[position].kind}|${previous.messages[position].id}`,
        merged.id,
      );
      messages.push(merged);
      cursor = position + 1;
    } else {
      if (message.kind === "user") {
        // A distinct new intent follows the old window's already-persisted
        // continuation; it must not place that continuation after the new turn.
        messages.push(...previous.messages.slice(cursor));
        cursor = previous.messages.length;
      }
      messages.push(message);
    }
  }
  messages.push(...previous.messages.slice(cursor));
  const deduplicated: CachedMessage[] = [];
  const seen = new Map<string, number>();
  for (const message of messages) {
    const identity = userIntent(message) ?? `${message.kind}|${message.id}`;
    const index = seen.get(identity);
    if (index === undefined) {
      seen.set(identity, deduplicated.length);
      deduplicated.push(message);
    } else {
      deduplicated[index] = mergeMessageProgress(deduplicated[index], message);
    }
  }
  return repairPointers({
    ...previous,
    ...incoming,
    messages: deduplicated,
    ...mergeCursor(previous, incoming),
    streamingAssistantId:
      incoming.streamingAssistantId ??
      mergedIds.get(`assistant|${previous.streamingAssistantId}`) ??
      previous.streamingAssistantId,
    streamingThinkingId:
      incoming.streamingThinkingId ??
      mergedIds.get(`thinking|${previous.streamingThinkingId}`) ??
      previous.streamingThinkingId,
  });
}

/** A sequence can only be compared with another cursor from the same Main lifetime. */
function mergeCursor(previous: CachedState, incoming: CachedState) {
  const snapshotEpoch = incoming.snapshotEpoch;
  const incomingSeq = Number(incoming.snapshotSeq) || 0;
  return {
    snapshotEpoch,
    snapshotSeq:
      previous.snapshotEpoch === snapshotEpoch
        ? Math.max(Number(previous.snapshotSeq) || 0, incomingSeq)
        : incomingSeq,
  };
}

/** Only after a turn/position anchor: equal prefixes alone cannot identify a turn. */
function progressiveTextMatch(a: CachedMessage, b: CachedMessage): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "assistant" || a.kind === "thinking") &&
    typeof a.text === "string" &&
    typeof b.text === "string" &&
    (a.text.startsWith(b.text) || b.text.startsWith(a.text))
  );
}

function mergeMessageProgress(previous: CachedMessage, incoming: CachedMessage): CachedMessage {
  const previousTerminal =
    previous.done === true ||
    (previous.kind === "tool" &&
      typeof previous.status === "string" &&
      previous.status !== "queued" &&
      previous.status !== "running");
  const incomingTerminal =
    incoming.done === true ||
    (incoming.kind === "tool" &&
      typeof incoming.status === "string" &&
      incoming.status !== "queued" &&
      incoming.status !== "running");
  const merged: CachedMessage =
    previousTerminal && !incomingTerminal
      ? { ...incoming, ...previous, id: incoming.id }
      : { ...previous, ...incoming };
  for (const field of ["text", "textBuffer", "result"]) {
    const before = previous[field];
    const after = incoming[field];
    if (typeof before === "string" && typeof after === "string" && before.startsWith(after)) {
      merged[field] = before;
    }
  }
  if (previous.done === true || incoming.done === true) merged.done = true;
  if (previous.pending === false && incoming.pending === true) merged.pending = false;
  return merged;
}

function userIntent(message: CachedMessage): string | null {
  if (message.kind !== "user") return null;
  if (typeof message.clientMessageId === "string" && message.clientMessageId) {
    return `client:${message.clientMessageId}`;
  }
  return typeof message.steerId === "string" && message.steerId ? `steer:${message.steerId}` : null;
}

function stableMatch(a: CachedMessage, b: CachedMessage): boolean {
  if (a.kind !== b.kind) return false;
  if (a.id === b.id) return true;
  const intent = userIntent(a);
  return intent !== null && intent === userIntent(b);
}

function semanticKey(message: CachedMessage): string | undefined {
  const fields = (names: string[]) =>
    JSON.stringify([message.kind, ...names.map((name) => JSON.stringify(message[name]))]);
  switch (message.kind) {
    case "user": {
      const intent = userIntent(message);
      return intent ? JSON.stringify(["user", "intent", intent]) : fields(["text", "attachments"]);
    }
    case "assistant":
    case "system":
    case "thinking":
      return typeof message.text === "string" && message.text.length > 0
        ? fields(["text"])
        : undefined;
    case "tool":
      return fields(["toolName", "args"]);
    case "files_changed":
      return fields(["files"]);
    case "context_boundary":
      return fields(["strategy", "before", "after", "contextTransfer"]);
    case "goal_progress":
      return fields(["goalId", "status", "round", "gaps"]);
    default:
      return undefined;
  }
}

function semanticMatch(a: CachedMessage, b: CachedMessage): boolean {
  const key = semanticKey(a);
  return key !== undefined && key === semanticKey(b);
}

function tailSnapshot(state: CachedState, maxBytes: number): SessionTranscriptCacheRead {
  let bytes = Buffer.byteLength(JSON.stringify({ ...state, messages: [] }), "utf8");
  let start = state.messages.length;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const messageBytes = Buffer.byteLength(JSON.stringify(state.messages[index]), "utf8") + 1;
    // Budget is soft: never discard the final message solely for its size.
    if (start !== state.messages.length && bytes + messageBytes > maxBytes) break;
    bytes += messageBytes;
    start = index;
  }
  return {
    value: JSON.stringify(repairPointers({ ...state, messages: state.messages.slice(start) })),
    hasEarlier: start > 0,
  };
}

function repairPointers(state: CachedState): CachedState {
  const agentMessageIndex: Record<string, number> = {};
  state.messages.forEach((message, index) => {
    if (message.kind === "agent" && !UNSAFE_KEYS.has(message.id))
      agentMessageIndex[message.id] = index;
  });
  const liveId = (value: unknown, kind: string): string | null =>
    typeof value === "string" &&
    state.messages.some(
      (message) => message.id === value && message.kind === kind && message.done !== true,
    )
      ? value
      : null;
  return {
    ...state,
    agentMessageIndex,
    streamingAssistantId: liveId(state.streamingAssistantId, "assistant"),
    streamingThinkingId: liveId(state.streamingThinkingId, "thinking"),
  };
}
