import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { SessionSnapshot } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { bucketKey, saveTranscript, type SessionIndex } from "../transcripts";
import { transcriptsReducer, type TranscriptsMap } from "../transcriptsReducer";
import { applyStreamEvent, appendUserMessage, INITIAL_STATE } from "../types";
import { useTranscriptBuckets } from "./useTranscriptBuckets";

const project = "owned-goal-project";
const sessionA = "owned-goal-a";
const sessionB = "owned-goal-b";
const bucketA = bucketKey(project, sessionA);
const bucketB = bucketKey(project, sessionB);
const cachedGoal = {
  objective: "Owned deleted cached Goal A 中文",
  goalId: "owned-goal-a-id",
  revision: 7,
  paused: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("canonical null Goal reconciliation after persisted UI hydration", () => {
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHarness>>>> | undefined;
  let savedStorage: PropertyDescriptor | undefined;
  let savedBridge: PropertyDescriptor | undefined;
  let readGoal: (id: string) => Promise<Record<string, unknown>>;
  let calls: string[];

  function useHarness() {
    const [transcripts, dispatch] = useReducer(transcriptsReducer, {} as TranscriptsMap);
    const [active, setActive] = useState(sessionA);
    const runningBucketRef = useRef<string | null>(null);
    const busySinceRef = useRef(new Map<string, number>());
    const [, setBusyKeys] = useState(new Set<string>());
    const sessionIndices: Record<string, SessionIndex> = {
      [project]: {
        sessions: [sessionA, sessionB].map((id) => ({
          id,
          engineSessionId: id,
          title: id,
          createdAt: 1,
          updatedAt: 1,
        })),
        activeSessionId: active,
      },
    };
    const result = useTranscriptBuckets({
      activeProjectId: project,
      activeSessionId: active,
      activeBucket: bucketKey(project, active),
      activeProjectBucketSegment: project,
      sessionIndices,
      transcripts,
      dispatch,
      runningBucketRef,
      busySinceRef,
      setBusyKeys,
    });
    return { ...result, transcripts, dispatch, setActive };
  }

  beforeEach(() => {
    ensureMiniDom();
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    calls = [];
    readGoal = async () => ({ ok: true, goal: null, paused: false });
    const emptySnapshot: SessionSnapshot = {
      epoch: "owned-main-epoch",
      events: [],
      nextSeq: 1,
      topLevelRunning: false,
    };
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: () => {},
        getSessionTranscript: async (id: string) => [
          { kind: "user", text: `Owned transcript ${id}`, timestamp: 1 },
        ],
        subscribeSession: async () => emptySnapshot,
        goalGet: (id: string) => {
          calls.push(id);
          return readGoal(id);
        },
      },
    });
    for (const id of [sessionA, sessionB]) {
      const messages = appendUserMessage(INITIAL_STATE, `Owned transcript ${id}`, 1);
      const cached = applyStreamEvent(messages, {
        type: "goal_set",
        ...(id === sessionA
          ? cachedGoal
          : { ...cachedGoal, goalId: "owned-goal-b-id", objective: "Owned cached Goal B" }),
      } as StreamEvent);
      saveTranscript(project, id, cached);
    }
  });

  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
    else Reflect.deleteProperty(window, "codeshell");
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("successful null clears an old cached Goal after real replay hydration", async () => {
    hook = await renderHook(useHarness);
    expect(calls).toEqual([sessionA]);
    expect(hook.result.current.state.messages).toMatchObject([
      { kind: "user", text: `Owned transcript ${sessionA}` },
    ]);
    expect(hook.result.current.state.snapshotEpoch).toBe("owned-main-epoch");
    expect(hook.result.current.state.activeGoal).toBeNull();
  });

  test("the same canonical Goal still restores its identity and pause projection", async () => {
    readGoal = async () => ({
      ok: true,
      goal: cachedGoal.objective,
      goalId: cachedGoal.goalId,
      revision: cachedGoal.revision,
      paused: cachedGoal.paused,
    });
    hook = await renderHook(useHarness);
    expect(calls).toEqual([sessionA]);
    expect(hook.result.current.state.activeGoal).toMatchObject(cachedGoal);
  });

  test("a pending null lookup cannot clear a newer goal identity", async () => {
    const lookup = deferred<Record<string, unknown>>();
    readGoal = () => lookup.promise;
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream",
        bucket: bucketA,
        event: {
          type: "goal_set",
          goalId: "owned-new-goal-id",
          revision: 1,
          objective: "New Goal after lookup began",
          paused: false,
        } as StreamEvent,
      });
      await flushMicrotasks();
      lookup.resolve({ ok: true, goal: null, paused: false });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.activeGoal).toMatchObject({
      goalId: "owned-new-goal-id",
      revision: 1,
      objective: "New Goal after lookup began",
    });
  });

  test("a pending null lookup cannot clear a newer revision of the same Goal", async () => {
    const lookup = deferred<Record<string, unknown>>();
    readGoal = () => lookup.promise;
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream",
        bucket: bucketA,
        event: {
          type: "goal_updated",
          ...cachedGoal,
          revision: 8,
          objective: "Edited after lookup began",
        } as StreamEvent,
      });
      await flushMicrotasks();
      lookup.resolve({ ok: true, goal: null, paused: false });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.activeGoal).toMatchObject({
      goalId: cachedGoal.goalId,
      revision: 8,
      objective: "Edited after lookup began",
    });
  });

  test("a different live epoch and its Goal survive the old lookup", async () => {
    const lookup = deferred<Record<string, unknown>>();
    readGoal = () => lookup.promise;
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket: bucketA,
        epoch: "owned-new-epoch",
        maxSeq: 1,
        events: [
          {
            type: "goal_set",
            goalId: "owned-new-epoch-goal",
            revision: 1,
            objective: "New epoch Goal",
          } as StreamEvent,
        ],
      });
      await flushMicrotasks();
      lookup.resolve({ ok: true, goal: null, paused: false });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.snapshotEpoch).toBe("owned-new-epoch");
    expect(hook.result.current.state.activeGoal?.goalId).toBe("owned-new-epoch-goal");
  });

  test("a new epoch protects the same Goal identity and revision from an old null", async () => {
    const lookup = deferred<Record<string, unknown>>();
    readGoal = () => lookup.promise;
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket: bucketA,
        epoch: "owned-same-goal-new-epoch",
        maxSeq: 1,
        events: [
          {
            type: "goal_set",
            ...cachedGoal,
            objective: "Same Goal active in the new epoch",
          } as StreamEvent,
        ],
      });
      await flushMicrotasks();
    });
    const currentGoal = hook.result.current.state.activeGoal;
    expect(currentGoal).toMatchObject({
      goalId: cachedGoal.goalId,
      revision: cachedGoal.revision,
      objective: "Same Goal active in the new epoch",
    });
    await act(async () => {
      lookup.resolve({ ok: true, goal: null, paused: false });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.snapshotEpoch).toBe("owned-same-goal-new-epoch");
    expect(hook.result.current.state.activeGoal).toBe(currentGoal);
  });

  test("a late null from A cannot clear the newly selected B", async () => {
    const lookup = deferred<Record<string, unknown>>();
    readGoal = (id) =>
      id === sessionA
        ? lookup.promise
        : Promise.resolve({
            ok: true,
            goal: "Owned cached Goal B",
            goalId: "owned-goal-b-id",
            revision: 7,
            paused: true,
          });
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.setActive(sessionB);
      await flushMicrotasks();
    });
    const selected = hook.result.current.transcripts[bucketB];
    await act(async () => {
      lookup.resolve({ ok: true, goal: null, paused: false });
      await flushMicrotasks();
    });
    expect(calls).toEqual([sessionA, sessionB]);
    expect(hook.result.current.transcripts[bucketB]).toBe(selected);
    expect(hook.result.current.state.activeGoal?.goalId).toBe("owned-goal-b-id");
  });

  test("a rejected Goal metadata reply does not clear the cached projection", async () => {
    readGoal = async () => ({ ok: false, goal: null });
    hook = await renderHook(useHarness);
    expect(hook.result.current.state.activeGoal).toMatchObject(cachedGoal);
  });

  test("a failed Goal metadata read does not clear the cached projection", async () => {
    readGoal = async () => {
      throw new Error("Owned Goal metadata failure");
    };
    hook = await renderHook(useHarness);
    expect(hook.result.current.state.activeGoal).toMatchObject(cachedGoal);
  });
});
