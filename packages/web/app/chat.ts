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
