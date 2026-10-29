import type { StreamEvent, TranscriptEvent } from "../types.js";
import type { OutputHistoryComparison } from "../protocol/output-history-recovery-types.js";
import { outputUserMessage } from "../engine/run-output-user-message.js";

type RecordValue = Record<string, any>;
type Tool = { id: string; name: string; args: unknown };
type Result = {
  id: string;
  name: string;
  result?: string;
  error?: string;
  contentBlocks?: unknown;
};
type Segment = {
  user: unknown;
  inputIndex?: number;
  failedInput?: StreamEvent;
  hiddenInitializationFailure?: boolean;
  assistant: string;
  tools: Map<string, Tool>;
  results: Map<string, Result>;
  blocks: Map<string, Tool>;
  errors: string[];
  errorAnchors: Array<{ text: number; tools: string[]; results: string[] }>;
  stopped: number;
  closed: boolean;
};
export interface NativeOutputHistoryOptions {
  /** Supplied by the caller from the verified journal header, never by a client. */
  legacyBaseThroughEventId?: string;
  /** From the same hash-bound state.json as the comparison sources. */
  terminalStatus?: string;
}
export type NativeOutputHistoryComparison =
  | { ok: true; comparison: OutputHistoryComparison; checkpointEvents?: StreamEvent[] }
  | { ok: false; reason: "history_mismatch" | "unsupported_history" };

