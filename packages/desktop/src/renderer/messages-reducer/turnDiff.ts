/**
 * Turn-diff projection: folds execution-owned turn_diff snapshots into the
 * user turn that owns them (including late/replayed updates and child-agent
 * refreshes), and re-homes late external-agent file changes onto their
 * origin turn's single cumulative files-changed card.
 */

import type { StreamEvent, TurnDiffSnapshot } from "@cjhyy/code-shell-core";
import { translate } from "../i18n/translate";
import { aggregateFileChangeSummary } from "../messages/fileChangeAggregator";
import type {
  FilesChangedSummaryMessage,
  Message,
  MessagesReducerState,
  SystemMessage,
} from "../messageTypes";
import { loadUILanguage } from "../uiLanguage";
import { filesChangedMessage } from "./helpers";

function turnDiffNotice(snapshot: TurnDiffSnapshot, unresolvedPaths: string[] = []): string {
  return [
    snapshot.complete
      ? ""
      : `${translate(loadUILanguage(), "msg.files.incompleteDiff")} ${snapshot.omissions
          .map((omission) => `${omission.path}: ${omission.reason}`)
          .join("; ")}`.trim(),
    unresolvedPaths.length
      ? `${translate(loadUILanguage(), "msg.files.lateChangesDiff")} ${unresolvedPaths.join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Replace the aggregate inside its original user turn, including late/replayed updates. */
export function applyTurnDiff(
  state: MessagesReducerState,
  event: Extract<StreamEvent, { type: "turn_diff" }>,
  capturedAt: number | undefined,
): MessagesReducerState {
  if (event.agentId) return state;
  const run = Object.values(state.streamRuns ?? {}).find((item) => item.runId === event.turnId);
  const start = state.messages.findIndex(
    (message) =>
      message.kind === "user" &&
      !message.injected &&
      (message.sourceEventId === event.turnId || message.id === run?.userMessageId),
  );
  // A paged history can omit the owner. Never attach its diff to a newer user turn.
  if (start < 0) return state;
  const offset = state.messages
    .slice(start + 1)
    .findIndex((message) => message.kind === "user" && !message.injected);
  const end = offset < 0 ? state.messages.length : start + offset + 1;
  const scoped = state.messages.slice(start, end);
  const previousSnapshot = scoped.find(
    (message) => message.kind === "system" && message.turnDiff?.turnId === event.turnId,
  );
  if (
    capturedAt !== undefined &&
    previousSnapshot?.kind === "system" &&
    previousSnapshot.turnDiffCapturedAt !== undefined &&
    capturedAt < previousSnapshot.turnDiffCapturedAt
  )
    return state;
  const previous = scoped.find((message) => message.kind === "files_changed");
  const snapshot: TurnDiffSnapshot = {
    turnId: event.turnId,
    cwd: event.cwd,
    files: event.files,
    trackedPaths: event.trackedPaths,
    toolCallIds: event.toolCallIds,
    complete: event.complete,
    omissions: event.omissions,
    ...(event.capturedAt !== undefined ? { capturedAt: event.capturedAt } : {}),
  };
  const marker: SystemMessage = {
    kind: "system",
    id: `turn-diff:${event.turnId}`,
    text: turnDiffNotice(snapshot),
    turnDiff: snapshot,
    turnDiffCapturedAt: capturedAt,
  };
  const logicalTurn = [
    ...scoped.filter(
      (message) =>
        message.kind !== "files_changed" &&
        !(message.kind === "system" && message.turnDiff?.turnId === event.turnId),
    ),
    marker,
  ];
  const owner = scoped[0];
  // Late completions are displayed after the newer turn, but their file
  // evidence still belongs to this owner when an execution snapshot refreshes.
  const priorLateMarkers =
    owner.kind === "user" && owner.clientMessageId
      ? state.messages
          .slice(end)
          .filter(
            (message) =>
              message.kind === "system" &&
              message.externalFileChanges?.originClientMessageId === owner.clientMessageId,
          )
      : [];
  const summary = aggregateFileChangeSummary([...logicalTurn, ...priorLateMarkers]);
  marker.text = turnDiffNotice(snapshot, summary?.unresolvedPaths);
  if (summary?.files.length) logicalTurn.push(filesChangedMessage(summary, previous?.id));
  const messages = [
    ...state.messages.slice(0, start),
    ...logicalTurn,
    ...state.messages.slice(end),
  ];
  return {
    ...state,
    messages,
    agentMessageIndex: Object.fromEntries(
      messages.flatMap((message, index) => (message.kind === "agent" ? [[message.id, index]] : [])),
    ),
  };
}

export function refreshTurnDiffForAgent(
  state: MessagesReducerState,
  agentId: string,
): MessagesReducerState {
  const index = state.agentMessageIndex[agentId];
  if (index === undefined) return state;
  let start = index;
  while (start >= 0) {
    const message = state.messages[start];
    if (message.kind === "user" && !message.injected) break;
    start--;
  }
  if (start < 0) return state;
  for (let i = start + 1; i < state.messages.length; i++) {
    const message = state.messages[i];
    if (message.kind === "user" && !message.injected) break;
    if (message.kind === "system" && message.turnDiff) {
      return applyTurnDiff(
        state,
        { type: "turn_diff", ...message.turnDiff },
        message.turnDiffCapturedAt,
      );
    }
  }
  return state;
}

export function attachExternalChangesToOriginTurn(
  messages: Message[],
  marker: SystemMessage,
  originClientMessageId: string,
): { messages: Message[]; insertedAt?: number; summary?: FilesChangedSummaryMessage } {
  const start = messages.findIndex(
    (message) =>
      message.kind === "user" &&
      !message.injected &&
      message.clientMessageId === originClientMessageId,
  );
  if (start < 0) return { messages: [...messages, marker] };

  let end = messages.length;
  for (let i = start + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.kind === "user" && !message.injected) {
      end = i;
      break;
    }
  }
  const existingCardIndex = messages.findIndex(
    (message, index) => index > start && index < end && message.kind === "files_changed",
  );
  // Earlier late completions were appended after the next real user turn, so
  // they sit outside this origin turn's slice. Pull matching markers back into
  // the logical turn before rebuilding its single cumulative file card.
  const priorLateMarkers = messages
    .slice(end)
    .filter(
      (message): message is SystemMessage =>
        message.kind === "system" &&
        message.externalFileChanges?.originClientMessageId === originClientMessageId,
    );
  const logicalTurn = [
    ...messages.slice(start, end).filter((message) => message.kind !== "files_changed"),
    ...priorLateMarkers,
    marker,
  ];
  const aggregate = aggregateFileChangeSummary(logicalTurn);
  if (!aggregate) return { messages: [...messages, marker] };

  const summary = filesChangedMessage(
    aggregate,
    existingCardIndex >= 0 && messages[existingCardIndex]?.kind === "files_changed"
      ? messages[existingCardIndex].id
      : undefined,
  );
  const next = messages.slice();
  for (let i = start + 1; i < end; i++) {
    const message = next[i];
    if (message.kind === "system" && message.turnDiff) {
      next[i] = {
        ...message,
        text: turnDiffNotice(message.turnDiff, aggregate.unresolvedPaths),
      };
    }
  }
  let insertedAt: number | undefined;
  if (existingCardIndex >= 0) {
    next[existingCardIndex] = summary;
  } else {
    next.splice(end, 0, summary);
    insertedAt = end;
  }
  next.push(marker);
  return { messages: next, insertedAt, summary };
}
