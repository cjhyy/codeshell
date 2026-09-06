import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type SetStateAction } from "react";
import { ensureMiniDom, renderHook } from "../test-utils/renderHook";
import {
  bucketKey,
  loadPanelState,
  loadSessionIndex,
  loadTranscript,
  NO_REPO_KEY,
  savePanelState,
  saveSessionIndex,
  saveTranscript,
  type SessionIndex,
  type SessionSummary,
} from "../transcripts";
import { INITIAL_STATE } from "../types";
import { transcriptsReducer, type TranscriptsMap } from "../transcriptsReducer";
import { emptyPanelBucketState, type ComposerDraftsMap, type PanelBucketState } from "./appUtils";
import type { QueuedInputState } from "../queuedInput";
import { useSessionHistorySync } from "./useSessionHistorySync";

function stateCell<T>(value: T) {
  const cell = {
    value,
    set(action: SetStateAction<T>) {
      cell.value = typeof action === "function" ? (action as (value: T) => T)(cell.value) : action;
    },
  };
  return cell;
}

function session(id: string, engineSessionId?: string): SessionSummary {
  return { id, engineSessionId, title: `Old ${id}`, createdAt: 10, updatedAt: 20 };
}

const TARGET = "canonical-engine";
const A = bucketKey("project", "ui-a");
const B = bucketKey("project", "ui-b");
const C = bucketKey(null, "ui-c");
const KEEP = bucketKey("project", TARGET);

