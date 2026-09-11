import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer, useRef, useState } from "react";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { INITIAL_STATE, type MessagesReducerState } from "../types";
import { transcriptsReducer, type TranscriptsMap } from "../transcriptsReducer";
import type { SessionIndex } from "../transcripts";
import { useIdleTranscriptEviction } from "./useIdleTranscriptEviction";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("idle transcript retention", () => {
  let savedStorage: PropertyDescriptor | undefined;
  let savedBridge: PropertyDescriptor | undefined;
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHarness>>>> | undefined;
  let initial: TranscriptsMap;
  let protectedBuckets: Set<string>;
  let written: string[];
  let acknowledgement: ReturnType<typeof deferred>;
  let previouslyHydrated: boolean;

  function useHarness() {
    const [transcripts, dispatch] = useReducer(transcriptsReducer, initial);
    const [activeBucket, setActive] = useState("project::s12");
    const hydratedBucketsRef = useRef(
      new Map(
        previouslyHydrated
          ? Object.keys(initial).map((bucket) => [bucket, bucket.slice("project::".length)])
          : [],
      ),
    );
    const sessionIndices: Record<string, SessionIndex> = {
      project: {
        activeSessionId: "s12",
        sessions: Object.keys(initial).map((bucket) => ({
          id: bucket.slice("project::".length),
          engineSessionId: bucket.slice("project::".length),
          title: bucket,
          createdAt: 1,
          updatedAt: 1,
        })),
      },
    };
    useIdleTranscriptEviction({
      activeBucket,
      transcripts,
      dispatch,
      sessionIndices,
      hydratedBucketsRef,
      protectedBuckets,
    });
    return { transcripts, dispatch, setActive };
  }

  beforeEach(() => {
    ensureMiniDom();
    savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    savedBridge = Object.getOwnPropertyDescriptor(window, "codeshell");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { length: 0, getItem: () => null, removeItem: () => undefined, key: () => null },
    });
    initial = Object.fromEntries(
      Array.from({ length: 13 }, (_, index) => [
        `project::s${index}`,
        {
          ...INITIAL_STATE,
          sessionId: `s${index}`,
          messages: [{ kind: "user", id: `user${index}`, text: `Saved ${index}` }],
        } as MessagesReducerState,
      ]),
    );
    protectedBuckets = new Set();
    previouslyHydrated = true;
    written = [];
    acknowledgement = deferred();
    const snapshot = { revision: 0, indices: {} };
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: () => undefined,
        sessionCatalog: {
          load: async () => snapshot,
          importLegacy: async () => snapshot,
          apply: async () => snapshot,
          onChanged: () => () => undefined,
          writeTranscript: async ({ sessionId }: { sessionId: string }) => {
            written.push(sessionId);
            await acknowledgement.promise;
          },
          readTranscript: async () => ({ value: null, hasEarlier: false }),
          deleteTranscript: async () => undefined,
        },
      },
    });
  });

  afterEach(async () => {
    await hook?.unmount();
    hook = undefined;
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (savedBridge) Object.defineProperty(window, "codeshell", savedBridge);
    else Reflect.deleteProperty(window, "codeshell");
  });

  test("waits for durable acknowledgement before keeping ten idle buckets plus the active one", async () => {
    hook = await renderHook(useHarness);
    expect(written).toEqual(["s0"]);
    expect(Object.keys(hook.result.current.transcripts)).toHaveLength(13);
    await act(async () => {
      acknowledgement.resolve();
      await flushMicrotasks();
    });
    expect(written).toEqual(["s0", "s1"]);
    expect(Object.keys(hook.result.current.transcripts)).toHaveLength(11);
    expect(hook.result.current.transcripts["project::s12"]).toBeDefined();
  });

  test("retains busy or queued buckets and an unanswered question", async () => {
    protectedBuckets = new Set(["project::s0", "project::s1"]);
    initial["project::s2"] = {
      ...initial["project::s2"],
      messages: [
        {
          kind: "ask_user",
          id: "ask",
          requestId: "request",
          question: "Continue?",
          multiSelect: false,
        },
      ],
    };
    for (let index = 13; index < 16; index++)
      initial[`project::s${index}`] = { ...INITIAL_STATE, sessionId: `s${index}` };
    hook = await renderHook(useHarness);
    await act(async () => {
      acknowledgement.resolve();
      await flushMicrotasks();
    });
    expect(written).toEqual(["s3", "s4"]);
    for (const index of [0, 1, 2, 12])
      expect(hook.result.current.transcripts[`project::s${index}`]).toBeDefined();
  });

  test("also releases acknowledged completed background sessions that were never opened", async () => {
    previouslyHydrated = false;
    for (const state of Object.values(initial)) state.turnEpoch = 1;
    hook = await renderHook(useHarness);
    expect(Object.keys(hook.result.current.transcripts)).toHaveLength(13);
    await act(async () => {
      acknowledgement.resolve();
      await flushMicrotasks();
    });
    expect(written).toEqual(["s0", "s1"]);
    expect(Object.keys(hook.result.current.transcripts)).toHaveLength(11);
  });

  test("retains unhydrated buckets without evidence of a completed durable session", async () => {
    previouslyHydrated = false;
    hook = await renderHook(useHarness);
    expect(written).toEqual([]);
    expect(Object.keys(hook.result.current.transcripts)).toHaveLength(13);
  });

  test("keeps the in-memory messages after a persistence failure", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      acknowledgement.reject(new Error("Disk temporarily unavailable"));
      await flushMicrotasks();
    });
    expect(Object.keys(hook.result.current.transcripts)).toHaveLength(13);
  });

  test("does not release a bucket that resumes while its snapshot is being acknowledged", async () => {
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream",
        bucket: "project::s0",
        event: { type: "stream_request_start", messageId: "new-turn", turnNumber: 1 },
      });
      await flushMicrotasks();
      acknowledgement.resolve();
      await flushMicrotasks();
    });
    expect(hook.result.current.transcripts["project::s0"].streamingAssistantId).toBe("new-turn");
  });

  test("the reducer rejects eviction if a stream batch is queued before the eviction action", () => {
    const saved = initial["project::s0"];
    const updated = transcriptsReducer(initial, {
      type: "user_message",
      bucket: "project::s0",
      text: "New input",
      clientMessageId: "new",
    });
    expect(
      transcriptsReducer(updated, {
        type: "evict_if_unchanged",
        bucket: "project::s0",
        state: saved,
      }),
    ).toBe(updated);
  });
});
