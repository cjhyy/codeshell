import type { MobileServerEvent } from "@cjhyy/code-shell-core";
import type { OutputJournalOptions } from "@cjhyy/code-shell-core/internal";
import {
  applyOutputJournalPage,
  compareOutputCursors,
  type OutputJournalRecovery,
} from "./outputJournalRecovery.js";
import { assertOutputCoverage } from "./outputCoverage.js";
import { initialChatState, reduceStream } from "./streamReducer.js";

type Reply = Extract<MobileServerEvent, { type: "session.outputJournal" }>;
type BaseReply = Extract<MobileServerEvent, { type: "session.legacyBase" }>;
export type MobileLegacyBaseOptions =
  | { throughEventId: string; cursor?: never }
  | { cursor: string; throughEventId?: never };
const MiB = 1024 * 1024;
const wireBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
const BASE_EVENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  session_started: ["type", "sessionId"],
  stream_request_start: ["type", "agentId"],
  assistant_message: ["type", "agentId"],
  text_delta: ["type", "text", "agentId"],
  thinking_delta: ["type", "text", "agentId"],
  user_message: ["type", "text", "attachments", "clientMessageId"],
  tool_use_start: ["type", "toolCall", "agentId"],
  tool_use_args_delta: ["type", "toolCallId", "args", "agentId"],
  tool_result: ["type", "result", "agentId"],
  agent_start: ["type", "agentId", "name", "description", "status"],
  error: ["type", "error"],
  turn_complete: ["type", "reason"],
};
/** Only the display projection's event schema is accepted on this new wire path. */
function baseEvent(value: unknown, sessionId: string): value is Record<string, unknown> {
  if (
    !record(value) ||
    typeof value.type !== "string" ||
    !Object.hasOwn(BASE_EVENT_KEYS, value.type) ||
    !onlyKeys(value, BASE_EVENT_KEYS[value.type]) ||
    (value.agentId !== undefined && typeof value.agentId !== "string")
  )
    return false;
  switch (value.type) {
    case "session_started":
      return value.sessionId === sessionId;
    case "stream_request_start":
    case "assistant_message":
      return true;
    case "text_delta":
    case "thinking_delta":
      return typeof value.text === "string";
    case "user_message":
      return (
        typeof value.text === "string" &&
        (value.clientMessageId === undefined || typeof value.clientMessageId === "string") &&
        (value.attachments === undefined ||
          (Array.isArray(value.attachments) &&
            value.attachments.every(
              (item) =>
                record(item) &&
                onlyKeys(item, ["name", "size", "mime", "path"]) &&
                typeof item.name === "string" &&
                Number.isSafeInteger(item.size) &&
                (item.size as number) >= 0 &&
                ["mime", "path"].every(
                  (key) => item[key] === undefined || typeof item[key] === "string",
                ),
            )))
      );
    case "tool_use_start":
      return (
        record(value.toolCall) &&
        onlyKeys(value.toolCall, ["id", "toolName", "args"]) &&
        typeof value.toolCall.id === "string" &&
        !!value.toolCall.id &&
        typeof value.toolCall.toolName === "string" &&
        record(value.toolCall.args)
      );
    case "tool_use_args_delta":
      return typeof value.toolCallId === "string" && !!value.toolCallId && record(value.args);
    case "tool_result":
      return (
        record(value.result) &&
        onlyKeys(value.result, ["id", "result", "isError", "error"]) &&
        typeof value.result.id === "string" &&
        !!value.result.id &&
        typeof value.result.result === "string" &&
        typeof value.result.isError === "boolean" &&
        (value.result.error === undefined || typeof value.result.error === "string")
      );
    case "agent_start":
      return (
        typeof value.agentId === "string" &&
        !!value.agentId &&
        typeof value.name === "string" &&
        typeof value.description === "string" &&
        value.status === "recorded"
      );
    case "error":
      return typeof value.error === "string";
    case "turn_complete":
      return value.reason === "aborted_tools";
    default:
      return false;
  }
}
/** Valid identities may arrive before their new Core Run acquires a durable anchor. */
export class MobilePendingInput extends Error {
  constructor(readonly ids: string[]) {
    super("Recovery input has no recorded anchor");
  }
}

