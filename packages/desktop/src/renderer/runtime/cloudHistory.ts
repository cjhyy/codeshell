import type { OutputJournalOptions, OutputJournalPage } from "@cjhyy/code-shell-core/internal";
import {
  applyOutputJournalPage,
  assertOutputCoverage,
  compareOutputCursors,
  OutputCoverage,
  transcriptToStreamEvents,
  type OutputJournalRecovery,
} from "@cjhyy/code-shell-web";
import type { RendererStreamEvent } from "../../preload/types";
import { applyTranscriptStreamEvent } from "../transcripts";
import {
  appendUserMessage,
  INITIAL_STATE,
  type MessagesReducerState,
  type AssistantMessage,
} from "../types";

export interface CloudStreamPayload {
  sessionId: string;
  event: Record<string, unknown>;
  hubEpoch?: string;
  hubSequence?: number;
}
export interface CloudStreamCursor {
  epoch: string;
  sequence: number;
}
export interface CloudCoverage {
  unpaired: boolean;
  inputIds: string[];
  incarnation?: string;
  journalIdentity?: string;
  outputCursor?: string;
  streamCursor?: CloudStreamCursor;
}
export interface CloudSessionDetail {
  transcript: Array<Record<string, unknown>>;
  running?: boolean;
  streamCursor?: CloudStreamCursor;
  liveStream?: {
    events: Array<{ sequence: number; event: Record<string, unknown> }>;
    truncated: boolean;
  };
  outputCoverage?: CloudCoverage;
  outputJournal?: OutputJournalPage;
  legacyBaseComplete?: boolean;
}

export function replayCloudTranscript(records: readonly unknown[]): MessagesReducerState {
  let state = INITIAL_STATE;
  // Shared durable-to-stream projection, folded by the native chat reducer.
  for (const event of transcriptToStreamEvents(records)) {
    if (event.type === "user_message") {
      state = appendUserMessage(
        state,
        String(event.text ?? ""),
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        typeof event.clientMessageId === "string" ? event.clientMessageId : undefined,
        Array.isArray(event.attachments)
          ? event.attachments.map((attachment) => ({
              kind: attachment.mime?.startsWith("image/") ? ("image" as const) : ("file" as const),
              path: attachment.path ?? "",
              absPath: "",
              sessionId: "",
              originalName: attachment.name,
              size: attachment.size ?? 0,
              ...(attachment.mime ? { mime: attachment.mime } : {}),
            }))
          : undefined,
      );
    } else {
      // Shared browser replay emits a payload-free assistant boundary. Native
      // finalization uses the completed text already accumulated by its reducer.
      const nativeEvent =
        event.type === "assistant_message"
          ? {
              ...event,
              message: {
                content:
                  state.messages.find(
                    (message): message is AssistantMessage =>
                      message.kind === "assistant" && message.id === state.streamingAssistantId,
                  )?.text ?? "",
              },
            }
          : event;
      state = applyTranscriptStreamEvent(
        state,
        nativeEvent as RendererStreamEvent,
        () => undefined,
      );
    }
  }
  return state;
}

export function newerCloudEvent(payload: CloudStreamPayload, cursor?: CloudStreamCursor): boolean {
  return (
    !cursor ||
    !payload.hubEpoch ||
    payload.hubSequence === undefined ||
    (payload.hubEpoch === cursor.epoch && payload.hubSequence > cursor.sequence)
  );
}

