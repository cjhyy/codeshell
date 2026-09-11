import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useReducer, useRef, useState } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import type { FoldItem, SessionSnapshot, SessionTranscriptPage } from "../../preload/types";
import { ensureMiniDom, flushMicrotasks, renderHook } from "../test-utils/renderHook";
import { bucketKey, loadTranscript, saveTranscript, type SessionIndex } from "../transcripts";
import { transcriptsReducer, type TranscriptsMap } from "../transcriptsReducer";
import { foldTranscript } from "../automation/foldTranscript";
import { flushSessionPersistence } from "../sessionPersistence";
import { INITIAL_CHAT_HISTORY_BYTES, useTranscriptBuckets } from "./useTranscriptBuckets";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const bucket = bucketKey("project", "saved");
const oldHistory: FoldItem[] = [{ kind: "user", text: "Previous conversation", timestamp: 1 }];
const emptySnapshot: SessionSnapshot = { events: [], nextSeq: 1, topLevelRunning: false };

describe("transcript history hydration after a background resume", () => {
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useHarness>>>> | undefined;
  let savedStorage: PropertyDescriptor | undefined;
  let savedBridge: PropertyDescriptor | undefined;
  let initial: TranscriptsMap;
  let diskReads: number;
  let readDisk: () => Promise<FoldItem[]>;
  let readSnapshot: () => Promise<SessionSnapshot>;
  let readGoal: () => Promise<Record<string, unknown>>;
  let bindEngine: boolean;

  function installSnapshotReader(
    readTranscript: NonNullable<typeof window.codeshell.sessionCatalog>["readTranscript"],
  ) {
    const snapshot = { revision: 0, indices: {} };
    window.codeshell.sessionCatalog = {
      load: async () => snapshot,
      importLegacy: async () => snapshot,
      apply: async () => snapshot,
      onChanged: () => () => undefined,
      writeTranscript: async () => undefined,
      readTranscript,
      deleteTranscript: async () => undefined,
    };
  }

  function useHarness() {
    const [transcripts, dispatch] = useReducer(transcriptsReducer, initial);
    const [active, setActive] = useState("saved");
    const [busyKeys, setBusyKeys] = useState(new Set<string>());
    const runningBucketRef = useRef<string | null>(null);
    const busySinceRef = useRef(new Map<string, number>());
    const sessionIndices: Record<string, SessionIndex> = {
      project: {
        sessions: ["saved", "other"].map((id) => ({
          id,
          engineSessionId: bindEngine ? id : undefined,
          title: id,
          createdAt: 1,
          updatedAt: 1,
        })),
        activeSessionId: active,
      },
    };
    const result = useTranscriptBuckets({
      activeProjectId: "project",
      activeSessionId: active,
      activeBucket: bucketKey("project", active),
      activeProjectBucketSegment: "project",
      sessionIndices,
      transcripts,
      dispatch,
      runningBucketRef,
      busySinceRef,
      setBusyKeys,
    });
    return { ...result, transcripts, dispatch, setActive, busyKeys };
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
    initial = transcriptsReducer(
      {},
      {
        type: "stream_batch",
        bucket,
        maxSeq: 1,
        events: [{ type: "session_started", sessionId: "saved" } as StreamEvent],
      },
    );
    diskReads = 0;
    bindEngine = true;
    readDisk = async () => oldHistory;
    readSnapshot = async () => emptySnapshot;
    readGoal = async () => ({ ok: true });
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: () => {},
        getSessionTranscript: () => {
          diskReads += 1;
          return readDisk();
        },
        subscribeSession: () => readSnapshot(),
        goalGet: () => readGoal(),
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

  test("loads history even when a background session_started already created an empty bucket", async () => {
    hook = await renderHook(useHarness);
    expect(hook.result.current.state.messages).toMatchObject([
      { kind: "user", text: "Previous conversation" },
    ]);
    expect(diskReads).toBe(1);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 2,
        events: [{ type: "usage_update", promptTokens: 8 } as StreamEvent],
      });
      await flushMicrotasks();
    });
    await hook.rerender();
    expect(diskReads).toBe(1);
    await act(async () => {
      hook!.result.current.setActive("other");
      await flushMicrotasks();
    });
    await act(async () => {
      hook!.result.current.setActive("saved");
      await flushMicrotasks();
    });
    expect(diskReads).toBe(2);
  });

  test("preserves live batches during disk, snapshot, and goal reads without replaying the live turn", async () => {
    const disk = deferred<FoldItem[]>();
    const snapshot = deferred<SessionSnapshot>();
    const goal = deferred<Record<string, unknown>>();
    readDisk = () => disk.promise;
    readSnapshot = () => snapshot.promise;
    readGoal = () => goal.promise;
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 3,
        raw: [
          {
            seq: 2,
            event: {
              type: "stream_request_start",
              turnNumber: 1,
              messageId: "live",
            } as StreamEvent,
          },
          { seq: 3, event: { type: "text_delta", text: "first" } as StreamEvent },
        ],
        events: [
          { type: "stream_request_start", turnNumber: 1, messageId: "live" } as StreamEvent,
          { type: "text_delta", text: "first" } as StreamEvent,
        ],
      });
      disk.resolve(oldHistory);
      await flushMicrotasks();
    });
    expect(diskReads).toBe(1);
    await act(async () => {
      snapshot.resolve({
        nextSeq: 4,
        topLevelRunning: true,
        events: [
          { seq: 2, event: { type: "stream_request_start", turnNumber: 1, messageId: "live" } },
          { seq: 3, event: { type: "text_delta", text: "first" } },
        ],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 4,
        events: [{ type: "text_delta", text: " second" } as StreamEvent],
      });
      goal.resolve({ ok: true, goal: "Saved objective", goalId: "goal", revision: 1 });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.messages).toMatchObject([
      { kind: "user", text: "Previous conversation" },
      { kind: "assistant", id: "live", text: "first second" },
    ]);
    expect(hook.result.current.state.streamingAssistantId).toBe("live");
    expect(hook.result.current.state.activeGoal?.objective).toBe("Saved objective");
    expect(diskReads).toBe(1);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 5,
        events: [{ type: "text_delta", text: " third" } as StreamEvent],
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.messages[1]).toMatchObject({ text: "first second third" });
  });

  test("does not overwrite cached history before the disk read finishes", async () => {
    saveTranscript("project", "saved", foldTranscript(oldHistory));
    const disk = deferred<FoldItem[]>();
    readDisk = () => disk.promise;
    hook = await renderHook(useHarness);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(loadTranscript("project", "saved").messages).toMatchObject([
      { text: "Previous conversation" },
    ]);
    await act(async () => {
      disk.resolve(oldHistory);
      await flushMicrotasks();
    });
    expect(hook.result.current.state.messages).toHaveLength(1);
  });

  test("quit flush persists the latest input before the debounced snapshot save", async () => {
    installSnapshotReader(async () => ({ value: null, hasEarlier: false }));
    const writes: string[] = [];
    window.codeshell.sessionCatalog!.writeTranscript = async ({ value }) => {
      writes.push(value);
    };
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "user_message",
        bucket,
        text: "Do not lose the last input",
        clientMessageId: "last-input",
      });
      await flushMicrotasks();
    });
    expect(writes).toHaveLength(0);
    await flushSessionPersistence();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).messages.at(-1)).toMatchObject({
      text: "Do not lose the last input",
      clientMessageId: "last-input",
    });
  });

  test("quit flush includes a conversation switched away from before its save timer fired", async () => {
    installSnapshotReader(async () => ({ value: null, hasEarlier: false }));
    const writes = new Map<string, string>();
    window.codeshell.sessionCatalog!.writeTranscript = async ({ sessionId, value }) => {
      writes.set(sessionId, value);
    };
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "user_message",
        bucket,
        text: "Background input",
        clientMessageId: "background-input",
      });
      hook!.result.current.setActive("other");
      await flushMicrotasks();
    });
    await flushSessionPersistence();
    expect(writes.has("saved")).toBe(true);
    expect(JSON.parse(writes.get("saved")!).messages.at(-1)).toMatchObject({
      text: "Background input",
      clientMessageId: "background-input",
    });
  });

  test("commits snapshot state and its replay cursor together without waiting for goal metadata", async () => {
    initial = {};
    const goal = deferred<Record<string, unknown>>();
    readGoal = () => goal.promise;
    readSnapshot = async () => ({
      nextSeq: 11,
      topLevelRunning: false,
      events: [{ seq: 10, event: { type: "usage_update", promptTokens: 12 } }],
    });
    hook = await renderHook(useHarness);
    expect(hook.result.current.appliedSeqRef.current.get(bucket)).toBe(10);
    expect(hook.result.current.state.snapshotSeq).toBe(10);
    await act(async () => {
      goal.resolve({ ok: true });
      await flushMicrotasks();
    });
    expect(hook.result.current.appliedSeqRef.current.get(bucket)).toBe(10);
    expect(hook.result.current.state.snapshotSeq).toBe(10);
  });

  test("retains the snapshot prefix and a first live delta while goal metadata is pending", async () => {
    initial = {};
    const goal = deferred<Record<string, unknown>>();
    readGoal = () => goal.promise;
    readSnapshot = async () => ({
      nextSeq: 11,
      topLevelRunning: true,
      events: [
        { seq: 9, event: { type: "stream_request_start", turnNumber: 1, messageId: "recovered" } },
        { seq: 10, event: { type: "text_delta", text: "Snapshot prefix" } },
      ],
    });
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 11,
        events: [{ type: "text_delta", text: " and live tail" } as StreamEvent],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      goal.resolve({ ok: true });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.messages).toContainEqual(
      expect.objectContaining({ id: "recovered", text: "Snapshot prefix and live tail" }),
    );
    expect(hook.result.current.state.snapshotSeq).toBe(11);
  });

  test("recovers a missing stream prefix when a live delta arrives before the subscription snapshot", async () => {
    initial = {};
    const snapshot = deferred<SessionSnapshot>();
    readSnapshot = () => snapshot.promise;
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 11,
        events: [{ type: "text_delta", text: " and live tail" } as StreamEvent],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      snapshot.resolve({
        nextSeq: 11,
        topLevelRunning: true,
        events: [
          {
            seq: 9,
            event: { type: "stream_request_start", turnNumber: 1, messageId: "recovered" },
          },
          { seq: 10, event: { type: "text_delta", text: "Snapshot prefix" } },
        ],
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.messages).toContainEqual(
      expect.objectContaining({ id: "recovered", text: "Snapshot prefix and live tail" }),
    );
    expect(hook.result.current.state.snapshotSeq).toBe(11);
  });

  test("a cancelled hydration cannot advance the replay cursor after a session switch", async () => {
    initial = {};
    const oldSnapshot = deferred<SessionSnapshot>();
    let subscriptions = 0;
    readSnapshot = () =>
      ++subscriptions === 1 ? oldSnapshot.promise : Promise.resolve(emptySnapshot);
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.setActive("other");
      await flushMicrotasks();
    });
    await act(async () => {
      oldSnapshot.resolve({
        nextSeq: 101,
        topLevelRunning: false,
        events: [{ seq: 100, event: { type: "usage_update", promptTokens: 12 } }],
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.appliedSeqRef.current.has(bucket)).toBe(false);
    expect(hook.result.current.transcripts[bucket]).toBeUndefined();
  });

  test("a failed subscription leaves the raw live tail available to a manual retry", async () => {
    initial = {};
    let reads = 0;
    readSnapshot = async () => {
      if (++reads === 1) throw new Error("worker connection unavailable");
      return {
        nextSeq: 11,
        topLevelRunning: true,
        events: [
          {
            seq: 9,
            event: { type: "stream_request_start", turnNumber: 1, messageId: "recovered" },
          },
          { seq: 10, event: { type: "text_delta", text: "Snapshot prefix" } },
        ],
      };
    };
    hook = await renderHook(useHarness);
    expect(hook.result.current.historyFailed).toBe(true);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 11,
        events: [{ type: "text_delta", text: " and live tail" } as StreamEvent],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      await hook!.result.current.loadEarlierHistory();
      await flushMicrotasks();
    });
    expect(hook.result.current.historyFailed).toBe(false);
    expect(hook.result.current.state.messages).toContainEqual(
      expect.objectContaining({ id: "recovered", text: "Snapshot prefix and live tail" }),
    );
  });

  test("a switched-away recovery completes only its retained raw tail in the background", async () => {
    initial = {};
    const snapshot = deferred<SessionSnapshot>();
    let reads = 0;
    readSnapshot = () => (++reads === 1 ? snapshot.promise : Promise.resolve(emptySnapshot));
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 11,
        events: [{ type: "text_delta", text: " and tail" } as StreamEvent],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      hook!.result.current.setActive("other");
      await flushMicrotasks();
    });
    await act(async () => {
      snapshot.resolve({
        nextSeq: 11,
        topLevelRunning: false,
        events: [
          {
            seq: 9,
            event: { type: "stream_request_start", turnNumber: 1, messageId: "recovered" },
          },
          { seq: 10, event: { type: "text_delta", text: "prefix" } },
        ],
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.transcripts[bucket]?.messages).toContainEqual(
      expect.objectContaining({ id: "recovered", text: "prefix and tail" }),
    );
    expect(hook.result.current.state.messages).not.toContainEqual(
      expect.objectContaining({ id: "recovered" }),
    );
  });

  test("does not restore stale running status after a live completion during goal lookup", async () => {
    const goal = deferred<Record<string, unknown>>();
    readSnapshot = async () => ({ events: [], nextSeq: 2, topLevelRunning: true });
    readGoal = () => goal.promise;
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 2,
        events: [{ type: "turn_complete" } as StreamEvent],
      });
      hook!.result.current.setBusyForKey(bucket, false);
      goal.resolve({ ok: true });
      await flushMicrotasks();
    });
    expect(hook.result.current.busyKeys.has(bucket)).toBe(false);
  });

  test("keeps the cache and avoids a retry loop when the authoritative history read fails", async () => {
    const cached = foldTranscript(oldHistory);
    saveTranscript("project", "saved", cached);
    readDisk = async () => {
      throw new Error("temporarily unavailable");
    };
    hook = await renderHook(useHarness);
    await act(async () => {
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 2,
        events: [{ type: "usage_update", promptTokens: 8 } as StreamEvent],
      });
      await flushMicrotasks();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(diskReads).toBe(1);
    expect(loadTranscript("project", "saved")).toEqual(cached);
  });

  test("uses a successful fallback history read when the first read failed", async () => {
    readDisk = async () => {
      if (diskReads === 1) throw new Error("temporarily unavailable");
      return oldHistory;
    };
    hook = await renderHook(useHarness);
    expect(diskReads).toBe(2);
    expect(hook.result.current.state.messages).toMatchObject([
      { kind: "user", text: "Previous conversation" },
    ]);
  });

  test("reads only a bounded recent page, then expands history on demand without duplicates", async () => {
    const reads: number[] = [];
    window.codeshell.getSessionTranscriptPage = async (_id, options) => {
      reads.push(options!.maxBytes!);
      return {
        items:
          reads.length === 1
            ? oldHistory
            : [{ kind: "user", text: "Earlier conversation", timestamp: 0 }, ...oldHistory],
        loadedBytes: options!.maxBytes!,
        hasMore: reads.length === 1,
      };
    };
    hook = await renderHook(useHarness);
    expect(reads).toEqual([INITIAL_CHAT_HISTORY_BYTES]);
    expect(diskReads).toBe(0);
    expect(hook.result.current.historyHasMore).toBe(true);
    await act(async () => {
      await hook!.result.current.loadEarlierHistory();
      await flushMicrotasks();
    });
    expect(reads).toEqual([INITIAL_CHAT_HISTORY_BYTES, INITIAL_CHAT_HISTORY_BYTES * 2]);
    expect(hook.result.current.state.messages).toMatchObject([
      { text: "Earlier conversation" },
      { text: "Previous conversation" },
    ]);
    expect(hook.result.current.historyHasMore).toBe(false);
    await act(async () => {
      await hook!.result.current.loadEarlierHistory();
    });
    expect(reads).toHaveLength(2);
  });

  test("keeps a live user and assistant while an earlier-page read is pending", async () => {
    const earlierPage = deferred<SessionTranscriptPage>();
    let reads = 0;
    window.codeshell.getSessionTranscriptPage = async () => {
      if (++reads > 1) return earlierPage.promise;
      return { items: oldHistory, loadedBytes: INITIAL_CHAT_HISTORY_BYTES, hasMore: true };
    };
    hook = await renderHook(useHarness);
    let loading!: Promise<void>;
    await act(async () => {
      loading = hook!.result.current.loadEarlierHistory();
      // A double click during the same render must not launch another read.
      void hook!.result.current.loadEarlierHistory();
      hook!.result.current.dispatch({
        type: "user_message",
        bucket,
        text: "New request",
        clientMessageId: "new",
      });
      hook!.result.current.dispatch({
        type: "stream_batch",
        bucket,
        maxSeq: 3,
        events: [
          { type: "stream_request_start", turnNumber: 2, messageId: "live" } as StreamEvent,
          { type: "text_delta", text: "Working" } as StreamEvent,
        ],
      });
      await flushMicrotasks();
    });
    expect(hook.result.current.historyLoading).toBe(true);
    await act(async () => {
      earlierPage.resolve({
        items: [{ kind: "user", text: "Earlier conversation", timestamp: 0 }, ...oldHistory],
        loadedBytes: INITIAL_CHAT_HISTORY_BYTES * 2,
        hasMore: false,
      });
      await loading;
      await flushMicrotasks();
    });
    expect(reads).toBe(2);
    expect(hook.result.current.state.messages).toMatchObject([
      { text: "Earlier conversation" },
      { text: "Previous conversation" },
      { text: "New request", clientMessageId: "new" },
      { id: "live", text: "Working" },
    ]);
    expect(hook.result.current.state.streamingAssistantId).toBe("live");
  });

  test("allows retrying a failed initial page without a session switch or an automatic loop", async () => {
    let fail = true;
    let reads = 0;
    window.codeshell.getSessionTranscriptPage = async () => {
      reads++;
      if (fail) throw new Error("Unavailable");
      return { items: oldHistory, loadedBytes: INITIAL_CHAT_HISTORY_BYTES, hasMore: true };
    };
    hook = await renderHook(useHarness);
    expect(hook.result.current.historyFailed).toBe(true);
    expect(hook.result.current.awaitingHydration).toBe(false);
    expect(reads).toBe(2);
    await hook.rerender();
    expect(reads).toBe(2);
    fail = false;
    await act(async () => {
      await hook!.result.current.loadEarlierHistory();
      await flushMicrotasks();
    });
    expect(reads).toBe(3);
    expect(hook.result.current.historyFailed).toBe(false);
    expect(hook.result.current.state.messages).toMatchObject([{ text: "Previous conversation" }]);
    expect(diskReads).toBe(0);
  });

  test("a failed earlier page preserves the loaded window and can be retried", async () => {
    let reads = 0;
    const requestedBytes: number[] = [];
    window.codeshell.getSessionTranscriptPage = async (_id, options) => {
      reads++;
      requestedBytes.push(options!.maxBytes!);
      if (reads === 2) throw new Error("Unavailable");
      return { items: oldHistory, loadedBytes: options!.maxBytes!, hasMore: reads < 3 };
    };
    hook = await renderHook(useHarness);
    await act(async () => {
      await hook!.result.current.loadEarlierHistory();
      await flushMicrotasks();
    });
    expect(hook.result.current.historyFailed).toBe(true);
    expect(hook.result.current.historyHasMore).toBe(true);
    expect(hook.result.current.state.messages).toMatchObject([{ text: "Previous conversation" }]);
    await act(async () => {
      await hook!.result.current.loadEarlierHistory();
      await flushMicrotasks();
    });
    expect(requestedBytes).toEqual([
      INITIAL_CHAT_HISTORY_BYTES,
      INITIAL_CHAT_HISTORY_BYTES * 2,
      INITIAL_CHAT_HISTORY_BYTES * 2,
    ]);
    expect(hook.result.current.historyFailed).toBe(false);
    expect(hook.result.current.state.messages).toHaveLength(1);
  });

  test("an older-page result stays in its own bucket after switching conversations", async () => {
    const earlierPage = deferred<SessionTranscriptPage>();
    let savedReads = 0;
    window.codeshell.getSessionTranscriptPage = async (id) => {
      if (id === "other")
        return {
          items: [{ kind: "user", text: "Other session", timestamp: 1 }],
          loadedBytes: 100,
          hasMore: false,
        };
      if (++savedReads > 1) return earlierPage.promise;
      return { items: oldHistory, loadedBytes: INITIAL_CHAT_HISTORY_BYTES, hasMore: true };
    };
    hook = await renderHook(useHarness);
    let loading!: Promise<void>;
    await act(async () => {
      loading = hook!.result.current.loadEarlierHistory();
      hook!.result.current.setActive("other");
      await flushMicrotasks();
    });
    await act(async () => {
      earlierPage.resolve({
        items: [{ kind: "user", text: "Earlier conversation", timestamp: 0 }, ...oldHistory],
        loadedBytes: INITIAL_CHAT_HISTORY_BYTES * 2,
        hasMore: false,
      });
      await loading;
      await flushMicrotasks();
    });
    expect(hook.result.current.state.messages).toMatchObject([{ text: "Other session" }]);
    expect(hook.result.current.historyLoading).toBe(false);
    await act(async () => {
      hook!.result.current.setActive("saved");
      await flushMicrotasks();
    });
    expect(savedReads).toBe(2);
    expect(hook.result.current.state.messages).toMatchObject([
      { text: "Earlier conversation" },
      { text: "Previous conversation" },
    ]);
  });

  test("pages a legacy snapshot that has no engine session binding", async () => {
    bindEngine = false;
    initial = {};
    const requestedBytes: number[] = [];
    installSnapshotReader(async ({ maxBytes }) => {
      requestedBytes.push(maxBytes!);
      const items: FoldItem[] =
        requestedBytes.length === 1
          ? oldHistory
          : [{ kind: "user", text: "Legacy earlier conversation", timestamp: 0 }, ...oldHistory];
      return {
        value: JSON.stringify(foldTranscript(items)),
        hasEarlier: requestedBytes.length === 1,
      };
    });
    hook = await renderHook(useHarness);
    expect(hook.result.current.state.messages).toMatchObject([{ text: "Previous conversation" }]);
    expect(hook.result.current.historyHasMore).toBe(true);
    await act(async () => {
      await hook!.result.current.loadEarlierHistory();
      await flushMicrotasks();
    });
    expect(requestedBytes).toEqual([INITIAL_CHAT_HISTORY_BYTES, INITIAL_CHAT_HISTORY_BYTES * 2]);
    expect(hook.result.current.state.messages).toMatchObject([
      { text: "Legacy earlier conversation" },
      { text: "Previous conversation" },
    ]);
    expect(hook.result.current.historyHasMore).toBe(false);
    expect(diskReads).toBe(0);
  });

  test("starts the snapshot and canonical page reads together and retains the saved user tail", async () => {
    const persisted = deferred<{ value: string | null; hasEarlier: boolean }>();
    const canonical = deferred<SessionTranscriptPage>();
    let snapshotReads = 0;
    let canonicalReads = 0;
    installSnapshotReader(() => {
      snapshotReads++;
      return persisted.promise;
    });
    window.codeshell.getSessionTranscriptPage = () => {
      canonicalReads++;
      return canonical.promise;
    };
    hook = await renderHook(useHarness);
    expect(snapshotReads).toBe(1);
    expect(canonicalReads).toBe(1);
    await act(async () => {
      persisted.resolve({
        value: JSON.stringify(
          foldTranscript([
            ...oldHistory,
            {
              kind: "user",
              text: "Saved input waiting for disk",
              clientMessageId: "saved-input",
              timestamp: 2,
            },
          ]),
        ),
        hasEarlier: false,
      });
      canonical.resolve({ items: oldHistory, loadedBytes: 100, hasMore: false });
      await flushMicrotasks();
    });
    expect(hook.result.current.state.messages).toMatchObject([
      { text: "Previous conversation" },
      { text: "Saved input waiting for disk", clientMessageId: "saved-input" },
    ]);
    expect(diskReads).toBe(0);
  });

  test("loads earlier legacy-only snapshot messages when canonical history is already complete", async () => {
    let snapshotReads = 0;
    installSnapshotReader(async () => {
      snapshotReads++;
      return {
        value: JSON.stringify(
          foldTranscript(
            snapshotReads === 1
              ? oldHistory
              : [
                  { kind: "user", text: "Legacy-only earlier message", timestamp: 0 },
                  ...oldHistory,
                ],
          ),
        ),
        hasEarlier: snapshotReads === 1,
      };
    });
    window.codeshell.getSessionTranscriptPage = async () => ({
      items: oldHistory,
      loadedBytes: 100,
      hasMore: false,
    });
    hook = await renderHook(useHarness);
    expect(hook.result.current.historyHasMore).toBe(true);
    await act(async () => {
      await hook!.result.current.loadEarlierHistory();
      await flushMicrotasks();
    });
    expect(hook.result.current.state.messages).toMatchObject([
      { text: "Legacy-only earlier message" },
      { text: "Previous conversation" },
    ]);
    expect(hook.result.current.historyHasMore).toBe(false);
  });
});
