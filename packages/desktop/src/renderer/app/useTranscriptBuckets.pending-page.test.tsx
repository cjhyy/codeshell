import { test, expect } from "bun:test";
import { act, useReducer, useRef, useState } from "react";
import { ensureMiniDom, renderHook, flushMicrotasks } from "../test-utils/renderHook";
import { useTranscriptBuckets } from "./useTranscriptBuckets";
import { transcriptsReducer } from "../transcriptsReducer";
import { INITIAL_STATE } from "../types";
import { saveTranscript, bucketKey } from "../transcripts";
import { getSessionPersistence } from "../sessionPersistence";
test("pending cache writes cannot consume earlier-history page budgets", async () => {
  ensureMiniDom();
  const previous = Object.getOwnPropertyDescriptor(window, "codeshell");
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const tail = {
    ...INITIAL_STATE,
    messages: [{ id: "last", kind: "user", text: "most recent cached turn" }],
  };
  const full = {
    ...tail,
    messages: [{ id: "first", kind: "user", text: "earlier cached turn" }, ...tail.messages],
  };
  const indices = {
    project: {
      sessions: [{ id: "legacy", title: "legacy", createdAt: 1, updatedAt: 1 }],
      activeSessionId: "legacy",
    },
  };
  const snapshot = { revision: 1, indices };
  const reads: number[] = [];
  let release!: () => void;
  const write = new Promise<void>((r) => (release = r));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      length: 0,
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
  });
  Object.defineProperty(window, "codeshell", {
    configurable: true,
    value: {
      log() {},
      sessionCatalog: {
        onChanged() {
          return () => {};
        },
        importLegacy: async () => snapshot,
        load: async () => snapshot,
        apply: async () => snapshot,
        writeTranscript: async () => write,
        deleteTranscript: async () => {},
        readTranscript: async ({ maxBytes }: { maxBytes: number }) => {
          reads.push(maxBytes);
          return {
            value: JSON.stringify(maxBytes > 524288 ? full : tail),
            hasEarlier: maxBytes <= 524288,
          };
        },
      },
    },
  });
  const bucket = bucketKey("project", "legacy");
  let hook: any;
  try {
    hook = await renderHook(() => {
      const [transcripts, dispatch] = useReducer(transcriptsReducer, {});
      const [, setBusyKeys] = useState(new Set<string>());
      return useTranscriptBuckets({
        activeProjectId: "project",
        activeSessionId: "legacy",
        activeBucket: bucket,
        activeProjectBucketSegment: "project",
        sessionIndices: indices,
        transcripts,
        dispatch,
        runningBucketRef: useRef(null),
        busySinceRef: useRef(new Map()),
        setBusyKeys,
      });
    });
    expect(hook.result.current.historyHasMore).toBe(true);
    saveTranscript("project", "legacy", { ...tail, promptTokens: 1 });
    for (let i = 0; i < 8; i++)
      await act(async () => {
        await hook.result.current.loadEarlierHistory();
        await flushMicrotasks();
      });
    expect(hook.result.current.historyLimitReached).toBe(false);
    release();
    await getSessionPersistence()!.flush();
    await act(async () => {
      await hook.result.current.loadEarlierHistory();
      await flushMicrotasks();
    });
    console.log(
      JSON.stringify({
        reads,
        limit: hook.result.current.historyLimitReached,
        hasMore: hook.result.current.historyHasMore,
        messages: hook.result.current.state.messages.map((x: any) => x.text),
      }),
    );
    expect(reads).toEqual([524288, 1048576]);
    expect(hook.result.current.historyLimitReached).toBe(false);
    expect(hook.result.current.historyHasMore).toBe(false);
    expect(hook.result.current.state.messages).toHaveLength(2);
  } finally {
    release();
    await hook?.unmount();
    if (previous) Object.defineProperty(window, "codeshell", previous);
    else Reflect.deleteProperty(window, "codeshell");
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
