import type { Dirent } from "node:fs";
/**
 * Session fork snapshot rules and target construction.
 *
 * Owns the per-event fork policy, freezing a source transcript at a cursor
 * (or its completed snapshot), validating that the frozen history has no
 * split tool rounds, building the independent target state/transcript, and
 * best-effort cleanup of crash-orphaned `.pending-fork-*` staging directories.
 * Reading the source and publishing the target stay on SessionManager.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type {
  SessionForkLineage,
  SessionState,
  TranscriptEvent,
  TranscriptEventType,
} from "../types.js";
import { Transcript } from "./transcript.js";
import { SessionError } from "../exceptions.js";
import { isSessionWorkspace } from "./session-state-shape.js";

export interface FrozenForkSnapshot {
  sourceState: SessionState;
  copiedEvents: TranscriptEvent[];
}

type ForkEventPolicy = "copy" | "skip";

/**
 * Every known transcript event must make an explicit fork decision. The
 * `satisfies` constraint turns new TranscriptEventType additions into a
 * compile-time error instead of a quick-chat failure discovered at runtime.
 * The runtime fallback below still rejects unknown events from newer or
 * malformed persisted transcripts.
 */
const FORK_EVENT_POLICY = {
  // Signed wire receipts remain bound to the original Session incarnation.
  model_request_boundary: "skip",
  model_request_attempt: "skip",
  message: "copy",
  tool_use: "copy",
  tool_result: "copy",
  summary: "copy",
  context_transfer: "copy",
  context_note: "copy",
  context_checkpoint: "copy",
  range_archive: "copy",
  content_replace: "copy",
  file_history: "skip",
  plan_operation: "skip",
  session_meta: "skip",
  subagent: "copy",
  external_file_changes: "copy",
  turn_diff: "copy",
  turn_boundary: "copy",
  // Idempotency receipts belong to the source session and never contribute to
  // model context. Copying them could replay a source response in the child.
  run_result: "skip",
  goal_progress: "copy",
  turn_stopped: "copy",
  error: "copy",
} as const satisfies Record<TranscriptEventType, ForkEventPolicy>;
const FORK_STAGING_NAME = /^\.pending-fork-[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}$/;
const FORK_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FORK_STAGING_CLEANUP_LIMIT = 32;

export function cleanupStaleForkStaging(sessionsDir: string): void {
  let removed = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (removed >= FORK_STAGING_CLEANUP_LIMIT) return;
    if (!entry.isDirectory() || !FORK_STAGING_NAME.test(entry.name)) continue;
    const path = join(sessionsDir, entry.name);
    try {
      if (Date.now() - statSync(path).mtimeMs <= FORK_STAGING_MAX_AGE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Startup cleanup is best effort; a live/unreadable staging directory
      // must never prevent the SessionManager from serving normal sessions.
    }
  }
}

export function freezeForkSnapshot(
  sourceSessionId: string,
  sourceState: SessionState,
  events: readonly TranscriptEvent[],
  throughEventId: string | undefined,
  snapshotMode: "tail" | "completed",
): FrozenForkSnapshot {
  // Both process-local and disk readers provide a snapshot array. Fork
  // selection is synchronous, so keep event references here and clone once
  // when the independently-owned target transcript is constructed below.
  const sourceEvents = [...events];
  let frozen = sourceEvents;
  const effectiveCursor =
    snapshotMode === "completed" ? sourceState.completedThroughEventId : throughEventId;
  if (snapshotMode === "completed" && effectiveCursor === undefined) {
    // Legacy sessions predate completedThroughEventId. Their tail is a safe
    // completed snapshot only when the persisted lifecycle status says the
    // last run completed naturally. A modern schema marker without a cursor
    // means persistence was degraded, so even status=completed must not use
    // the tail. Active/error/abort tails may be partial as well.
    frozen =
      sourceState.completedSnapshotVersion === undefined && sourceState.status === "completed"
        ? sourceEvents
        : [];
  } else if (effectiveCursor !== undefined) {
    const matches = sourceEvents
      .map((event, index) => (event.id === effectiveCursor ? index : -1))
      .filter((index) => index >= 0);
    if (matches.length !== 1) {
      throw new SessionError(
        snapshotMode === "completed"
          ? `Completed fork cursor must identify exactly one source event`
          : `Fork cursor must identify exactly one source event`,
      );
    }
    const cursor = sourceEvents[matches[0]];
    if (cursor.type === "session_meta") {
      throw new SessionError(`Fork cursor cannot point at session metadata`);
    }
    frozen = sourceEvents.slice(0, matches[0] + 1);
  }

  const copiedEvents: TranscriptEvent[] = [];
  for (const event of frozen) {
    const policy: ForkEventPolicy | undefined = FORK_EVENT_POLICY[event.type];
    if (policy === "skip") continue;
    if (policy !== "copy") {
      throw new SessionError(`Unsupported transcript event in fork: ${String(event.type)}`);
    }
    copiedEvents.push(event);
  }
  validateForkToolPairs(copiedEvents);
  return { sourceState: structuredClone(sourceState), copiedEvents };
}