/** No journal has ever been published by this explicitly journal-owned producer. */
export class MobileAwaitingJournal extends Error {
  constructor() {
    super("Awaiting the first durable output cursor");
  }
}

/** Verified pages progressed, but the observed live head kept moving within the bound. */
export class MobileOutputCatchupPending extends Error {
  constructor(
    readonly cursor: string,
    readonly resume: () => Promise<MobileOutputRecoveryResult>,
  ) {
    super("Recovery could not catch up within its bound");
  }
}

type MobileOutputRecoveryResult = {
  chat: ReturnType<typeof initialChatState>;
  outputCursor: string;
  snapshot: NonNullable<Reply["snapshot"]>;
};

/** Build a private candidate, then join its frozen prefix to an actual Main snapshot. */
export async function recoverMobileOutput(args: {
  read: (options: OutputJournalOptions) => Promise<Reply>;
  /** Supplied only after an implementing host explicitly advertises the capability. */
  readBase?: (options: MobileLegacyBaseOptions) => Promise<BaseReply>;
  canContinue: () => boolean;
  latestCursor: () => string | undefined;
  requireJournal?: boolean;
}) {
  let reply = await args.read({});
  if (!args.canContinue()) throw new Error("Recovery cancelled");
  if (reply.page.status === "unavailable") {
    const snapshot = reply.snapshot;
    assertOutputCoverage(
      { unpaired: snapshot?.unpaired, inputIds: snapshot?.inputIds },
      {},
      () => true,
    );
    if (snapshot?.journalIdentity && !snapshot.outputCursor && !args.latestCursor())
      throw new Error("Required output journal is unavailable");
    // Valid live input may precede the first canonical Run. Preserve its typed
    // retry; an already observed cursor instead requires the real reread below.
    if (snapshot?.inputIds?.length && !snapshot.outputCursor && !args.latestCursor())
      throw new MobilePendingInput(snapshot.inputIds);
  }
  if (
    reply.page.status === "unavailable" &&
    (args.requireJournal || reply.snapshot?.outputCursor || args.latestCursor())
  ) {
    const snapshot = reply.snapshot;
    if (
      !snapshot ||
      snapshot.unpaired ||
      !snapshot.epoch ||
      !Number.isSafeInteger(snapshot.nextSeq) ||
      snapshot.nextSeq < 1
    )
      throw new Error("Required output journal is unavailable");
    if (snapshot.outputCursor || args.latestCursor()) {
      // The first canonical commit may happen after Main's unavailable read
      // but before its snapshot/live reply. Re-read once, requiring real proof.
      reply = await args.read({});
      if (!args.canContinue()) throw new Error("Recovery cancelled");
      if (reply.page.status === "unavailable")
        throw new Error("Required output journal is unavailable");
    } else throw new MobileAwaitingJournal();
  }
  if (reply.page.status === "unavailable") return null;

  let chat = initialChatState();
  let pages = 0;
  if (reply.page.status === "ok" && reply.legacyBaseComplete === false && args.readBase) {
    const throughEventId = reply.page.legacyBaseThroughEventId;
    if (typeof throughEventId !== "string" || !throughEventId || throughEventId.length > 512)
      throw new Error("Recovery base is incomplete");
    const cursors = new Set<string>();
    let cursor: string | undefined,
      index = 0,
      bytes = 0;
    for (let count = 0; ; count++) {
      if (!args.canContinue() || count >= 40 || ++pages > 2048)
        throw new Error("Recovery base cancelled or bounded");
      const base = await args.readBase(cursor ? { cursor } : { throughEventId });
      if (!args.canContinue()) throw new Error("Recovery cancelled");
      const size = wireBytes(base);
      bytes += size;
      if (
        !record(base) ||
        !onlyKeys(base, [
          "type",
          "sessionId",
          "recoveryId",
          "requestId",
          "ok",
          "throughEventId",
          "index",
          "events",
          "complete",
          "next",
        ]) ||
        base.type !== "session.legacyBase" ||
        typeof base.requestId !== "string" ||
        !base.requestId ||
        base.requestId.length > 128 ||
        base.ok !== true ||
        base.sessionId !== reply.sessionId ||
        base.recoveryId !== reply.recoveryId ||
        base.throughEventId !== throughEventId ||
        !Number.isSafeInteger(base.index) ||
        base.index !== index ||
        !Array.isArray(base.events) ||
        !base.events.length ||
        !base.events.every((event) => baseEvent(event, reply.sessionId)) ||
        (index === 0 && base.events[0].type !== "session_started") ||
        base.events.some(
          (event, offset) => event.type === "session_started" && index + offset !== 0,
        ) ||
        size > MiB + 4096 ||
        bytes > 32 * MiB + 40 * 4096 ||
        typeof base.complete !== "boolean" ||
        (base.complete
          ? base.next !== undefined
          : typeof base.next !== "string" ||
            !base.next ||
            base.next.length > 2048 ||
            cursors.has(base.next))
      )
        throw new Error("Recovery base is incomplete or exceeds its bound");
      for (const event of base.events) chat = reduceStream(chat, event);
      index += base.events.length;
      if (base.complete) break;
      cursor = base.next;
      cursors.add(cursor);
    }
  } else {
    if (
      reply.page.status !== "ok" ||
      !reply.legacyBaseComplete ||
      !reply.legacyBase ||
      !Array.isArray(reply.legacyBase.events) ||
      reply.legacyBase.events[0]?.type !== "session_started" ||
      reply.legacyBase.throughEventId !== reply.page.legacyBaseThroughEventId ||
      wireBytes(reply.legacyBase) > MiB + 4096
    )
      throw new Error("Recovery base is incomplete");
    for (const event of reply.legacyBase.events) chat = reduceStream(chat, event);
  }
  // A legacy transcript establishes display history, never live completion.
  chat = { ...chat, run: chat.run === "error" ? "error" : "idle", liveByAgent: {} };
  let recovery: OutputJournalRecovery = { incomplete: false };
  // A continuation retains the verified private candidate and the same total
  // page budget. No prefix is published until the eventual frozen join passes.
  const advance = async (): Promise<MobileOutputRecoveryResult> => {
    for (let round = 0; round < 8; round++) {
      while (true) {
        if (!args.canContinue() || ++pages > 2048) throw new Error("Recovery cancelled or bounded");
        const complete = applyOutputJournalPage(recovery, reply.page, (event) => {
          chat = reduceStream(chat, event);
        });
        if (recovery.incomplete) throw new Error("Recovery is incomplete");
        if (complete) break;
        reply = await args.read({ after: recovery.cursor, through: recovery.through });
      }
      if (!args.canContinue()) throw new Error("Recovery cancelled");
      const snapshot = reply.snapshot;
      if (
        !snapshot ||
        snapshot.unpaired ||
        !snapshot.epoch ||
        !Number.isSafeInteger(snapshot.nextSeq) ||
        snapshot.nextSeq < 1
      )
        throw new Error("Recovery snapshot is unpaired");
      assertOutputCoverage({ ...snapshot, inputIds: undefined }, reply.page, () => true);
      let target = recovery.cursor!;
      for (const value of [snapshot.outputCursor, args.latestCursor()]) {
        if (value === undefined) continue;
        const order = compareOutputCursors(value, target);
        if (order === undefined) throw new Error("Recovery identity changed");
        if (order > 0) target = value;
      }
      if (target === recovery.cursor) {
        const ids = snapshot.inputIds;
        if (
          ids !== undefined &&
          (!Array.isArray(ids) ||
            ids.length > 128 ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 512))
        )
          throw new Error("Recovery input identity is unpaired");
        const missing = ids?.filter(
          (id) => !chat.items.some((item) => item.kind === "user" && item.clientMessageId === id),
        );
        if (missing?.length) throw new MobilePendingInput(missing);
        assertOutputCoverage(snapshot, reply.page, (id) =>
          chat.items.some((item) => item.kind === "user" && item.clientMessageId === id),
        );
        return { chat, outputCursor: recovery.cursor!, snapshot };
      }
      recovery = { incomplete: false, cursor: recovery.appliedCursor };
      reply = await args.read({ after: recovery.cursor, through: target });
    }
    throw new MobileOutputCatchupPending(recovery.cursor!, advance);
  };
  return advance();
}
