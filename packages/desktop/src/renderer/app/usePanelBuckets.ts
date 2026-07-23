import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { foldTranscript } from "../automation/foldTranscript";
import type { ImageAttachment } from "../chat/attachments";
import { nextAnchorId, type Anchor } from "../chat/anchors";
import {
  addAnchorTo,
  anchorsIn,
  browserAnchorsOf,
  clearAnchorBuckets,
  removeAnchorFrom,
  updateAnchorCommentIn,
  type AnchorsByBucket,
} from "../chat/anchorBuckets";
import type { ModelOption } from "../chat/ModelPill";
import type { PermissionMode } from "../chat/PermissionPill";
import type { OpenCliSessionEventDetail } from "../cc-room/types";
import { nextOpenCliSessionNonce, resolveOpenCliSessionBucket } from "../cc-room/openCliSession";
import {
  makeQuickChatCreationNonce,
  makeQuickChatSessionId,
  quickChatBucket,
  quickChatTabKey,
  type QuickChatContextMode,
  type QuickChatSessionRef,
} from "../quickChatSession";
import {
  loadSessionIndex,
  bucketKey,
  projectBucketSegment as projectBucketSegmentFor,
  savePanelState,
  setActiveSession,
  type SessionIndex,
} from "../transcripts";
import type { TranscriptsAction } from "../transcriptsReducer";
import type { ApprovalState } from "../types";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import type { PanelTab, ViewMode } from "../view";
import { onComposerSeedRequest } from "../chat/composerSeed";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import {
  emptyPanelBucketState,
  EMPTY_ATTACHMENTS,
  hydratePanelBucketState,
  parsePanelBucket,
  type PanelBucketState,
} from "./appUtils";

interface Params {
  sessions: {
    activeBucket: string;
    activeProjectId: string | null;
    activeBucketRef: MutableRefObject<string>;
    sessionIndices: Record<string, SessionIndex>;
    sessionIndicesRef: MutableRefObject<Record<string, SessionIndex>>;
    setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
  };
  quickChat: {
    quickChatSessions: Record<string, QuickChatSessionRef>;
    setQuickChatSessions: Dispatch<SetStateAction<Record<string, QuickChatSessionRef>>>;
    setQuickChatDrafts: Dispatch<SetStateAction<Record<string, string>>>;
    setQuickChatAttachments: Dispatch<SetStateAction<Record<string, ImageAttachment[]>>>;
    quickChatSessionsRef: MutableRefObject<Record<string, QuickChatSessionRef>>;
  };
  controls: {
    engineToBucketRef: MutableRefObject<Map<string, string>>;
    setPermissionOverrides: Dispatch<SetStateAction<Record<string, PermissionMode>>>;
    setModelOverrides: Dispatch<SetStateAction<Record<string, string>>>;
    defaultPermissionMode: PermissionMode | null;
    resolveEngineSessionIdForBucket: (bucket: string) => string | undefined;
    dispatch: Dispatch<TranscriptsAction>;
    approvalBucketsRef: MutableRefObject<Map<string, string>>;
    setApprovalQueue: Dispatch<SetStateAction<ApprovalRequestEnvelope[]>>;
    setApproval: Dispatch<SetStateAction<ApprovalState>>;
    setBusyForKey: (key: string, value: boolean) => void;
  };
  stream: {
    runningBucketRef: MutableRefObject<string | null>;
    coalescersRef: MutableRefObject<Map<string, { discard(): void }>>;
    coalescerSeqRef: MutableRefObject<Map<string, number>>;
    appliedSeqRef: MutableRefObject<Map<string, number>>;
  };
  shell: {
    toast: ReturnType<typeof useToast>;
    t: ReturnType<typeof useT>["t"];
    setViewMode: (view: ViewMode) => void;
  };
}