/** The single context_transfer event that seeds a summary-only fork. */
export function buildSummaryTransferEvent(
  sourceSessionId: string,
  options: {
    fromEventId: string;
    toEventId: string;
    summary: string;
    sourceEventCount: number;
    estimatedTokens: number;
  },
  createdAt: number,
): TranscriptEvent {
  return {
    id: nanoid(12),
    type: "context_transfer",
    timestamp: createdAt,
    turnNumber: 0,
    data: {
      summary: options.summary,
      sourceRange: {
        sessionId: sourceSessionId,
        fromEventId: options.fromEventId,
        toEventId: options.toEventId,
      },
      sourceEventCount: options.sourceEventCount,
      estimatedTokens: options.estimatedTokens,
      summaryVersion: 1,
      summaryHash: createHash("sha256").update(options.summary).digest("hex"),
    },
  };
}

export function buildForkState(
  source: SessionState,
  targetSessionId: string,
  lineage: SessionForkLineage,
  startedAt = Date.now(),
): SessionState {
  const workspace = isSessionWorkspace(source.workspace)
    ? structuredClone(source.workspace)
    : { root: source.cwd, kind: "main" as const };
  return {
    sessionId: targetSessionId,
    kind: "work",
    stateRevision: 0,
    cwd: source.cwd,
    workspace,
    startedAt,
    model: source.model,
    provider: source.provider,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    cacheUsageVersion: 1,
    cumulativePromptTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeCacheCreationTokens: 0,
    turnCount: 0,
    turnSeq: 0,
    invokedSkills: [],
    parentSessionId: null,
    forkedFrom: structuredClone(lineage),
    ...(source.origin ? { origin: source.origin } : {}),
    status: "active",
  };
}

export function buildForkTranscript(
  sourceEvents: readonly TranscriptEvent[],
  state: SessionState,
): TranscriptEvent[] {
  const meta: TranscriptEvent = {
    id: nanoid(12),
    type: "session_meta",
    timestamp: state.startedAt,
    turnNumber: 0,
    data: {
      sessionId: state.sessionId,
      cwd: state.cwd,
      workspace: structuredClone(state.workspace),
      model: state.model,
      provider: state.provider,
      startedAt: state.startedAt,
      forkedFrom: structuredClone(state.forkedFrom),
    },
  };
  const copied = sourceEvents.map((source) => ({
    ...structuredClone(source),
    id: nanoid(12),
  }));
  Transcript.remapContextForkReferences(sourceEvents, copied);
  const copiedIds = new Map(sourceEvents.map((event, index) => [event.id, copied[index]!.id]));
  for (const event of copied) {
    if (event.type !== "turn_diff") continue;
    for (const key of ["turnId", "runId"] as const) {
      const original = event.data[key];
      if (typeof original === "string" && copiedIds.has(original))
        event.data[key] = copiedIds.get(original)!;
    }
  }
  return [meta, ...copied];
}