describe("session history successful mutation synchronization", () => {
  let hook: Awaited<ReturnType<typeof renderHook<ReturnType<typeof useSessionHistorySync>>>> | null;
  let params: Parameters<typeof useSessionHistorySync>[0];
  let storageBefore: PropertyDescriptor | undefined;
  let bridgeBefore: PropertyDescriptor | undefined;
  let indices: ReturnType<typeof stateCell<Record<string, SessionIndex>>>;
  let panels: ReturnType<typeof stateCell<Record<string, PanelBucketState>>>;
  let queued: ReturnType<typeof stateCell<QueuedInputState>>;
  let drafts: ReturnType<typeof stateCell<ComposerDraftsMap>>;
  let unread: ReturnType<typeof stateCell<Set<string>>>;
  let transcripts: TranscriptsMap;
  let busy: Set<string>;
  let activity: string[];
  let ipcCalls: string[];

  beforeEach(() => {
    ensureMiniDom();
    hook = null;
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    ipcCalls = [];
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: {
        log: () => {},
        renameSession: () => ipcCalls.push("rename"),
        deleteSession: () => ipcCalls.push("delete"),
      },
    });
    indices = stateCell<Record<string, SessionIndex>>({
      project: {
        sessions: [
          session("ui-a", TARGET),
          session("ui-b", TARGET),
          session(TARGET, "other-engine"),
        ],
        activeSessionId: "ui-a",
      },
      [NO_REPO_KEY]: { sessions: [session("ui-c", TARGET)], activeSessionId: "ui-c" },
    });
    for (const [key, index] of Object.entries(indices.value))
      saveSessionIndex(key === NO_REPO_KEY ? null : key, index);
    panels = stateCell<Record<string, PanelBucketState>>({});
    queued = stateCell<QueuedInputState>({});
    drafts = stateCell<ComposerDraftsMap>({});
    transcripts = {};
    activity = [];
    busy = new Set([A, B, C, KEEP]);
    unread = stateCell(new Set([A, B, C, KEEP]));
    for (const [projectId, id, bucket] of [
      ["project", "ui-a", A],
      ["project", "ui-b", B],
      [null, "ui-c", C],
      ["project", TARGET, KEEP],
    ] as const) {
      panels.value[bucket] = { ...emptyPanelBucketState(), open: true };
      queued.value[bucket] = [{ id: bucket, text: "queued", clientMessageId: bucket }];
      drafts.value[bucket] = { text: `draft ${bucket}`, attachments: [] };
      transcripts[bucket] = { ...INITIAL_STATE, snapshotSeq: 99 };
      saveTranscript(projectId, id, transcripts[bucket]);
      savePanelState(bucket, { open: true, tabs: [], activeId: null });
    }
    params = {
      untitledTitle: "未命名会话",
      sessionIndicesRef: { current: indices.value },
      setSessionIndices: indices.set,
      activeBucketRef: { current: A },
      setPanelByBucket: panels.set,
      transcriptsRef: { current: transcripts },
      dispatch: (action) => {
        activity.push(`${action.type}:${action.bucket}`);
        transcripts = transcriptsReducer(transcripts, action);
      },
      engineToBucketRef: {
        current: new Map([
          [TARGET, A],
          ["alias-route", B],
          ["other-engine", KEEP],
        ]),
      },
      runningBucketRef: { current: A },
      coalescersRef: {
        current: new Map(
          [A, B, C, KEEP].map((bucket) => [
            bucket,
            { discard: () => activity.push(`discard:${bucket}`) },
          ]),
        ),
      },
      coalescerSeqRef: { current: new Map([A, B, C, KEEP].map((bucket) => [bucket, 100])) },
      appliedSeqRef: { current: new Map([A, B, C, KEEP].map((bucket) => [bucket, 99])) },
      setBusyForKey: (bucket, value) => {
        if (value) busy.add(bucket);
        else busy.delete(bucket);
      },
      setUnreadBuckets: unread.set,
      setQueuedInputs: queued.set,
      setComposerDrafts: drafts.set,
    };
  });

  afterEach(async () => {
    await hook?.unmount();
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
  });

  const mount = async () => {
    hook = await renderHook(() => useSessionHistorySync(params));
  };

  test("renames every canonical engine alias while preserving a coincident UI id bound elsewhere", async () => {
    await mount();
    await act(async () => hook!.result.current.onSessionRenamed(TARGET, "  Updated title  "));
    expect(indices.value.project.sessions.map((row) => row.title)).toEqual([
      "Updated title",
      "Updated title",
      `Old ${TARGET}`,
    ]);
    expect(indices.value[NO_REPO_KEY].sessions[0].title).toBe("Updated title");
    expect(indices.value.project.sessions.slice(0, 2).every((row) => row.titleManual)).toBe(true);
    expect(loadSessionIndex("project")).toEqual(indices.value.project);
    expect(loadSessionIndex(null)).toEqual(indices.value[NO_REPO_KEY]);
    expect(params.sessionIndicesRef.current).toEqual(indices.value);
    expect(params.activeBucketRef.current).toBe(A);
    expect(ipcCalls).toEqual([]);
  });

  test("a retained success callback uses the latest localized empty-title fallback", async () => {
    await mount();
    const callback = hook!.result.current.onSessionRenamed;
    params = { ...params, untitledTitle: "Untitled session" };
    await hook!.rerender();
    await act(async () => callback(TARGET, " "));
    expect(indices.value.project.sessions[0].title).toBe("Untitled session");
    expect(indices.value[NO_REPO_KEY].sessions[0].title).toBe("Untitled session");
    expect(ipcCalls).toEqual([]);
  });

  test("deleting the active engine clears all aliases and their state without touching another engine", async () => {
    await mount();
    await act(async () => hook!.result.current.onSessionDeleted(TARGET));
    expect(indices.value.project.sessions.map((row) => row.id)).toEqual([TARGET]);
    expect(indices.value.project.activeSessionId).toBeNull();
    expect(indices.value[NO_REPO_KEY]).toEqual({ sessions: [], activeSessionId: null });
    expect(params.activeBucketRef.current).toBe(bucketKey("project", null));
    expect(loadSessionIndex("project")).toEqual(indices.value.project);
    expect(loadTranscript("project", "ui-a").snapshotSeq).toBe(0);
    expect(loadTranscript(null, "ui-c").snapshotSeq).toBe(0);
    expect(loadTranscript("project", TARGET).snapshotSeq).toBe(99);
    expect(loadPanelState(A).open).toBe(false);
    expect(loadPanelState(KEEP).open).toBe(true);
    expect(Object.keys(panels.value)).toEqual([KEEP]);
    expect(Object.keys(queued.value)).toEqual([KEEP]);
    expect(Object.keys(drafts.value)).toEqual([KEEP]);
    expect([...unread.value]).toEqual([KEEP]);
    expect([...busy]).toEqual([KEEP]);
    expect(params.runningBucketRef.current).toBeNull();
    expect([...params.engineToBucketRef.current]).toEqual([["other-engine", KEEP]]);
    expect(Object.keys(transcripts)).toEqual([KEEP]);
    expect(params.transcriptsRef.current).toEqual(transcripts);
    for (const bucket of [A, B, C]) {
      expect(activity.indexOf(`discard:${bucket}`)).toBeLessThan(
        activity.indexOf(`evict:${bucket}`),
      );
      expect(params.coalescersRef.current.has(bucket)).toBe(false);
      expect(params.coalescerSeqRef.current.has(bucket)).toBe(false);
      expect(params.appliedSeqRef.current.has(bucket)).toBe(false);
    }
    expect(params.coalescersRef.current.has(KEEP)).toBe(true);
    expect(params.coalescerSeqRef.current.get(KEEP)).toBe(100);
    expect(params.appliedSeqRef.current.get(KEEP)).toBe(99);
    expect(ipcCalls).toEqual([]);
  });

  test("deleting background aliases preserves the active and running unrelated conversation", async () => {
    indices.value.project.activeSessionId = TARGET;
    saveSessionIndex("project", indices.value.project);
    params.activeBucketRef.current = KEEP;
    params.runningBucketRef.current = KEEP;
    await mount();
    await act(async () => hook!.result.current.onSessionDeleted(TARGET));
    expect(indices.value.project.activeSessionId).toBe(TARGET);
    expect(params.activeBucketRef.current).toBe(KEEP);
    expect(params.runningBucketRef.current).toBe(KEEP);
    expect(busy.has(KEEP)).toBe(true);
    expect(loadTranscript("project", TARGET).snapshotSeq).toBe(99);
  });

  test("an unbound local UI id remains a valid canonical match", async () => {
    const local = session("unbound");
    indices.value.project.sessions.push(local);
    saveSessionIndex("project", indices.value.project);
    await mount();
    await act(async () => hook!.result.current.onSessionRenamed("unbound", "Before first turn"));
    expect(loadSessionIndex("project").sessions.find((row) => row.id === "unbound")?.title).toBe(
      "Before first turn",
    );
    await act(async () => hook!.result.current.onSessionDeleted("unbound"));
    expect(loadSessionIndex("project").sessions.some((row) => row.id === "unbound")).toBe(false);
    expect(indices.value.project.activeSessionId).toBe("ui-a");
    expect(params.activeBucketRef.current).toBe(A);
  });

  test("an unloaded session does not change any loaded state or issue another IPC", async () => {
    await mount();
    const before = indices.value;
    const panelsBefore = panels.value;
    await act(async () => {
      hook!.result.current.onSessionRenamed("not-loaded", "Title");
      hook!.result.current.onSessionDeleted("not-loaded");
    });
    expect(indices.value).toBe(before);
    expect(panels.value).toBe(panelsBefore);
    expect(activity).toEqual([]);
    expect(params.activeBucketRef.current).toBe(A);
    expect(params.runningBucketRef.current).toBe(A);
    expect(ipcCalls).toEqual([]);
  });
});
