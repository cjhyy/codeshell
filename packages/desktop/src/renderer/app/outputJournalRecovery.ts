import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { SessionSnapshot, FoldItem } from "../../preload/types";
import type { OutputJournalOptions, OutputJournalPage } from "@cjhyy/code-shell-core/internal";
import {
  applyOutputJournalPage,
  assertOutputCoverage,
  OutputCoverage,
  compareOutputCursors,
  type OutputJournalRecovery,
} from "@cjhyy/code-shell-web";
import { foldTranscript } from "../automation/foldTranscript";
import { applyTranscriptStreamEvent } from "../transcripts";
import type { MessagesReducerState } from "../types";

type DesktopPage = OutputJournalPage & {
  legacyBaseComplete?: boolean;
  legacyBaseItems?: FoldItem[];
};

const RECOVERY_PAGE_FRAMES = 2048;
type JournalDelta = Extract<StreamEvent, { type: "text_delta" | "thinking_delta" }>;

/** Rebuild a complete output prefix, then join it to actual Main snapshots. */
export async function recoverDesktopOutputJournal(args: {
  read: (options: OutputJournalOptions) => Promise<DesktopPage>;
  snapshot: () => Promise<SessionSnapshot>;
  canContinue: () => boolean;
  latestObservedCursor: () => string | undefined;
}): Promise<{
  state: MessagesReducerState;
  outputCursor: string;
  snapshot: SessionSnapshot;
} | null> {
  // Core still applies the byte bound. Dense pages save IPC round trips when
  // the journal mostly contains small token deltas.
  const read = (options: OutputJournalOptions = {}) =>
    args.read({ ...options, maxFrames: RECOVERY_PAGE_FRAMES });
  let page = await read();
  if (page.status === "unavailable") {
    const snapshot = await args.snapshot();
    if (!args.canContinue()) throw new Error("Output recovery stopped");
    assertOutputCoverage(
      { unpaired: snapshot.outputUnpaired, inputIds: snapshot.outputInputIds },
      {},
      () => false,
    );
    if (snapshot.outputCursor || args.latestObservedCursor()) {
      page = await read();
      if (page.status === "unavailable") throw new Error("Output recovery journal is unavailable");
    } else {
      if (snapshot.outputJournalIdentity) throw new Error("Output recovery journal is unavailable");
      return null;
    }
  }
  if (!page.legacyBaseComplete || !page.legacyBaseItems)
    throw new Error("Output recovery has no exact legacy base");
  let state = foldTranscript(page.legacyBaseItems);
  let recovery: OutputJournalRecovery = { incomplete: false };
  let pages = 0;
  const fold = async () => {
    while (true) {
      if (!args.canContinue() || ++pages > 2048)
        throw new Error("Output recovery stopped within its bound");
      // The IPC envelope carries the separately bounded legacy base. Validate
      // only the journal page against the shared 1 MiB transport-page limit.
      const {
        legacyBaseComplete: _baseComplete,
        legacyBaseItems: _baseItems,
        ...journalPage
      } = page;
      // Fold adjacent chunks once per slot after the shared verifier accepts
      // the page. Keep all boundaries (including empty deltas), the first
      // timestamp, and the last accepted cursor.
      let delta: JournalDelta | undefined;
      const flushDelta = () => {
        if (!delta) return;
        state = applyTranscriptStreamEvent(state, delta);
        delta = undefined;
      };
      const complete = applyOutputJournalPage(recovery, journalPage, (event) => {
        if (
          (event.type === "text_delta" || event.type === "thinking_delta") &&
          typeof event.text === "string" &&
          event.text.length > 0
        ) {
          if (
            delta?.type === event.type &&
            delta.runId === event.runId &&
            delta.clientMessageId === event.clientMessageId &&
            delta.agentId === event.agentId
          ) {
            delta.text += event.text;
            delta.outputCursor = event.outputCursor;
          } else {
            flushDelta();
            delta = { ...event };
          }
          return;
        }
        flushDelta();
        state = applyTranscriptStreamEvent(state, event);
      });
      if (recovery.incomplete) throw new Error("Output recovery is incomplete");
      flushDelta();
      if (complete) return;
      page = await read({ after: recovery.cursor, through: recovery.through });
    }
  };
  await fold();
  for (let round = 0; round < 8; round++) {
    const snapshot = await args.snapshot();
    const cursors = snapshot.events.flatMap(({ event }) =>
      event.outputCursor ? [event.outputCursor] : [],
    );
    const observed = args.latestObservedCursor();
    if (observed) cursors.push(observed);
    if (snapshot.outputCursor) cursors.push(snapshot.outputCursor);
    let target = recovery.cursor!;
    for (const value of cursors) {
      const order = compareOutputCursors(value, target);
      if (order === undefined) throw new Error("Output recovery journal changed");
      if (order > 0) target = value;
    }
    if (!args.canContinue()) throw new Error("Output recovery stopped");
    assertOutputCoverage(
      {
        unpaired: snapshot.outputUnpaired,
        inputIds: target === recovery.cursor ? snapshot.outputInputIds : undefined,
        incarnation: snapshot.outputCoverageIdentity,
        journalIdentity: snapshot.outputJournalIdentity,
      },
      page,
      (id) =>
        state.messages.some((message) => message.kind === "user" && message.clientMessageId === id),
    );
    // Legacy Main peers have no durable coverage field: retain their suffix
    // barrier using the same display classifier, including background results.
    if (snapshot.outputCoverageIdentity === undefined) {
      const proof = new OutputCoverage();
      for (const { event } of snapshot.events) proof.observe(event);
      assertOutputCoverage(
        {
          unpaired: proof.incomplete,
          inputIds: target === recovery.cursor ? proof.inputIds : undefined,
        },
        page,
        (id) =>
          state.messages.some(
            (message) => message.kind === "user" && message.clientMessageId === id,
          ),
        { requireIdentity: false },
      );
    }
    if (target === recovery.cursor) {
      return {
        state: {
          ...state,
          outputCursor: recovery.cursor,
          snapshotEpoch: snapshot.epoch,
          snapshotSeq: snapshot.nextSeq - 1,
        },
        outputCursor: recovery.cursor!,
        snapshot,
      };
    }
    recovery = { incomplete: false, cursor: recovery.appliedCursor };
    page = await read({ after: recovery.cursor, through: target });
    await fold();
  }
  throw new Error("Output recovery could not catch up within its round budget");
}