function validateForkToolPairs(events: readonly TranscriptEvent[]): void {
  const projectedUses: string[] = [];
  const projectedResults: string[] = [];
  const seenProjectedUses = new Set<string>();
  const seenProjectedResults = new Set<string>();
  const projectedPending: string[] = [];

  for (const message of Transcript.eventsToMessages(events)) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const uses = blocks.filter((block) => block.type === "tool_use");
    const results = blocks.filter((block) => block.type === "tool_result");

    if (projectedPending.length > 0) {
      if (message.role !== "user" || results.length !== blocks.length || results.length === 0) {
        throw new SessionError(
          `Fork provider history inserts a message before pending tool results`,
        );
      }
    } else if (results.length > 0) {
      throw new SessionError(`Fork provider history contains an orphaned tool result`);
    }

    if (uses.length > 0) {
      if (message.role !== "assistant" || results.length > 0) {
        throw new SessionError(`Fork provider history contains tool use blocks in an invalid role`);
      }
      for (const block of uses) {
        const id = block.id;
        if (typeof id !== "string" || !id) {
          throw new SessionError(`Fork provider history contains a tool use without id`);
        }
        if (seenProjectedUses.has(id)) {
          throw new SessionError(`Fork provider history contains duplicate tool use ${id}`);
        }
        seenProjectedUses.add(id);
        projectedUses.push(id);
        projectedPending.push(id);
      }
    }

    for (const block of results) {
      const id = block.tool_use_id;
      if (typeof id !== "string" || !id) {
        throw new SessionError(`Fork provider history contains a tool result without id`);
      }
      if (seenProjectedResults.has(id)) {
        throw new SessionError(`Fork provider history contains duplicate tool result ${id}`);
      }
      const expected = projectedPending.shift();
      if (!expected) {
        throw new SessionError(`Fork provider history contains an orphaned tool result (${id})`);
      }
      if (expected !== id) {
        throw new SessionError(
          `Fork provider history tool result order mismatch: expected ${expected}, received ${id}`,
        );
      }
      seenProjectedResults.add(id);
      projectedResults.push(id);
    }
  }
  if (projectedPending.length > 0) {
    throw new SessionError(
      `Fork cursor splits an unfinished tool round in provider history (${projectedPending[0]})`,
    );
  }

  const metadataUses: string[] = [];
  const metadataResults: string[] = [];
  const seenMetadataUses = new Set<string>();
  const seenMetadataResults = new Set<string>();
  const metadataPending: string[] = [];
  for (const event of events) {
    if (event.type !== "tool_use" && event.type !== "tool_result") continue;
    const id = event.data.toolCallId;
    if (typeof id !== "string" || !id) {
      throw new SessionError(`Fork snapshot contains a tool event without toolCallId`);
    }
    if (event.type === "tool_use") {
      if (seenMetadataUses.has(id)) {
        throw new SessionError(`Fork snapshot contains duplicate tool use metadata ${id}`);
      }
      seenMetadataUses.add(id);
      metadataUses.push(id);
      metadataPending.push(id);
      continue;
    }
    if (seenMetadataResults.has(id)) {
      throw new SessionError(`Fork snapshot contains duplicate tool result metadata ${id}`);
    }
    const expected = metadataPending.shift();
    if (!expected) {
      throw new SessionError(`Fork snapshot contains tool result metadata before use (${id})`);
    }
    if (expected !== id) {
      throw new SessionError(
        `Fork snapshot tool metadata order mismatch: expected ${expected}, received ${id}`,
      );
    }
    seenMetadataResults.add(id);
    metadataResults.push(id);
  }
  if (metadataPending.length > 0) {
    throw new SessionError(`Fork cursor splits unfinished tool metadata (${metadataPending[0]})`);
  }

  const sameIds = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((id, index) => id === right[index]);
  if (!sameIds(projectedUses, metadataUses) || !sameIds(projectedResults, metadataResults)) {
    throw new SessionError(`Fork tool metadata does not match provider history`);
  }
}
