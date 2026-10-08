import type { SessionSnapshot, FoldItem } from "../../preload/types";
import type { OutputJournalOptions, OutputJournalPage } from "@cjhyy/code-shell-core/internal";
import {
  applyOutputJournalPage,
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
  let page = await args.read({});
  if (page.status === "unavailable") return null;
  if (!page.legacyBaseComplete || !page.legacyBaseItems)
    throw new Error("Output recovery has no exact legacy base");
  let state = foldTranscript(page.legacyBaseItems);
  let recovery: OutputJournalRecovery = { incomplete: false };
  let pages = 0;
  const fold = async () => {
    while (true) {
      if (!args.canContinue() || ++pages > 2048)
        throw new Error("Output recovery stopped within its bound");
      const complete = applyOutputJournalPage(recovery, page, (event) => {
        state = applyTranscriptStreamEvent(state, event);
      });
      if (recovery.incomplete) throw new Error("Output recovery is incomplete");
      if (complete) return;
      page = await args.read({ after: recovery.cursor, through: recovery.through });
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
    // A current Core stream always has durable cursors. Old workers and other
    // producers remain on the legacy barrier rather than inventing a mapping.
    if (
      snapshot.events.some(
        ({ event }) =>
          !event.outputCursor &&
          [
            "stream_request_start",
            "text_delta",
            "thinking_delta",
            "tool_use_start",
            "assistant_message",
            "turn_complete",
          ].includes(event.type),
      )
    )
      throw new Error("Snapshot contains unpaired legacy output");
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
    page = await args.read({ after: recovery.cursor, through: target });
    await fold();
  }
  throw new Error("Output recovery could not catch up within its round budget");
}