/** Bucket-owned panel/quick-chat lifecycle; hidden panel buckets stay mounted. */
export function usePanelBuckets({ sessions, quickChat, controls, stream, shell }: Params) {
  const {
    activeBucket,
    activeProjectId,
    activeBucketRef,
    sessionIndices,
    sessionIndicesRef,
    setSessionIndices,
  } = sessions;
  const {
    quickChatSessions,
    setQuickChatSessions,
    setQuickChatDrafts,
    setQuickChatAttachments,
    quickChatSessionsRef,
  } = quickChat;
  const {
    engineToBucketRef,
    setPermissionOverrides,
    setModelOverrides,
    defaultPermissionMode,
    resolveEngineSessionIdForBucket,
    dispatch,
    approvalBucketsRef,
    setApprovalQueue,
    setApproval,
    setBusyForKey,
  } = controls;
  const { runningBucketRef, coalescersRef, coalescerSeqRef, appliedSeqRef } = stream;
  const { toast, t, setViewMode } = shell;
  // Right-side panel dock (dynamic tabs: files/browser/review/terminal). Panel
  // state is bucket-owned below; only nonce sources stay global so repeated
  // clicks can refire even if the same file/url is selected twice.
  // Monotonic nonce source for revealFile, in a ref so the open-file handler
  // (registered once) doesn't close over a stale `revealFile`.
  const revealFileNonceRef = useRef<number>(0);
  const quickChatLifecycleCleanupRef = useRef<Set<string>>(new Set());
  // A Files panel reports it has actually revealed the requested file; mark that
  // nonce consumed so the request keeps lingering on its bucket prop (a later
  // manually-opened Files tab reads it as already-handled and won't replay the
  // old file) WITHOUT the timing race the old setTimeout(0) flip had.
  const openUrlNonceRef = useRef<number>(0);
  // Comment anchors pinned from the panels (diff line / browser element / file
  // line). They show as chips above the composer and ride along with the next
  // message. Panels push them via the "codeshell:add-anchor" window event.
  // Keyed by session bucket (anchorBuckets.ts) so switching sessions switches
  // annotation sets; the browser surfaces echo the active bucket's browser
  // anchors (synced to main → broadcast to popout windows below).
  const [anchorsByBucket, setAnchorsByBucket] = useState<AnchorsByBucket>({});
  const anchors = anchorsIn(anchorsByBucket, activeBucket);
  // The add/remove event listeners register once; route through a ref so they
  // always target the CURRENT bucket, not the one from their mount render.
  const activeAnchorBucketRef = useRef(activeBucket);
  activeAnchorBucketRef.current = activeBucket;
  const removeAnchor = (id: string): void => {
    setAnchorsByBucket((s) => removeAnchorFrom(s, activeAnchorBucketRef.current, id));
  };
  const updateAnchorComment = (id: string, comment: string): void => {
    setAnchorsByBucket((s) => updateAnchorCommentIn(s, activeAnchorBucketRef.current, id, comment));
  };
  const clearAnchors = (): void => {
    // Clear the active bucket AND the repo's draft slot — see clearAnchorBuckets.
    setAnchorsByBucket((s) =>
      clearAnchorBuckets(s, [activeAnchorBucketRef.current, bucketKey(activeProjectId, null)]),
    );
  };
  // Panel state is owned by session bucket, not by the global App shell. This
  // mirrors Codex's thread-owned dock model: switching sessions changes which
  // PanelArea is visible; it never rewrites one session's browser/files/terminal
  // state into another session.
  const [panelByBucket, setPanelByBucket] = useState<Record<string, PanelBucketState>>(() => ({
    [activeBucket]: hydratePanelBucketState(activeBucket),
  }));

  const updatePanelBucket = useCallback(
    (targetBucket: string, updater: (state: PanelBucketState) => PanelBucketState) => {
      setPanelByBucket((prev) => {
        const current = prev[targetBucket] ?? hydratePanelBucketState(targetBucket);
        const next = updater(current);
        if (next === current) return prev;
        return { ...prev, [targetBucket]: next };
      });
    },
    [],
  );

  const onRevealConsumed = useCallback(
    (targetBucket: string, nonce: number) => {
      updatePanelBucket(targetBucket, (state) => {
        if (!state.revealFile || state.revealFile.nonce !== nonce || state.revealFile.consumed)
          return state;
        return { ...state, revealFile: { ...state.revealFile, consumed: true } };
      });
    },
    [updatePanelBucket],
  );

  const updateQuickChatCreation = useCallback(
    (
      key: string,
      nonce: string,
      updater: (session: QuickChatSessionRef) => QuickChatSessionRef,
    ): boolean => {
      const current = quickChatSessionsRef.current[key];
      if (!current || current.creationNonce !== nonce) return false;
      const nextSession = updater(current);
      const next = { ...quickChatSessionsRef.current, [key]: nextSession };
      quickChatSessionsRef.current = next;
      setQuickChatSessions(next);
      return true;
    },
    [],
  );

  const startQuickChatCreation = useCallback(
    async (session: QuickChatSessionRef): Promise<void> => {
      const { key, creationNonce: nonce, sessionId, bucket } = session;
      try {
        await window.codeshell.claimQuickChatSession(sessionId, nonce);
        const claimStillActive = await window.codeshell.isQuickChatClaimActive(sessionId, nonce);
        if (
          !claimStillActive ||
          !quickChatSessionsRef.current[key] ||
          quickChatSessionsRef.current[key].creationNonce !== nonce
        ) {
          await window.codeshell.cleanupQuickChatSession(sessionId, nonce);
          return;
        }
        if (session.contextMode === "blank" || !session.sourceSessionId) {
          if (
            !quickChatSessionsRef.current[key] ||
            quickChatSessionsRef.current[key].creationNonce !== nonce
          ) {
            await window.codeshell.cleanupQuickChatSession(sessionId, nonce);
            return;
          }
          engineToBucketRef.current.set(sessionId, bucket);
          setModelOverrides((current) =>
            current[session.ownerBucket] === undefined
              ? current
              : { ...current, [bucket]: current[session.ownerBucket] },
          );
          setPermissionOverrides((current) => ({
            ...current,
            [bucket]: current[session.ownerBucket] ?? defaultPermissionMode ?? "default",
          }));
          updateQuickChatCreation(key, nonce, (current) => ({ ...current, status: "ready" }));
          return;
        }

        const result = await window.codeshell.forkSession({
          sourceSessionId: session.sourceSessionId,
          targetSessionId: sessionId,
          mode: "full",
          forkKind: "side",
          quickChatClaimId: nonce,
        });
        const mainClaimStillActive = await window.codeshell.isQuickChatClaimActive(
          result.sessionId,
          nonce,
        );
        if (
          !mainClaimStillActive ||
          !quickChatSessionsRef.current[key] ||
          quickChatSessionsRef.current[key].creationNonce !== nonce
        ) {
          await window.codeshell.cleanupQuickChatSession(result.sessionId, nonce);
          return;
        }
        // Match Codex /side: inherited transcript remains in the child Engine's
        // model context, while the side UI starts at its own conversation boundary.
        // Never hydrate copied parent events into this renderer bucket.
        dispatch({ type: "hydrate", bucket, state: foldTranscript([]) });
        engineToBucketRef.current.set(result.sessionId, bucket);
        setModelOverrides((current) =>
          current[session.ownerBucket] === undefined
            ? current
            : { ...current, [bucket]: current[session.ownerBucket] },
        );
        setPermissionOverrides((current) => ({
          ...current,
          [bucket]: current[session.ownerBucket] ?? defaultPermissionMode ?? "default",
        }));
        updateQuickChatCreation(key, nonce, (current) => ({
          ...current,
          cwd: result.workspace.root,
          status: "ready",
          error: undefined,
        }));
      } catch (err) {
        await window.codeshell.cleanupQuickChatSession(sessionId, nonce).catch(() => undefined);
        const error = err as Error & { code?: number };
        updateQuickChatCreation(key, nonce, (current) => ({
          ...current,
          status: "error",
          error: { code: error.code, message: error.message || String(err) },
        }));
      }
    },
    [defaultPermissionMode, updateQuickChatCreation],
  );

  const onOpenCliSessionConsumed = useCallback(
    (targetBucket: string, nonce: number) => {
      updatePanelBucket(targetBucket, (state) => {
        if (!state.openCliSession || state.openCliSession.nonce !== nonce) return state;
        return {
          ...state,
          openCliSession: { ...state.openCliSession, consumed: true },
        };
      });
    },
    [updatePanelBucket],
  );

  const ensureQuickChatSession = useCallback(
    (ownerBucket: string, tabId: string, cwd: string | null) => {
      const key = quickChatTabKey(ownerBucket, tabId);
      if (quickChatSessionsRef.current[key]) return;
      const sessionId = makeQuickChatSessionId();
      const bucket = quickChatBucket(sessionId);
      const sourceSessionId = resolveEngineSessionIdForBucket(ownerBucket) ?? null;
      const {
        projectBucketSegment,
        projectId,
        sessionId: ownerUiSessionId,
      } = parsePanelBucket(ownerBucket);
      const sourceTitle = ownerUiSessionId
        ? (sessionIndices[projectBucketSegment]?.sessions.find(
            (item) => item.id === ownerUiSessionId,
          )?.title ??
          loadSessionIndex(projectId).sessions.find((item) => item.id === ownerUiSessionId)?.title)
        : undefined;
      const contextMode: QuickChatContextMode = sourceSessionId ? "full" : "blank";
      const session: QuickChatSessionRef = {
        key,
        ownerBucket,
        tabId,
        sessionId,
        bucket,
        cwd,
        sourceSessionId,
        sourceTitle,
        contextMode,
        status: "creating",
        creationNonce: makeQuickChatCreationNonce(),
      };
      quickChatSessionsRef.current = { ...quickChatSessionsRef.current, [key]: session };
      setQuickChatSessions(quickChatSessionsRef.current);
      void startQuickChatCreation(session);
    },
    [resolveEngineSessionIdForBucket, sessionIndices, startQuickChatCreation],
  );

  const cleanupQuickChatPanelSession = useCallback((session: QuickChatSessionRef) => {
    const claimKey = `${session.sessionId}\0${session.creationNonce}`;
    if (quickChatLifecycleCleanupRef.current.has(claimKey)) return;
    quickChatLifecycleCleanupRef.current.add(claimKey);
    void window.codeshell
      .cleanupQuickChatSession(session.sessionId, session.creationNonce)
      .catch((error) =>
        window.codeshell.log("quick_chat.delete_session_failed", {
          sessionId: session.sessionId,
          error: String(error),
        }),
      );
  }, []);

  const restartQuickChatSession = useCallback(
    (session: QuickChatSessionRef, contextMode: QuickChatContextMode) => {
      const sessionId = makeQuickChatSessionId();
      const bucket = quickChatBucket(sessionId);
      const next: QuickChatSessionRef = {
        ...session,
        sessionId,
        bucket,
        contextMode,
        status: "creating",
        error: undefined,
        creationNonce: makeQuickChatCreationNonce(),
      };
      quickChatSessionsRef.current = { ...quickChatSessionsRef.current, [session.key]: next };
      setQuickChatSessions(quickChatSessionsRef.current);
      setPermissionOverrides((current) => {
        const { [session.bucket]: _oldMode, ...rest } = current;
        return {
          ...rest,
          [bucket]: current[session.ownerBucket] ?? defaultPermissionMode ?? "default",
        };
      });
      setModelOverrides((current) => {
        const { [session.bucket]: _oldModel, ...rest } = current;
        return rest;
      });
      setQuickChatDrafts((current) => {
        const { [session.bucket]: _oldDraft, ...rest } = current;
        return rest;
      });
      setQuickChatAttachments((current) => {
        const { [session.bucket]: _oldAttachments, ...rest } = current;
        return rest;
      });
      engineToBucketRef.current.delete(session.sessionId);
      dispatch({ type: "evict", bucket: session.bucket });
      cleanupQuickChatPanelSession(session);
      void startQuickChatCreation(next);
    },
    [cleanupQuickChatPanelSession, defaultPermissionMode, startQuickChatCreation],
  );

  const setQuickChatDraft = useCallback((bucket: string, next: React.SetStateAction<string>) => {
    setQuickChatDrafts((prev) => {
      if (
        !Object.values(quickChatSessionsRef.current).some((session) => session.bucket === bucket)
      ) {
        return prev;
      }
      const current = prev[bucket] ?? "";
      const text = typeof next === "function" ? next(current) : next;
      if (prev[bucket] === text) return prev;
      if (!text) {
        const { [bucket]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [bucket]: text };
    });
  }, []);

  const setQuickChatAttachmentState = useCallback(
    (bucket: string, next: React.SetStateAction<ImageAttachment[]>) => {
      setQuickChatAttachments((prev) => {
        if (
          !Object.values(quickChatSessionsRef.current).some((session) => session.bucket === bucket)
        ) {
          return prev;
        }
        const current = prev[bucket] ?? EMPTY_ATTACHMENTS;
        const attachments = typeof next === "function" ? next(current) : next;
        if (attachments === current) return prev;
        if (attachments.length === 0) {
          const { [bucket]: _drop, ...rest } = prev;
          return rest;
        }
        return { ...prev, [bucket]: attachments };
      });
    },
    [],
  );

  const setQuickChatPermission = useCallback((bucket: string, mode: PermissionMode) => {
    setPermissionOverrides((current) => ({ ...current, [bucket]: mode }));
  }, []);

  const setQuickChatModel = useCallback((bucket: string, option: ModelOption) => {
    // Side-chat model choice is ephemeral and bucket-local: unlike the main
    // composer, it must not update the global default or any sibling session.
    setModelOverrides((current) =>
      Object.values(quickChatSessionsRef.current).some((session) => session.bucket === bucket)
        ? { ...current, [bucket]: option.key }
        : current,
    );
  }, []);

  useEffect(() => {
    const liveQuickChatKeys = new Set<string>();
    for (const [ownerBucket, panelState] of Object.entries(panelByBucket)) {
      for (const tab of panelState.tabs) {
        if (tab.kind === "quickChat") liveQuickChatKeys.add(quickChatTabKey(ownerBucket, tab.id));
      }
    }

    const stale = Object.entries(quickChatSessions).filter(([key]) => !liveQuickChatKeys.has(key));
    if (stale.length === 0) return;

    const staleBuckets = new Set(stale.map(([, session]) => session.bucket));
    const staleApprovalIds = new Set(
      [...approvalBucketsRef.current.entries()]
        .filter(([, bucket]) => staleBuckets.has(bucket))
        .map(([requestId]) => requestId),
    );
    if (staleApprovalIds.size > 0) {
      setApprovalQueue((prev) => {
        const remaining = prev.filter((env) => !staleApprovalIds.has(env.requestId));
        if (remaining.length === prev.length) return prev;
        setApproval((cur) =>
          cur && staleApprovalIds.has(cur.requestId) ? (remaining[0] ?? null) : cur,
        );
        return remaining;
      });
      for (const requestId of staleApprovalIds) approvalBucketsRef.current.delete(requestId);
    }

    const nextQuickChatSessions = { ...quickChatSessionsRef.current };
    for (const [key] of stale) delete nextQuickChatSessions[key];
    quickChatSessionsRef.current = nextQuickChatSessions;
    setQuickChatSessions(nextQuickChatSessions);
    setQuickChatDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [, session] of stale) {
        if (session.bucket in next) {
          delete next[session.bucket];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setQuickChatAttachments((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [, session] of stale) {
        if (session.bucket in next) {
          delete next[session.bucket];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setPermissionOverrides((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [, session] of stale) {
        if (session.bucket in next) {
          delete next[session.bucket];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setModelOverrides((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [, session] of stale) {
        if (session.bucket in next) {
          delete next[session.bucket];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const [, session] of stale) {
      setBusyForKey(session.bucket, false);
      if (runningBucketRef.current === session.bucket) runningBucketRef.current = null;
      engineToBucketRef.current.delete(session.sessionId);
      cleanupQuickChatPanelSession(session);
      const coalescer = coalescersRef.current.get(session.bucket);
      coalescersRef.current.delete(session.bucket);
      coalescer?.discard();
      coalescerSeqRef.current.delete(session.bucket);
      appliedSeqRef.current.delete(session.bucket);
      dispatch({ type: "evict", bucket: session.bucket });
    }
  }, [cleanupQuickChatPanelSession, panelByBucket, quickChatSessions]);

  useEffect(
    () => () => {
      const sessions = Object.values(quickChatSessionsRef.current);
      quickChatSessionsRef.current = {};
      for (const session of sessions) {
        cleanupQuickChatPanelSession(session);
      }
    },
    [cleanupQuickChatPanelSession],
  );

  useEffect(() => {
    setPanelByBucket((prev) => {
      // Ensure the active bucket has state, and prune stale entries that are
      // fully empty (closed, no tabs) and not the active one — those render no
      // PanelArea, so keeping them would only grow the map without effect.
      let changed = false;
      const nextEntries: [string, PanelBucketState][] = [];
      for (const [bucket, state] of Object.entries(prev)) {
        if (bucket !== activeBucket && !state.open && state.tabs.length === 0) {
          changed = true; // drop it
          continue;
        }
        nextEntries.push([bucket, state]);
      }
      if (!prev[activeBucket]) {
        nextEntries.push([activeBucket, hydratePanelBucketState(activeBucket)]);
        changed = true;
      }
      return changed ? Object.fromEntries(nextEntries) : prev;
    });
  }, [activeBucket]);

  // Persist only buckets whose serialized panel state actually changed, so a
  // single-bucket edit (e.g. switching a tab) doesn't rewrite every bucket's
  // localStorage key.
  const savedPanelSnapshotsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const seen = new Set<string>();
    for (const [bucket, state] of Object.entries(panelByBucket)) {
      seen.add(bucket);
      const snapshot = { open: state.open, tabs: state.tabs, activeId: state.activeId };
      const serialized = JSON.stringify(snapshot);
      if (savedPanelSnapshotsRef.current.get(bucket) === serialized) continue;
      savePanelState<PanelTab>(bucket, snapshot);
      savedPanelSnapshotsRef.current.set(bucket, serialized);
    }
    // Forget buckets that were removed (e.g. pruned or session-deleted); their
    // localStorage key is cleared at the removal site, so just drop the cache.
    for (const bucket of [...savedPanelSnapshotsRef.current.keys()]) {
      if (!seen.has(bucket)) savedPanelSnapshotsRef.current.delete(bucket);
    }
  }, [panelByBucket]);

  const activePanelState = panelByBucket[activeBucket] ?? emptyPanelBucketState();

  const panelBuckets = useMemo(() => {
    const buckets = new Set<string>();
    for (const [bucket, state] of Object.entries(panelByBucket)) {
      if (state.tabs.length > 0) buckets.add(bucket);
    }
    if (activePanelState.open || activePanelState.tabs.length > 0) buckets.add(activeBucket);
    return [...buckets];
  }, [activeBucket, activePanelState.open, activePanelState.tabs.length, panelByBucket]);

  const togglePanel = (): void =>
    updatePanelBucket(activeBucket, (state) => {
      const open = !state.open;
      return {
        ...state,
        open,
        requestNonce: state.requestNonce + 1,
        requestKind: null,
        openUrl: open ? state.openUrl : undefined,
      };
    });

  const openPanel = (kind: PanelTab): void =>
    updatePanelBucket(activeBucket, (state) => ({
      ...state,
      open: true,
      requestNonce: state.requestNonce + 1,
      requestKind: kind,
    }));

  // Dock width (px), persisted. The divider on the dock's left edge drags it.
  const PANEL_MIN = 320;
  const PANEL_MAX_FRAC = 0.7; // never let the dock eat more than 70% of the window
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("codeshell.panelWidth"));
    return Number.isFinite(saved) && saved >= PANEL_MIN ? saved : 480;
  });
  const panelWidthRef = useRef(panelWidth);
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    panelWidthRef.current = panelWidth;
  }, [panelWidth]);
  useEffect(
    () => () => {
      panelResizeCleanupRef.current?.();
    },
    [],
  );
  const beginPanelResize = (startX: number, startWidth: number): void => {
    panelResizeCleanupRef.current?.();
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    let disposed = false;
    const onMove = (ev: MouseEvent): void => {
      // Dock is on the RIGHT, so dragging left (smaller clientX) widens it.
      const delta = startX - ev.clientX;
      const max = Math.max(PANEL_MIN, Math.floor(window.innerWidth * PANEL_MAX_FRAC));
      const next = Math.min(max, Math.max(PANEL_MIN, startWidth + delta));
      panelWidthRef.current = next;
      setPanelWidth(next);
    };
    const cleanup = (persist: boolean): void => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onAbort);
      window.removeEventListener("pointercancel", onAbort);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      panelResizeCleanupRef.current = null;
      if (persist) localStorage.setItem("codeshell.panelWidth", String(panelWidthRef.current));
    };
    const onUp = (): void => cleanup(true);
    const onAbort = (): void => cleanup(true);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onAbort);
    window.addEventListener("pointercancel", onAbort);
    panelResizeCleanupRef.current = () => cleanup(false);
  };

  // Conversational automation creation: seed the chat composer with a starter
  // prompt and switch to chat. The agent explains automation, asks what to do
  // and when, then calls CronCreate — the user never touches cron syntax.
  const [composerSeed, setComposerSeed] = useState("");
  const [composerSeedNonce, setComposerSeedNonce] = useState(0);
  const composerSeedNonceRef = useRef(0);
  const seedComposer = useCallback((text: string): void => {
    const nonce = composerSeedNonceRef.current + 1;
    composerSeedNonceRef.current = nonce;
    setComposerSeed(text);
    setComposerSeedNonce(nonce);
  }, []);
  const onComposerSeedConsumed = useCallback((nonce: number): void => {
    // An older ChatView effect must never clear a newer request.
    if (nonce === composerSeedNonceRef.current) setComposerSeed("");
  }, []);
  useEffect(
    () =>
      onComposerSeedRequest((request) => {
        // Keep the current conversation bucket. Unlike conversational
        // automation creation, a plugin starter prompt is an explicit draft
        // for the session the user was viewing before opening Settings.
        seedComposer(request.text);
        setViewMode("chat");
      }),
    [seedComposer, setViewMode],
  );
  const startConversationalAutomation = (): void => {
    // Start a FRESH draft session — never pile onto whatever task/run session
    // happened to be active. Mirrors handleNewConversation: clear
    // activeSessionId so a brand-new session materializes on first send.
    const projectId = activeProjectId;
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegmentFor(projectId)]: setActiveSession(projectId, null),
    }));
    seedComposer(t("misc.app.automationSeed"));
    setViewMode("chat");
  };

  // A chat "files changed" card asked to review its edited files: open the
  // review panel in the dock, focused on those files.
  useEffect(() => {
    const onReview = (e: Event): void => {
      const detail = (e as CustomEvent<{ files?: string[]; diff?: string }>).detail;
      const files = detail?.files;
      updatePanelBucket(activeBucketRef.current, (state) => ({
        ...state,
        open: true,
        reviewFiles: Array.isArray(files) && files.length > 0 ? files : undefined,
        reviewDiff: detail?.diff || undefined,
        requestNonce: state.requestNonce + 1,
        requestKind: "review",
      }));
    };
    window.addEventListener("codeshell:review-files", onReview);
    return () => window.removeEventListener("codeshell:review-files", onReview);
  }, [updatePanelBucket]);

  // A chat answer link (http/https) was clicked: open it in the in-app browser
  // panel instead of the OS browser. BrowserPanel listens for the same event to
  // open the URL in a new tab; here we just surface the dock + browser panel.
  useEffect(() => {
    const onOpenUrl = (e: Event): void => {
      const detail = (e as CustomEvent<{ url?: string; bucket?: string }>).detail;
      const url = detail?.url;
      if (!url) return;
      const targetBucket = detail?.bucket || activeBucketRef.current;
      // Carry the URL down on the target bucket BEFORE surfacing the panel, so
      // a freshly-mounted BrowserPanel navigates to it immediately.
      const nonce = (openUrlNonceRef.current ?? 0) + 1;
      openUrlNonceRef.current = nonce;
      updatePanelBucket(targetBucket, (state) => ({
        ...state,
        open: true,
        openUrl: { url, nonce },
        requestNonce: state.requestNonce + 1,
        requestKind: "browser",
      }));
    };
    window.addEventListener("codeshell:open-url", onOpenUrl);
    return () => window.removeEventListener("codeshell:open-url", onOpenUrl);
  }, [updatePanelBucket]);

  useEffect(() => {
    const onOpenCliSession = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<OpenCliSessionEventDetail>>).detail;
      if (
        typeof detail?.externalSessionId !== "string" ||
        !detail.externalSessionId.trim() ||
        typeof detail.cwd !== "string" ||
        !detail.cwd.trim() ||
        typeof detail.sourceSessionId !== "string" ||
        !detail.sourceSessionId.trim() ||
        (detail.cliKind !== "claude-code" && detail.cliKind !== "codex")
      ) {
        return;
      }
      const targetBucket = resolveOpenCliSessionBucket(
        detail.sourceSessionId,
        engineToBucketRef.current,
        sessionIndicesRef.current,
      );
      if (!targetBucket) {
        toast({
          message: t("panels.room.ownerSessionUnavailable"),
          variant: "error",
        });
        return;
      }
      const nonce = nextOpenCliSessionNonce();
      updatePanelBucket(targetBucket, (state) => ({
        ...state,
        open: true,
        openCliSession: {
          nonce,
          externalSessionId: detail.externalSessionId!,
          cliKind: detail.cliKind!,
          cwd: detail.cwd!,
        },
        requestNonce: state.requestNonce + 1,
        requestKind: "ccRoom",
      }));
    };
    window.addEventListener("codeshell:open-cli-session", onOpenCliSession);
    return () => window.removeEventListener("codeshell:open-cli-session", onOpenCliSession);
  }, [t, toast, updatePanelBucket]);

  // A chat answer's file path link was clicked: open it in the in-app Files
  // panel. FilesPanel listens for the same event to select + reveal the file;
  // here we just surface the dock + files panel.
  useEffect(() => {
    const onOpenFile = (e: Event): void => {
      const detail = (e as CustomEvent<{ path?: string; cwd?: string | null }>).detail;
      if (!detail?.path) return;
      const nonce = (revealFileNonceRef.current ?? 0) + 1;
      revealFileNonceRef.current = nonce;
      // Fresh, un-consumed request — the targeted (or newly opened) Files panel
      // reveals it, then reports back via onRevealConsumed so we flip `consumed`
      // true. The request lingers on the shared prop (so a LATER manually-opened
      // Files tab sees it already-consumed and does NOT replay it — the "new tab
      // shows the old file" bug), but we mark it consumed only AFTER a panel has
      // actually revealed it. The old code flipped `consumed` on a setTimeout(0),
      // which raced the freshly-mounted panel's effect: when THIS click also
      // created the Files tab, the flip landed before the new panel's reveal
      // effect ran, so the first click opened an empty tab and you had to click
      // again. Event-driven consume removes that race.
      updatePanelBucket(activeBucketRef.current, (state) => ({
        ...state,
        open: true,
        revealFile: { path: detail.path!, cwd: detail.cwd ?? null, nonce, consumed: false },
        requestNonce: state.requestNonce + 1,
        requestKind: "files",
      }));
    };
    window.addEventListener("codeshell:open-file", onOpenFile);
    return () => window.removeEventListener("codeshell:open-file", onOpenFile);
  }, [updatePanelBucket]);

  // A panel pinned a comment anchor (diff line / browser element / file line).
  // Accumulate it as a chip above the composer (into the active bucket).
  useEffect(() => {
    const onAnchor = (e: Event): void => {
      const anchor = (e as CustomEvent<{ anchor?: Anchor }>).detail?.anchor;
      if (anchor) {
        setAnchorsByBucket((s) => addAnchorTo(s, activeAnchorBucketRef.current, anchor));
      }
    };
    window.addEventListener("codeshell:add-anchor", onAnchor);
    return () => window.removeEventListener("codeshell:add-anchor", onAnchor);
  }, []);

  // A browser popout window pinned an element anchor; it arrives over IPC
  // (no id assigned yet). Add it to the composer like a local one. Removals
  // initiated in a popout arrive the same way (by anchor id).
  useEffect(() => {
    const offAdd = window.codeshell.onBrowserAnchorFromPopout((raw) => {
      const a = raw as Omit<Anchor, "id">;
      if (a && a.kind && a.locator) {
        setAnchorsByBucket((s) =>
          addAnchorTo(s, activeAnchorBucketRef.current, { ...a, id: nextAnchorId() }),
        );
      }
    });
    const offRemove = window.codeshell.onBrowserAnchorRemoveFromPopout((id) => {
      if (typeof id === "string" && id) {
        setAnchorsByBucket((s) => removeAnchorFrom(s, activeAnchorBucketRef.current, id));
      }
    });
    const offUpdate = window.codeshell.onBrowserAnchorUpdateFromPopout((raw) => {
      const u = raw as { id?: string; comment?: string };
      if (u && typeof u.id === "string" && typeof u.comment === "string") {
        setAnchorsByBucket((s) =>
          updateAnchorCommentIn(s, activeAnchorBucketRef.current, u.id!, u.comment!),
        );
      }
    });
    return () => {
      offAdd();
      offRemove();
      offUpdate();
    };
  }, []);

  // Push the active bucket's browser anchors to main, which broadcasts them to
  // every browser popout window — the single state-down pipe that keeps all
  // browser surfaces showing the same annotation set (and clears them all when
  // a message sends). The main-window BrowserPanel gets the same list as a
  // plain prop instead.
  const browserAnchors = useMemo(() => browserAnchorsOf(anchors), [anchors]);
  useEffect(() => {
    window.codeshell.syncBrowserAnchors(browserAnchors);
  }, [browserAnchors]);

  return {
    panelByBucket,
    setPanelByBucket,
    updatePanelBucket,
    onRevealConsumed,
    onOpenCliSessionConsumed,
    ensureQuickChatSession,
    cleanupQuickChatPanelSession,
    restartQuickChatSession,
    setQuickChatDraft,
    setQuickChatAttachmentState,
    setQuickChatPermission,
    setQuickChatModel,
    activePanelState,
    panelBuckets,
    togglePanel,
    openPanel,
    panelWidth,
    beginPanelResize,
    composerSeed,
    composerSeedNonce,
    onComposerSeedConsumed,
    startConversationalAutomation,
    anchors,
    anchorsByBucket,
    browserAnchors,
    removeAnchor,
    updateAnchorComment,
    clearAnchors,
  };
}
