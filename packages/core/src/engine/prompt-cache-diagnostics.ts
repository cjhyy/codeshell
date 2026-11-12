import { createHmac, randomBytes } from "node:crypto";
import type { Message, TokenUsage, ToolDefinition } from "../types.js";

const PROCESS_DIAGNOSTIC_KEY = randomBytes(32);
const DEFAULT_MAX_SESSIONS = 256;
const DROP_MIN_PREVIOUS_TOKENS = 100;
const DROP_MAX_CURRENT_TOKENS = 64;
const DROP_RATIO = 0.1;
// Partial cache invalidation can leave thousands of tokens cached. Require
// both a halving and a meaningful absolute loss to avoid reporting small
// fluctuations. Compare cache reads, not hit rates: appending uncached input
// can lower the hit rate while the reusable prefix remains fully cached.
const PARTIAL_DROP_MAX_RETAINED_RATIO = 0.5;
const PARTIAL_DROP_MIN_LOST_TOKENS = 4096;

/**
 * Session stickiness audit. Semantic, capability, and security switches must
 * take effect on the next request even when they invalidate a cache prefix.
 * Only a future cache-only TTL/enable/layout experiment may be locked after
 * the first primary request in one (session, cache scope).
 */
export const PROMPT_CACHE_STICKINESS_AUDIT: Readonly<
  Record<
    string,
    {
      prefix: "system" | "tools" | "config" | "dynamic";
      policy: "hot" | "client_sticky" | "not_applicable" | "session_lock_if_introduced";
    }
  >
> = {
  systemSettings: { prefix: "system", policy: "hot" },
  planMode: { prefix: "tools", policy: "hot" },
  permissionMode: { prefix: "tools", policy: "hot" },
  goalState: { prefix: "tools", policy: "hot" },
  builtinFeatureFlags: { prefix: "tools", policy: "hot" },
  mcpServerSet: { prefix: "tools", policy: "hot" },
  toolAvailability: { prefix: "tools", policy: "hot" },
  skillsGitMemory: { prefix: "dynamic", policy: "not_applicable" },
  providerCacheStrategy: { prefix: "config", policy: "client_sticky" },
  providerReactiveFallbacks: { prefix: "config", policy: "client_sticky" },
  futureCacheOnlyPolicy: { prefix: "config", policy: "session_lock_if_introduced" },
};

export interface PromptPrefixFingerprint {
  version: 1;
  cacheScopeHash: string;
  systemHash: string;
  toolsHash: string;
  configHash: string;
}

/** One request message, reduced to what attribution needs. Never the text. */
export interface PromptMessageDigest {
  hash: string;
  role: Message["role"];
  /** A `tool` message, or one carrying a `tool_result` block. */
  hasToolResult: boolean;
}

export type PromptMessageChange = "append_only" | "rewritten" | "removed" | "inserted" | "diverged";

export interface PromptMessageChainDiff {
  messageChange: PromptMessageChange;
  /** Absent when the previous list is a prefix of the current one. */
  firstChangedMessageIndex?: number;
  previousMessageCount: number;
  currentMessageCount: number;
  /** The message at the changed index: the current one, else the previous one. */
  changedMessageRole?: Message["role"];
  changedMessageHasToolResult?: boolean;
}

export interface PromptCacheDiagnosticSample {
  usage: TokenUsage;
  fingerprint: PromptPrefixFingerprint;
  requestKind: "primary" | "continuation";
  /** Hash chain of the messages sent in this request, in request order. */
  messages?: readonly PromptMessageDigest[];
}

export interface PromptCacheDiagnosticState {
  cacheReadTokens: number;
  fingerprint: PromptPrefixFingerprint;
  sampledAtMs: number;
  messages?: readonly PromptMessageDigest[];
}

export type PromptPrefixPart = "system" | "tools" | "config";

export interface PromptCacheDropAttribution {
  changedPrefixes: PromptPrefixPart[];
  cause:
    | "system_changed"
    | "tools_changed"
    | "config_changed"
    | "multiple_prefixes_changed"
    | "message_prefix_changed"
    | "no_tracked_prefix_change";
  /** Present when both compared samples carried a message chain. */
  messages?: PromptMessageChainDiff;
}

const SENSITIVE_IDENTITY_KEYS = new Set([
  "apikey",
  "api_key",
  "authcommand",
  "authorization",
  "httpheaders",
  "headers",
  "password",
  "secret",
  "token",
  "baseurl",
]);

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return `[${typeof value}]`;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (SENSITIVE_IDENTITY_KEYS.has(key.toLocaleLowerCase())) continue;
    const entry = canonicalize((value as Record<string, unknown>)[key], seen);
    if (entry !== undefined) out[key] = entry;
  }
  seen.delete(value);
  return out;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hmac(value: unknown, key: Uint8Array = PROCESS_DIAGNOSTIC_KEY): string {
  return createHmac("sha256", key).update(stableSerialize(value)).digest("hex").slice(0, 16);
}

