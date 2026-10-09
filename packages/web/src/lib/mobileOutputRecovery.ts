import type { MobileServerEvent } from "@cjhyy/code-shell-core";
import type { OutputJournalOptions } from "@cjhyy/code-shell-core/internal";
import {
  applyOutputJournalPage,
  compareOutputCursors,
  type OutputJournalRecovery,
} from "./outputJournalRecovery.js";
import { initialChatState, reduceStream } from "./streamReducer.js";

type Reply = Extract<MobileServerEvent, { type: "session.outputJournal" }>;
/** Valid identities may arrive before their new Core Run acquires a durable anchor. */
export class MobilePendingInput extends Error {
  constructor(readonly ids: string[]) {
    super("Recovery input has no recorded anchor");
  }
}

/** Build a private candidate, then join its frozen prefix to an actual Main snapshot. */
export async function recoverMobileOutput(args: {
  read: (options: OutputJournalOptions) => Promise<Reply>;
  canContinue: () => boolean;
  latestCursor: () => string | undefined;
}) {
  let reply = await args.read({});
  if (!args.canContinue()) throw new Error("Recovery cancelled");
  if (reply.page.status === "unavailable") return null;
  if (
    reply.page.status !== "ok" ||
    !reply.legacyBaseComplete ||
    !reply.legacyBase ||
    !Array.isArray(reply.legacyBase.events) ||
    reply.legacyBase.events[0]?.type !== "session_started" ||
    reply.legacyBase.throughEventId !== reply.page.legacyBaseThroughEventId ||
    new TextEncoder().encode(JSON.stringify(reply.legacyBase)).length > 1024 * 1024 + 4096
  )
    throw new Error("Recovery base is incomplete");
  let chat = initialChatState();
  for (const event of reply.legacyBase.events) chat = reduceStream(chat, event);
  // A legacy transcript establishes display history, never live completion.
  chat = { ...chat, run: chat.run === "error" ? "error" : "idle", liveByAgent: {} };
  let recovery: OutputJournalRecovery = { incomplete: false };
  let pages = 0;
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
      return { chat, outputCursor: recovery.cursor!, snapshot };
    }
    recovery = { incomplete: false, cursor: recovery.appliedCursor };
    reply = await args.read({ after: recovery.cursor, through: target });
  }
  throw new Error("Recovery could not catch up within its bound");
}