const terminalReasons = new Set([
  "completed",
  "stop_hook_prevented",
  "hook_stopped",
  "prompt_too_long",
  "model_error",
  "replay_incomplete",
  "unverified_write",
  "batch_incomplete",
  "aborted_streaming",
  "aborted_tools",
  "max_turns",
  "goal_budget_exhausted",
  "image_error",
]);
// These are retained verbatim in the journal. They do not replace chat/tool records.
const observations = new Set([
  "session_started",
  "stream_request_start",
  "usage_update",
  "memory_recalled",
  "goal_set",
  "goal_updated",
  "goal_cleared",
  "goal_progress",
  "task_update",
  "agent_start",
  "agent_end",
  "agent_backgrounded",
  "background_agent_completed",
  "turn_diff",
  "session_title",
  "thinking_delta",
  "assistant_message",
  "tool_summary",
]);
const object = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
const canonical = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, item) =>
    object(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const projection = (event: RecordValue) => ({
  sessionId: event.sessionId,
  text: event.text,
  clientMessageId: event.clientMessageId,
  injected: event.injected,
  authority: event.authority,
  transcriptMessage: event.transcriptMessage,
});
function segment(user: unknown): Segment {
  return {
    user,
    assistant: "",
    tools: new Map(),
    results: new Map(),
    blocks: new Map(),
    errors: [],
    errorAnchors: [],
    stopped: 0,
    closed: false,
  };
}
function tool(id: unknown, name: unknown, args: unknown): Tool {
  if (typeof id !== "string" || !id || typeof name !== "string" || !name || !object(args))
    throw Error();
  return { id, name, args };
}
function result(id: unknown, name: unknown, value: RecordValue): Result {
  if (
    typeof id !== "string" ||
    !id ||
    typeof name !== "string" ||
    !name ||
    (value.result !== undefined && typeof value.result !== "string") ||
    (value.error !== undefined && typeof value.error !== "string") ||
    (value.contentBlocks !== undefined && !Array.isArray(value.contentBlocks))
  )
    throw Error();
  return { id, name, result: value.result, error: value.error, contentBlocks: value.contentBlocks };
}
function put<T>(map: Map<string, T>, id: string, value: T): void {
  if (map.has(id)) throw Error();
  map.set(id, value);
}
function sameMap<T>(left: Map<string, T>, right: Map<string, T>): boolean {
  return (
    left.size === right.size &&
    [...left].every(([id, value]) => right.has(id) && equal(value, right.get(id)))
  );
}
function paired(value: Segment): boolean {
  return (
    value.tools.size === value.results.size &&
    [...value.tools].every(([id, call]) => value.results.get(id)?.name === call.name)
  );
}

/**
 * Compare known durable display formats, independently of provider labels.
 * Native turn_boundary is a model step; turn_complete closes a Run. Group by
 * input instead, retaining every byte of assistant text and every tool identity.
 * The caller must first verify the complete journal chain and stable source files.
 */
export function compareNativeOutputHistory(
  transcript: TranscriptEvent[],
  events: StreamEvent[],
  sessionId: string,
  cwd: string,
  options: NativeOutputHistoryOptions = {},
): NativeOutputHistoryComparison {
  const unsupported = (): NativeOutputHistoryComparison => ({
    ok: false,
    reason: "unsupported_history",
  });
  const mismatch = (): NativeOutputHistoryComparison => ({ ok: false, reason: "history_mismatch" });
  try {
    if (
      !transcript.length ||
      !events.length ||
      transcript[0].type !== "session_meta" ||
      transcript[0].data.sessionId !== sessionId
    )
      return unsupported();
    const identities = new Set<string>();
    for (const item of transcript) {
      if (
        !object(item.data) ||
        typeof item.id !== "string" ||
        !item.id ||
        identities.has(item.id) ||
        !Number.isFinite(item.timestamp) ||
        !Number.isSafeInteger(item.turnNumber) ||
        item.turnNumber < 0
      )
        return unsupported();
      identities.add(item.id);
    }
    const cutover =
      options.legacyBaseThroughEventId === undefined
        ? 0
        : transcript.findIndex((event) => event.id === options.legacyBaseThroughEventId);
    if (
      cutover < 0 ||
      !["session_meta", "turn_boundary", "turn_stopped", "run_result"].includes(
        transcript[cutover].type,
      )
    )
      return unsupported();
    const recorded: Segment[] = [],
      prefix: Segment[] = [];
    let current: Segment | undefined,
      turns = 0;
    const boundaries = new Set<string>();
    const subagents = new Map<string, unknown>();
    for (let index = 1; index < transcript.length; index++) {
      const event = transcript[index],
        data = event.data as RecordValue;
      if (index === cutover + 1 && cutover > 0) {
        if (current && !current.closed) return unsupported();
        current = undefined;
      }
      const target = index <= cutover ? prefix : recorded;
      if (event.type === "message" && data.role === "user") {
        if (current && !current.closed) return unsupported();
        if (
          (typeof data.content !== "string" && !Array.isArray(data.content)) ||
          (data.clientMessageId !== undefined &&
            (typeof data.clientMessageId !== "string" || !data.clientMessageId)) ||
          (data.injected !== undefined && typeof data.injected !== "boolean") ||
          (data.authority !== undefined &&
            !["user", "agent", "system", "policy"].includes(data.authority)) ||
          (Array.isArray(data.content) &&
            data.content.some(
              (block) =>
                !object(block) ||
                !(
                  (block.type === "text" && typeof block.text === "string") ||
                  (block.type === "image" &&
                    object(block.source) &&
                    block.source.type === "base64" &&
                    typeof block.source.media_type === "string" &&
                    typeof block.source.data === "string")
                ),
            ))
        )
          return unsupported();
        current = segment(projection(outputUserMessage(data, sessionId, cwd)));
        current.inputIndex = index;
        target.push(current);
        continue;
      }
      if (!current) return unsupported();
      switch (event.type) {
        case "message":
          if (data.role !== "assistant") return unsupported();
          current.closed = false;
          if (typeof data.content === "string") current.assistant += data.content;
          else if (Array.isArray(data.content))
            for (const block of data.content) {
              if (block.type === "text" && typeof block.text === "string")
                current.assistant += block.text;
              else if (block.type === "tool_use") {
                const call = tool(block.id, block.name, block.input);
                put(current.blocks, call.id, call);
              } else return unsupported();
            }
          else return unsupported();
          break;
        case "tool_use": {
          const call = tool(data.toolCallId, data.toolName, data.args);
          put(current.tools, call.id, call);
          current.closed = false;
          break;
        }
        case "tool_result": {
          const value = result(data.toolCallId, data.toolName, data);
          put(current.results, value.id, value);
          current.closed = false;
          break;
        }
        case "turn_boundary":
          current.closed = true;
          turns++;
          break;
        case "turn_stopped":
          current.closed = true;
          current.stopped++;
          break;
        case "error":
          if (typeof data.error !== "string") return unsupported();
          current.errorAnchors.push({
            text: current.assistant.length,
            tools: [...current.tools.keys()],
            results: [...current.results.keys()],
          });
          current.errors.push(data.error);
          // buildRunFailureResult persists terminal status before this exact
          // initialization error. Hidden internal input has no client receipt.
          if (
            index === transcript.length - 1 &&
            index === (current.inputIndex ?? -100) + 1 &&
            data.phase === "initialization" &&
            options.terminalStatus === "model_error" &&
            (current.user as RecordValue).injected === true &&
            !current.assistant &&
            !current.tools.size &&
            !current.results.size &&
            !current.blocks.size
          ) {
            current.hiddenInitializationFailure = true;
            current.closed = true;
          }
          break;
        case "run_result": {
          const receipt = data.result;
          if (
            !object(receipt) ||
            receipt.sessionId !== sessionId ||
            !terminalReasons.has(receipt.reason) ||
            typeof receipt.text !== "string" ||
            !Number.isSafeInteger(receipt.turnCount) ||
            receipt.turnCount < 0 ||
            typeof data.clientMessageId !== "string" ||
            !target.some(
              (part) => (part.user as RecordValue).clientMessageId === data.clientMessageId,
            )
          )
            return unsupported();
          if (
            receipt.reason === "model_error" &&
            data.clientMessageId === (current.user as RecordValue).clientMessageId &&
            index === (current.inputIndex ?? -100) + 2 &&
            transcript[index - 1].type === "error" &&
            current.errors.length === 1 &&
            !current.assistant &&
            !current.tools.size &&
            !current.results.size &&
            !(current.user as RecordValue).injected &&
            (current.user as RecordValue).authority !== "agent" &&
            (current.user as RecordValue).authority !== "system" &&
            (current.user as RecordValue).authority !== "policy"
          )
            current.failedInput = outputUserMessage(
              transcript[current.inputIndex!].data,
              sessionId,
              cwd,
            );
          // A delayed receipt for an earlier input cannot close a newer,
          // unfinished input. Goal continuations already have model boundaries.
          current.closed ||= (current.user as RecordValue).clientMessageId === data.clientMessageId;
          break;
        }
        case "model_request_boundary":
          if (data.version !== 1 || typeof data.logicalCallId !== "string") return unsupported();
          boundaries.add(event.id);
          break;
        case "model_request_attempt":
          if (
            data.version !== 1 ||
            !boundaries.has(data.boundaryEventId) ||
            data.phase !== "before-fetch"
          )
            return unsupported();
          break;
        case "subagent":
          if (typeof data.agentId !== "string" || typeof data.description !== "string")
            return unsupported();
          put(subagents, data.agentId, {
            id: data.agentId,
            name: data.name,
            description: data.description,
          });
          break;
        default:
          return unsupported();
      }
    }
    const hiddenNote = (part: Segment) =>
      (part.user as RecordValue).injected === true &&
      !part.assistant &&
      !part.tools.size &&
      !part.results.size &&
      !part.errors.length &&
      !part.stopped;
    if (
      !recorded.length ||
      [...prefix, ...recorded].some(
        (part) => (!part.closed && !hiddenNote(part)) || !paired(part),
      ) ||
      prefix.some((part) => !sameMap(part.tools, part.blocks))
    )
      return unsupported();
    const additions = new Map<number, StreamEvent[]>();
    const insert = (index: number, event: StreamEvent) =>
      additions.set(index, [...(additions.get(index) ?? []), event]);
    const locations: Array<{
      start: number;
      end: number;
      terminal?: number;
      text: Array<[number, number]>;
      tools: Map<string, number>;
      results: Map<string, number>;
    }> = [];
    const published: Segment[] = [],
      deferredProjection: Map<string, Tool>[] = [],
      blockProjection: Map<string, Tool>[] = [];
    let live: Segment | undefined,
      deferred = new Map<string, Tool>(),
      committed = new Map<string, Tool>(),
      pendingBlocks = new Map<string, Tool>(),
      committedBlocks = new Map<string, Tool>();
    const commit = (id: string) => {
      const call = deferred.get(id);
      if (call) {
        put(committed, id, call);
        deferred.delete(id);
      }
    };
    const flush = () => {
      for (const id of deferred.keys()) commit(id);
    };
    const flushBlocks = () => {
      for (const [id, call] of pendingBlocks) put(committedBlocks, id, call);
      pendingBlocks.clear();
    };
    const agents = new Map<string, unknown>();
    const children = new Map<string, Segment>();
    for (const [eventIndex, raw] of events.entries()) {
      const event = raw as RecordValue;
      if (!object(event) || event.outputRecovery === "incomplete") return unsupported();
      if (event.type === "session_user_message") {
        if (event.sessionId !== sessionId || typeof event.text !== "string") return unsupported();
        // External Goal continuation suppresses the provider-only terminal frame,
        // but finish() still commits its deferred tool definitions at this boundary.
        flush();
        flushBlocks();
        if (locations.length) locations.at(-1)!.end = eventIndex;
        locations.push({
          start: eventIndex + 1,
          end: events.length,
          text: [[0, eventIndex + 1]],
          tools: new Map(),
          results: new Map(),
        });
        deferred = new Map();
        committed = new Map();
        pendingBlocks = new Map();
        committedBlocks = new Map();
        live = segment(projection(event));
        published.push(live);
        deferredProjection.push(committed);
        blockProjection.push(committedBlocks);
        continue;
      }
      if (event.type === "agent_start")
        put(agents, event.agentId, {
          id: event.agentId,
          name: event.name,
          description: event.description,
        });
      if (observations.has(event.type)) continue;
      if (event.agentId) {
        if (typeof event.agentId !== "string" || !subagents.has(event.agentId))
          return unsupported();
        let child = children.get(event.agentId);
        if (!child) {
          child = segment(undefined);
          children.set(event.agentId, child);
        }
        if (observations.has(event.type)) continue;
        switch (event.type) {
          case "tool_use_start": {
            if (!object(event.toolCall)) return unsupported();
            const call = tool(event.toolCall.id, event.toolCall.toolName, event.toolCall.args);
            put(child.tools, call.id, call);
            break;
          }
          case "tool_use_args_delta": {
            const call = child.tools.get(event.toolCallId);
            if (!call || !object(event.args)) return unsupported();
            child.tools.set(call.id, { ...call, args: event.args });
            break;
          }
          case "tool_result": {
            if (
              !object(event.result) ||
              (event.result.isError !== undefined && typeof event.result.isError !== "boolean")
            )
              return unsupported();
            const value = result(event.result.id, event.result.toolName, event.result);
            put(child.results, value.id, value);
            break;
          }
          case "text_delta":
          case "session_user_message":
            if (typeof event.text !== "string") return unsupported();
            break;
          case "error":
            if (typeof event.error !== "string") return unsupported();
            break;
          case "turn_complete":
            if (!terminalReasons.has(event.reason)) return unsupported();
            break;
          default:
            return unsupported();
        }
        continue;
      }
      if (observations.has(event.type)) continue;
      if (!live) return unsupported();
      switch (event.type) {
        case "text_delta":
          if (typeof event.text !== "string") return unsupported();
          flush();
          flushBlocks();
          live.assistant += event.text;
          locations.at(-1)!.text.push([live.assistant.length, eventIndex + 1]);
          live.closed = false;
          break;
        case "tool_use_start": {
          if (!object(event.toolCall)) return unsupported();
          const call = tool(event.toolCall.id, event.toolCall.toolName, event.toolCall.args);
          locations.at(-1)!.tools.set(call.id, eventIndex + 1);
          put(live.tools, call.id, call);
          put(deferred, call.id, call);
          put(pendingBlocks, call.id, call);
          live.closed = false;
          break;
        }
        case "tool_use_args_delta": {
          const call = live.tools.get(event.toolCallId);
          if (!call || !object(event.args)) return unsupported();
          live.tools.set(call.id, { ...call, args: event.args });
          if (deferred.has(call.id)) {
            deferred.set(call.id, { ...call, args: event.args });
            if (pendingBlocks.has(call.id))
              pendingBlocks.set(call.id, { ...call, args: event.args });
          }
          break;
        }
        case "tool_result": {
          if (
            !object(event.result) ||
            (event.result.isError !== undefined && typeof event.result.isError !== "boolean")
          )
            return unsupported();
          const value = result(event.result.id, event.result.toolName, event.result);
          commit(value.id);
          flushBlocks();
          locations.at(-1)!.results.set(value.id, eventIndex + 1);
          put(live.results, value.id, value);
          live.closed = false;
          break;
        }
        case "error":
          if (typeof event.error !== "string") return unsupported();
          live.errors.push(event.error);
          break;
        case "turn_complete":
          if (!terminalReasons.has(event.reason)) return unsupported();
          flush();
          flushBlocks();
          locations.at(-1)!.terminal = eventIndex;
          live.closed = true;
          if (event.reason === "aborted_streaming" || event.reason === "aborted_tools")
            live.stopped++;
          break;
        default:
          return unsupported();
      }
    }
    flush();
    flushBlocks();
    if (!published.at(-1)?.closed || [...children.values()].some((child) => !paired(child)))
      return mismatch();
    let publishedIndex = 0;
    for (const a of recorded) {
      const index = publishedIndex,
        b = published[index],
        location = locations[index];
      if (!b || !equal(a.user, b.user)) {
        if (hiddenNote(a)) continue;
        if (a.hiddenInitializationFailure && !b) {
          insert(events.length, { type: "error", error: a.errors[0] });
          insert(events.length, { type: "turn_complete", reason: "model_error" });
          continue;
        }
        if (!a.failedInput || !a.closed) return mismatch();
        const at = location ? location.start - 1 : events.length;
        insert(at, a.failedInput);
        insert(at, { type: "error", error: a.errors[0] });
        insert(at, { type: "turn_complete", reason: "model_error" });
        continue;
      }
      publishedIndex++;
      if (
        !equal(a.user, b.user) ||
        a.assistant !== b.assistant ||
        !(
          (sameMap(a.tools, b.tools) && sameMap(a.blocks, a.tools)) ||
          (sameMap(a.tools, deferredProjection[index]) && sameMap(a.blocks, blockProjection[index]))
        )
      )
        return mismatch();
      // The old external recorder closed unresolved calls durably in finish(),
      // but never emitted those fixed error results. Preserve the original
      // journal and insert only that exact, already paired canonical record.
      for (const [id, value] of a.results) {
        if (b.results.has(id)) continue;
        if (
          value.result !== undefined ||
          value.contentBlocks !== undefined ||
          value.error !== "External runtime turn ended before this tool returned a result." ||
          !b.tools.has(id)
        )
          return mismatch();
        insert(location.terminal ?? location.end, {
          type: "tool_result",
          result: {
            id,
            toolName: value.name,
            error: value.error,
            isError: true,
          },
        });
        b.results.set(id, value);
      }
      if (!sameMap(a.results, b.results) || !paired(b)) return mismatch();
      let observedError = 0;
      for (let errorIndex = 0; errorIndex < a.errors.length; errorIndex++) {
        const error = a.errors[errorIndex];
        if (b.errors[observedError] === error) {
          observedError++;
          continue;
        }
        const anchor = a.errorAnchors[errorIndex];
        const textPosition = location.text.find(([count]) => count === anchor.text)?.[1];
        if (textPosition === undefined) return mismatch();
        const toolPositions = anchor.tools.map((id) => location.tools.get(id));
        const resultPositions = anchor.results.map((id) => location.results.get(id));
        if ([...toolPositions, ...resultPositions].some((position) => position === undefined))
          return mismatch();
        const position = Math.max(
          textPosition,
          ...(toolPositions as number[]),
          ...(resultPositions as number[]),
        );
        if (position > location.end) return mismatch();
        insert(position, { type: "error", error });
      }
      if (observedError !== b.errors.length || a.stopped - b.stopped > 1) return mismatch();
      if (a.stopped > b.stopped) {
        // This is the established turn_stopped display projection; it neither
        // claims a successful run nor submits/stops any work.
        insert(location.end, { type: "turn_complete", reason: "aborted_tools" });
      }
    }
    if (publishedIndex !== published.length) return mismatch();
    if (
      [...subagents].some(([id, value]) => {
        const source = value as RecordValue,
          observed = agents.get(id) as RecordValue | undefined;
        // Native appendParentSubagent deliberately omits the UI name. The stable
        // identity and exact task description still bind forwarded child output.
        return (
          !observed ||
          observed.id !== source.id ||
          observed.description !== source.description ||
          (source.name !== undefined && observed.name !== source.name)
        );
      })
    )
      return mismatch();
    const checkpointEvents = additions.size
      ? events
          .flatMap((event, index) => [...(additions.get(index) ?? []), event])
          .concat(additions.get(events.length) ?? [])
      : undefined;
    return {
      ok: true,
      ...(checkpointEvents ? { checkpointEvents } : {}),
      comparison: {
        turns,
        userInputs: prefix.length + recorded.length,
        toolCalls: [...prefix, ...recorded].reduce(
          (sum, part) => sum + part.tools.size,
          [...children.values()].reduce((n, child) => n + child.tools.size, 0),
        ),
        toolResults: [...prefix, ...recorded].reduce(
          (sum, part) => sum + part.results.size,
          [...children.values()].reduce((n, child) => n + child.results.size, 0),
        ),
      },
    };
  } catch {
    return unsupported();
  }
}
