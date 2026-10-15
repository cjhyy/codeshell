import { expect, test } from "bun:test";
import { chooseHydrateBase, mergeHistoryIntoLive } from "./hydrateOrder";
import { mergeTranscripts } from "./mergeTranscripts";
import { INITIAL_STATE, type MessagesReducerState, type UserMessage } from "../types";

const started = { startedAt: 100_000 };
const completed = {
  ...started,
  completedAt: 112_000,
  durationMs: 12_345,
  completed: true,
  completedCleanly: true,
};
function state(
  id: string,
  turnTiming: UserMessage["turnTiming"],
  identity: Pick<UserMessage, "clientMessageId" | "steerId"> = { clientMessageId: "client" },
  extra: Partial<MessagesReducerState> = {},
): MessagesReducerState {
  return {
    ...INITIAL_STATE,
    messages: [
      { kind: "user", id, text: "question", turnTiming, ...identity },
      { kind: "assistant", id: `${id}-answer`, text: "answer", done: true },
    ],
    ...extra,
  };
}
function timing(state: MessagesReducerState, id?: string) {
  const user = state.messages.find(
    (message) => message.kind === "user" && (!id || message.id === id),
  );
  expect(user?.kind).toBe("user");
  return user?.kind === "user" ? user.turnTiming : undefined;
}
function cursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ identity: "journal", sequence, offset: sequence })).toString(
    "base64url",
  );
}

for (const merge of [chooseHydrateBase, mergeHistoryIntoLive]) {
  for (const identityKey of ["clientMessageId", "steerId"] as const) {
    for (const sameUiId of [false, true]) {
      test(`${merge.name} retains terminal timing by ${identityKey} with same UI id: ${sameUiId}`, () => {
        const identity = { [identityKey]: "intent" };
        for (const terminalOnDisk of [false, true]) {
          const disk = state("disk-user", terminalOnDisk ? completed : started, identity);
          const live = state(
            sameUiId ? "disk-user" : "live-user",
            terminalOnDisk ? started : completed,
            identity,
          );
          const merged = merge(disk, live);
          expect(merged.messages.filter((message) => message.kind === "user")).toHaveLength(1);
          expect(timing(merged)).toEqual(completed);
          expect(timing(disk)).toEqual(terminalOnDisk ? completed : started);
          expect(timing(live)).toEqual(terminalOnDisk ? started : completed);
        }
      });
    }
  }
}

test("a unique intent fills missing terminal fields without replacing canonical values", () => {
  const disk = state("disk", { ...completed, durationMs: undefined, completedCleanly: undefined });
  const live = state("live", { ...completed, completedAt: 113_000 });
  expect(timing(mergeTranscripts(disk, live))).toEqual(completed);
});

test("ambiguous user intent evidence never transfers timing between projections", () => {
  for (const ambiguousSide of ["disk", "live"]) {
    const disk = state("disk", started);
    const live = state("live", completed);
    const ambiguous = ambiguousSide === "disk" ? disk : live;
    ambiguous.messages.push({ ...(ambiguous.messages[0] as UserMessage), id: "duplicate" });
    expect(timing(mergeTranscripts(disk, live), "disk")).toEqual(started);
  }
});

test("matching text or a conflicting steer alias cannot donate another intent's terminal", () => {
  const anonymousDisk = state("disk", started, {});
  const anonymousLive = state("live", completed, {});
  expect(timing(mergeTranscripts(anonymousDisk, anonymousLive), "disk")).toEqual(started);
  const disk = state("disk", started, { clientMessageId: "disk-client", steerId: "shared" });
  const live = state("live", completed, { clientMessageId: "live-client", steerId: "shared" });
  expect(timing(mergeTranscripts(disk, live), "disk")).toEqual(started);
});

for (const merge of [chooseHydrateBase, mergeHistoryIntoLive]) {
  test(`${merge.name} selects a whole run by journal cursor when start times conflict`, () => {
    const newerRun = { startedAt: 120_000 };
    const disk = state("disk", completed, undefined, { outputCursor: cursor(10) });
    const live = state("live", newerRun, undefined, { outputCursor: cursor(20) });
    expect(timing(merge(disk, live))).toEqual(newerRun);
    expect(timing(merge(live, disk))).toEqual(newerRun);
  });
  test(`${merge.name} never reopens the same completed run from a newer started-only cache`, () => {
    const disk = state("disk", completed, undefined, { outputCursor: cursor(10) });
    const live = state("live", started, undefined, { outputCursor: cursor(20) });
    expect(timing(merge(disk, live))).toEqual(completed);
  });
}

test("different run starts use the hydrate projection when no comparable prefix is available", () => {
  const disk = state("disk", completed);
  const live = state("live", { startedAt: 120_000 });
  expect(timing(chooseHydrateBase(disk, live))).toEqual(completed);
  expect(timing(mergeHistoryIntoLive(disk, live))).toEqual({ startedAt: 120_000 });
});

test("same-epoch snapshot progress selects the whole newer run without comparing restart counters", () => {
  const disk = state("disk", completed, undefined, { snapshotEpoch: "main", snapshotSeq: 10 });
  const live = state("live", { startedAt: 120_000 }, undefined, {
    snapshotEpoch: "main",
    snapshotSeq: 20,
  });
  expect(timing(chooseHydrateBase(disk, live))).toEqual({ startedAt: 120_000 });
  expect(
    timing(mergeHistoryIntoLive({ ...disk, snapshotEpoch: "old", snapshotSeq: 10_000 }, live)),
  ).toEqual({ startedAt: 120_000 });
});