export function hashSystemPrompt(
  systemPrompt: string,
  key: Uint8Array = PROCESS_DIAGNOSTIC_KEY,
): string {
  return hmac(["system-v1", systemPrompt], key);
}

export function hashToolDefinitions(
  tools: readonly ToolDefinition[],
  key: Uint8Array = PROCESS_DIAGNOSTIC_KEY,
): string {
  return hmac(["tools-v1", tools], key);
}

export function createPromptPrefixFingerprint(
  systemPrompt: string,
  tools: readonly ToolDefinition[],
  configIdentity: Readonly<Record<string, unknown>>,
  scopeIdentity: Readonly<Record<string, unknown>>,
  key: Uint8Array = PROCESS_DIAGNOSTIC_KEY,
): PromptPrefixFingerprint {
  return {
    version: 1,
    cacheScopeHash: hmac(["scope-v1", scopeIdentity], key),
    systemHash: hashSystemPrompt(systemPrompt, key),
    toolsHash: hashToolDefinitions(tools, key),
    configHash: hmac(["config-v1", configIdentity], key),
  };
}

/**
 * Key-order-independent JSON of one message. Unlike `canonicalize`, nothing is
 * dropped: a tool argument named `token` is part of the cached bytes.
 */
function stableMessageJson(message: Message): string {
  return JSON.stringify(message, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key];
    return sorted;
  });
}