/** Recover the exact durable prefix before exposing a session as sendable. */
export async function hydrateCloudHistory(args: {
  detail: CloudSessionDetail;
  buffered: CloudStreamPayload[];
  read: (options: OutputJournalOptions) => Promise<OutputJournalPage>;
  coverage: () => Promise<CloudCoverage>;
  canContinue: () => boolean;
}): Promise<{ state: MessagesReducerState; cursor?: CloudStreamCursor }> {
  const { detail, buffered, canContinue } = args;
  let page = detail.outputJournal ?? (await args.read({}));
  if (!canContinue()) throw new Error("Cloud history selection changed");
  if (page.status === "unavailable") {
    const proof = detail.outputCoverage;
    assertOutputCoverage({ unpaired: proof?.unpaired, inputIds: proof?.inputIds }, {}, () => false);
    if (proof?.outputCursor || proof?.journalIdentity || buffered.some((p) => p.event.outputCursor))
      throw new Error("Cloud output journal is unavailable");
    if (detail.liveStream?.truncated) throw new Error("Cloud history is incomplete");
    let state = replayCloudTranscript(detail.transcript);
    for (const { event } of detail.liveStream?.events ?? [])
      state = applyTranscriptStreamEvent(state, event as RendererStreamEvent);
    let cursor = detail.streamCursor;
    for (const payload of buffered) {
      if (payload.hubEpoch && cursor && payload.hubEpoch !== cursor.epoch)
        throw new Error("Cloud history stream changed during recovery");
      if (!newerCloudEvent(payload, cursor)) continue;
      state = applyTranscriptStreamEvent(state, payload.event as RendererStreamEvent);
      if (payload.hubEpoch && payload.hubSequence !== undefined)
        cursor = { epoch: payload.hubEpoch, sequence: payload.hubSequence };
    }
    return { state, cursor };
  }
  if (
    page.status !== "ok" ||
    !page.legacyBaseThroughEventId ||
    detail.transcript[0]?.type !== "session_meta"
  )
    throw new Error("Cloud history has no exact legacy base");
  const anchor = detail.transcript.findIndex(
    (record) => record.id === page.legacyBaseThroughEventId,
  );
  if (anchor < 0) throw new Error("Cloud history legacy anchor is missing");
  let state = replayCloudTranscript(detail.transcript.slice(0, anchor + 1));
  let recovery: OutputJournalRecovery = { incomplete: false };
  let pages = 0;
  const fold = async () => {
    while (true) {
      if (!canContinue() || ++pages > 2048) throw new Error("Cloud history recovery stopped");
      const complete = applyOutputJournalPage(recovery, page, (event) => {
        state = applyTranscriptStreamEvent(state, event as RendererStreamEvent);
      });
      if (recovery.incomplete) throw new Error("Cloud history is incomplete");
      if (complete) return;
      page = await args.read({ after: recovery.cursor, through: recovery.through });
    }
  };
  await fold();
  const hasUser = (id: string) =>
    state.messages.some((m) => m.kind === "user" && m.clientMessageId === id);
  for (let round = 0; round < 8; round++) {
    const proof = await args.coverage();
    if (!canContinue()) throw new Error("Cloud history selection changed");
    assertOutputCoverage({ ...proof, inputIds: undefined }, page, () => true);
    let latest = recovery.cursor!;
    for (const value of [proof.outputCursor, ...buffered.map((p) => p.event.outputCursor)]) {
      if (typeof value !== "string") continue;
      const order = compareOutputCursors(value, latest);
      if (order === undefined) throw new Error("Cloud history journal changed");
      if (order > 0) latest = value;
    }
    if (latest === recovery.cursor) {
      assertOutputCoverage(proof, page, hasUser);
      break;
    }
    if (round === 7) throw new Error("Cloud history could not catch up");
    recovery = { incomplete: false, cursor: recovery.appliedCursor };
    page = await args.read({ after: recovery.cursor, through: latest });
    await fold();
  }
  const bufferedCoverage = new OutputCoverage();
  for (const payload of buffered) bufferedCoverage.observe(payload.event);
  assertOutputCoverage(
    { unpaired: bufferedCoverage.incomplete, inputIds: bufferedCoverage.inputIds },
    page,
    hasUser,
    { requireIdentity: false },
  );
  for (const payload of buffered) {
    const value = payload.event.outputCursor;
    if (typeof value === "string") {
      const order = compareOutputCursors(value, recovery.cursor!);
      if (order === undefined) throw new Error("Cloud history journal changed");
      if (order <= 0) continue;
      recovery.cursor = value;
    } else if (payload.event.type === "session_title") {
      /* non-output metadata */
    } else if (
      payload.event.type === "session_user_message" &&
      typeof payload.event.clientMessageId === "string" &&
      hasUser(payload.event.clientMessageId)
    )
      continue;
    else throw new Error("Cloud history received unpaired output");
    state = applyTranscriptStreamEvent(state, payload.event as RendererStreamEvent);
  }
  return { state: { ...state, outputCursor: recovery.cursor }, cursor: detail.streamCursor };
}
