// packages/web/app/chat.ts
//
// Transcript replay + title helpers for the standalone SPA. Live stream
// folding is handled by the shared reducer in ../src/lib/streamReducer —
// do NOT reintroduce a local fold here.
import {
  initialChatState,
  reduceStream,
  type ChatItem,
  type ChatState,
} from "../src/lib/streamReducer.js";
import { replayTranscript } from "../src/lib/transcriptReplay.js";
import type { HubStreamCursor, SessionDetailData, StreamEventPayload } from "./protocol.js";
import type { OutputJournalOptions, OutputJournalPage } from "@cjhyy/code-shell-core/internal";
import {
  applyOutputJournalPage,
  compareOutputCursors,
  type OutputJournalRecovery,
} from "../src/lib/outputJournalRecovery.js";

export { initialChatState, type ChatItem, type ChatState };

export { replayTranscript as chatFromTranscript } from "../src/lib/transcriptReplay.js";

export function sessionIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("session");
  return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function isNewStreamEvent(
  event: StreamEventPayload,
  cursor?: HubStreamCursor | null,
): boolean {
  if (!cursor || !event.hubEpoch || event.hubSequence === undefined) return true;
  return event.hubEpoch === cursor.epoch && event.hubSequence > cursor.sequence;
}

/** The host's durable prefix and active stream are a single atomic snapshot.
 * Buffered notifications at or before its cursor are already represented. */
export function chatFromSnapshot(
  data: SessionDetailData,
  buffered: StreamEventPayload[] = [],
): {
  chat: ChatState;
  cursor?: HubStreamCursor;
  truncated: boolean;
} {
  let chat = replayTranscript(data.transcript);
  for (const item of data.liveStream?.events ?? []) chat = reduceStream(chat, item.event);
  if (data.running) chat = { ...chat, run: "running" };
  else if (data.running === false && (chat.run === "running" || chat.run === "waiting"))
    chat = { ...chat, run: "idle" };
  let cursor = data.streamCursor;
  for (const payload of buffered) {
    if (!isNewStreamEvent(payload, cursor)) continue;
    chat = reduceStream(chat, payload.event);
    if (payload.hubEpoch && payload.hubSequence !== undefined)
      cursor = { epoch: payload.hubEpoch, sequence: payload.hubSequence };
  }
  return { chat, cursor, truncated: data.liveStream?.truncated ?? false };
}

/** Existing Hub recovery, with an exact legacy anchor and durable stream pages. */
export async function chatFromOutputJournal(
  data: SessionDetailData,
  read: (options: OutputJournalOptions) => Promise<OutputJournalPage>,
  buffered: StreamEventPayload[],
  latestOutputCursor?: () => string | undefined,
): Promise<{ chat: ChatState; outputCursor: string } | null> {
  let page = data.outputJournal ?? (await read({}));
  if (page.status === "unavailable") return null;
  if (
    page.status !== "ok" ||
    !page.legacyBaseThroughEventId ||
    data.transcript[0]?.type !== "session_meta"
  )
    throw new Error("Output recovery has no complete legacy base");
  const anchor = data.transcript.findIndex((event) => event.id === page.legacyBaseThroughEventId);
  if (anchor < 0) throw new Error("Output recovery legacy anchor was not retained");
  let chat = replayTranscript(data.transcript.slice(0, anchor + 1));
  let state: OutputJournalRecovery = { incomplete: false };
  let pages = 0;
  const fold = async () => {
    while (true) {
      if (++pages > 2048) throw new Error("Output recovery exceeded its page budget");
      const complete = applyOutputJournalPage(state, page, (event) => {
        chat = reduceStream(chat, event);
      });
      if (state.incomplete) throw new Error("Output recovery is incomplete");
      if (complete) break;
      page = await read({ after: state.cursor, through: state.through });
    }
  };
  await fold();
  // Notifications may exceed the Host's RAM window during pagination. The
  // latest retained durable cursor freezes another exact prefix; the log fills
  // every intervening record, rather than replaying an arbitrary buffered tail.
  for (let round = 0; round < 8; round++) {
    const latest =
      latestOutputCursor?.() ??
      [...buffered].reverse().find((payload) => typeof payload.event.outputCursor === "string")
        ?.event.outputCursor;
    if (typeof latest !== "string") break;
    const order = compareOutputCursors(latest, state.cursor!);
    if (order === undefined) throw new Error("Output recovery journal changed");
    if (order <= 0) break;
    if (round === 7) throw new Error("Output recovery could not catch up within its round budget");
    state = { incomplete: false, cursor: state.appliedCursor };
    page = await read({ after: state.cursor, through: latest });
    await fold();
  }
  for (const payload of buffered) {
    const value = payload.event.outputCursor;
    if (typeof value === "string") {
      const order = compareOutputCursors(value, state.cursor!);
      if (order === undefined) throw new Error("Output recovery journal changed");
      if (order <= 0) continue;
      state.cursor = value;
    } else if (payload.event.type === "session_title") {
      chat = reduceStream(chat, payload.event);
      continue;
    } else if (
      payload.event.type === "session_user_message" &&
      typeof payload.event.clientMessageId === "string" &&
      chat.items.some(
        (item) => item.kind === "user" && item.clientMessageId === payload.event.clientMessageId,
      )
    )
      continue;
    else throw new Error("Output recovery received an unpaired legacy event");
    chat = reduceStream(chat, payload.event);
  }
  return { chat, outputCursor: state.cursor! };
}

/** Session-rail title: reducer-pushed title, else first user line, else id. */
export function sessionTitle(state: ChatState | undefined, sessionId: string): string {
  if (state?.title) return state.title;
  const firstUser = state?.items.find((item) => item.kind === "user");
  if (firstUser && firstUser.kind === "user" && firstUser.text.trim()) {
    const line = firstUser.text.trim().split("\n")[0];
    return line.length > 32 ? `${line.slice(0, 32)}…` : line;
  }
  if (firstUser?.kind === "user" && firstUser.attachments?.length)
    return `附件：${firstUser.attachments[0].name}`;
  return sessionId.slice(0, 8);
}