function messageHasToolResult(message: Message): boolean {
  if (message.role === "tool") return true;
  return (
    Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Hash every message of one request. One pass over the message bytes, no
 * memoization: an old message rewritten in place (same object, new content) is
 * exactly what this exists to catch, so identity is not trusted.
 */
export function hashPromptMessages(
  messages: readonly Message[],
  key: Uint8Array = PROCESS_DIAGNOSTIC_KEY,
): PromptMessageDigest[] {
  return messages.map((message) => ({
    hash: createHmac("sha256", key)
      .update("message-v1\n")
      .update(stableMessageJson(message))
      .digest("hex")
      .slice(0, 16),
    role: message.role,
    hasToolResult: messageHasToolResult(message),
  }));
}

/** True when `left[leftStart..]` is a prefix of `right[rightStart..]`. */
function tailIsPrefix(
  left: readonly PromptMessageDigest[],
  leftStart: number,
  right: readonly PromptMessageDigest[],
  rightStart: number,
): boolean {
  const length = left.length - leftStart;
  if (length > right.length - rightStart) return false;
  for (let offset = 0; offset < length; offset++) {
    if (left[leftStart + offset]!.hash !== right[rightStart + offset]!.hash) return false;
  }
  return true;
}

/**
 * Compare two request message chains. A later tail may always have grown, so
 * "lines up" means the previous remainder is a prefix of the current one.
 * Shifts by one message need at least one surviving message as evidence;
 * anything larger (compaction, several removals) is `diverged`.
 */
export function diffPromptMessageChain(
  previous: readonly PromptMessageDigest[],
  current: readonly PromptMessageDigest[],
): PromptMessageChainDiff {
  const counts = { previousMessageCount: previous.length, currentMessageCount: current.length };
  const shared = Math.min(previous.length, current.length);
  let index = 0;
  while (index < shared && previous[index]!.hash === current[index]!.hash) index++;
  if (index === previous.length) return { messageChange: "append_only", ...counts };

  let messageChange: PromptMessageChange;
  if (index === current.length) {
    // The current list is a strict prefix of the previous one: tail dropped.
    messageChange = "removed";
  } else if (tailIsPrefix(previous, index + 1, current, index + 1)) {
    messageChange = "rewritten";
  } else if (previous.length > index + 1 && tailIsPrefix(previous, index + 1, current, index)) {
    messageChange = "removed";
  } else if (tailIsPrefix(previous, index, current, index + 1)) {
    messageChange = "inserted";
  } else {
    messageChange = "diverged";
  }
  const changed = current[index] ?? previous[index]!;
  return {
    messageChange,
    firstChangedMessageIndex: index,
    ...counts,
    changedMessageRole: changed.role,
    changedMessageHasToolResult: changed.hasToolResult,
  };
}

export function diffPromptPrefix(
  previous: PromptPrefixFingerprint,
  current: PromptPrefixFingerprint,
): PromptCacheDropAttribution {
  const changedPrefixes: PromptPrefixPart[] = [];
  if (previous.systemHash !== current.systemHash) changedPrefixes.push("system");
  if (previous.toolsHash !== current.toolsHash) changedPrefixes.push("tools");
  if (previous.configHash !== current.configHash) changedPrefixes.push("config");
  const cause: PromptCacheDropAttribution["cause"] =
    changedPrefixes.length === 0
      ? "no_tracked_prefix_change"
      : changedPrefixes.length > 1
        ? "multiple_prefixes_changed"
        : changedPrefixes[0] === "system"
          ? "system_changed"
          : changedPrefixes[0] === "tools"
            ? "tools_changed"
            : "config_changed";
  return { changedPrefixes, cause };
}

export type PromptCacheRecordResult =
  | { kind: "ignored" | "baseline" | "scope_changed" | "schema_changed" | "updated" }
  | {
      kind: "drop";
      previous: PromptCacheDiagnosticState;
      current: PromptCacheDiagnosticState;
      dropRatio: number;
      attribution: PromptCacheDropAttribution;
    };

export class PromptCacheDiagnosticRecorder {
  private readonly states = new Map<string, PromptCacheDiagnosticState>();
  private readonly maxSessions: number;

  constructor(options: { maxSessions?: number } = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  get size(): number {
    return this.states.size;
  }

  has(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  get(sessionId: string): PromptCacheDiagnosticState | undefined {
    return this.states.get(sessionId);
  }

  record(
    sessionId: string,
    sample: PromptCacheDiagnosticSample,
    sampledAtMs = Date.now(),
  ): PromptCacheRecordResult {
    const cacheReadTokens = sample.usage.cacheReadTokens;
    if (cacheReadTokens === undefined || !Number.isFinite(cacheReadTokens)) {
      return { kind: "ignored" };
    }

    const previous = this.states.get(sessionId);
    const current: PromptCacheDiagnosticState = {
      cacheReadTokens,
      fingerprint: sample.fingerprint,
      sampledAtMs,
      ...(sample.messages ? { messages: sample.messages } : {}),
    };
    this.states.delete(sessionId);
    this.states.set(sessionId, current);
    while (this.states.size > this.maxSessions) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }

    if (!previous) return { kind: "baseline" };
    if (previous.fingerprint.version !== sample.fingerprint.version) {
      return { kind: "schema_changed" };
    }
    if (previous.fingerprint.cacheScopeHash !== sample.fingerprint.cacheScopeHash) {
      return { kind: "scope_changed" };
    }
    if (previous.cacheReadTokens < DROP_MIN_PREVIOUS_TOKENS) return { kind: "updated" };

    const dropRatio = previous.cacheReadTokens > 0 ? cacheReadTokens / previous.cacheReadTokens : 1;
    const nearColdDrop = cacheReadTokens <= DROP_MAX_CURRENT_TOKENS && dropRatio <= DROP_RATIO;
    const partialDrop =
      dropRatio <= PARTIAL_DROP_MAX_RETAINED_RATIO &&
      previous.cacheReadTokens - cacheReadTokens >= PARTIAL_DROP_MIN_LOST_TOKENS;
    if (!nearColdDrop && !partialDrop) {
      return { kind: "updated" };
    }
    const attribution = diffPromptPrefix(previous.fingerprint, current.fingerprint);
    if (previous.messages && current.messages) {
      attribution.messages = diffPromptMessageChain(previous.messages, current.messages);
      if (
        attribution.cause === "no_tracked_prefix_change" &&
        attribution.messages.messageChange !== "append_only"
      ) {
        attribution.cause = "message_prefix_changed";
      }
    }
    return { kind: "drop", previous, current, dropRatio, attribution };
  }
}

export function promptCacheDropHint(attribution: PromptCacheDropAttribution): string {
  switch (attribution.cause) {
    case "system_changed":
      return "System prefix changed; inspect cwd/model runtime header, preset, custom/append prompt, language, or profile.";
    case "tools_changed":
      return "Tool prefix changed; inspect plan mode, builtin/feature flags, MCP ownership, credential guards, and schema order.";
    case "config_changed":
      return "Request config changed; inspect reasoning shape, token fields, and provider cache strategy.";
    case "multiple_prefixes_changed":
      return `Multiple tracked prefixes changed: ${attribution.changedPrefixes.join(", ")}.`;
    case "message_prefix_changed": {
      const diff = attribution.messages;
      const subject = diff?.changedMessageHasToolResult
        ? `${diff.changedMessageRole} tool-result message`
        : `${diff?.changedMessageRole ?? "unknown"} message`;
      return `Message list changed before the cached tail: ${diff?.messageChange ?? "diverged"} at index ${diff?.firstChangedMessageIndex ?? "unknown"} (${subject}; ${diff?.previousMessageCount ?? "?"} -> ${diff?.currentMessageCount ?? "?"} messages). Everything from that index on was re-billed; inspect compaction/archival, tool-result clearing or redaction, and volatile context placement.`;
    }
    case "no_tracked_prefix_change":
      return "No tracked prefix changed; inspect provider TTL/eviction, history compaction, userContext/date/instructions, or server cache policy.";
  }
}

/** Attribution fields of the `engine.cache_read_drop` log event. */
export function promptCacheDropLogFields(
  attribution: PromptCacheDropAttribution,
): Record<string, unknown> & { hint: string } {
  return {
    cause: attribution.cause,
    changedPrefixes: attribution.changedPrefixes,
    ...attribution.messages,
    hint: promptCacheDropHint(attribution),
  };
}
