import { RoomHistoryAccumulator } from "../lib/roomHistory.js";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  MobileServerEvent,
  MobileSessionMeta,
  MobileProjectMeta,
  RoomPublic,
  MobileRemotePermissionMode as PermissionMode,
  ApprovalScope,
  ApprovalPathScope,
  CcDiscoveredSession,
  MobileImageBase,
  OutputHistoryRecoveryAcceptance,
  OutputHistoryRecoveryPlan,
  OutputHistoryRecoveryResult,
  MobileHistoryDetail,
  MobileHistoryItem,
} from "@cjhyy/code-shell-core";
import {
  reduceStream,
  initialChatState,
  appendUserMessage,
  type ChatState,
} from "../lib/streamReducer.js";
import { t } from "../i18n/translate.js";
import { summarizeApproval, type Risk } from "../lib/riskClassify.js";
import {
  roomMsgToEvent,
  roomHistoryToEvents,
  ccHistoryToEvents,
  extractAskUserOptions,
} from "../lib/messageMappers.js";
import { projectForCwd } from "../lib/format.js";
import { MobileOutputClient } from "./mobileOutputClient.js";
import { HistoryReadBusyError } from "./mobileHistoryReadQueue.js";
import type { MobileRecoveryProgress } from "../lib/mobileOutputRecovery.js";
import { MobileHistoryRecoveryRequests } from "./mobileHistoryRecoveryRequests.js";
import { useRemoteSocket, type ConnStatus } from "./useRemoteSocket.js";
import {
  prepareMobileAttachments,
  type MobileComposerAttachment,
  type MobileUploadTicket,
} from "../lib/mobileAttachments.js";
import {
  filterNewRoomMessages,
  clearUnreadSession,
  markSessionUnread,
  markRoomSeqApplied,
  maxRoomSeq,
  alignSessionEpoch,
  pruneUnreadSessions,
  rawApprovalResolvedRequestId,
  removeResolvedApproval,
  roomMessageSeq,
  selectSessionReplayEntries,
  type SessionReplayEntry,
  type SessionStreamCursor,
} from "./remoteAppSync.js";

/** The host explicitly refused a message, so it was not admitted. */
class MessageRejectedError extends Error {}
/** A recovery invalidated delivery authority; the content must remain a manual draft. */
class MessageRetiredError extends Error {}

/** Which external coding-CLI the CC pane drives. Mirrors desktop CCRoomView. */
export type CcCliKind = "claude-code" | "codex";
export type MobileRuntimeModel = Extract<
  MobileServerEvent,
  { type: "runtime.models.ok" }
>["models"][number];

export interface PendingApproval {
  requestId: string;
  sessionId?: string;
  /** Set for cc-room (external claude CLI) approvals — routes the response via
   *  respondCcApproval(roomId, …) instead of the session approval path. */
  roomId?: string;
  toolName: string;
  description: string;
  summary: string;
  risk: Risk;
  /** AskUser options, when this is an AskUser approval. */
  options?: string[];
  /** When true, the user must pick an option (no free text). */
  optionsOnly?: boolean;
  /** CLI AskUserQuestion asking several questions in one request. They are
   *  answered together: the request accepts exactly one response. */
  questions?: Array<{ question: string; header?: string; options: string[]; multiSelect: boolean }>;
  /** A nonblocking question remains answerable after the run ends. */
  asynchronous?: boolean;
  /** True for path-scoped tools (Read/Edit/Write/…) → show file/dir scope. */
  pathScoped: boolean;
}

export interface RemoteApp {
  status: ConnStatus;
  accessRequired?: boolean;
  deviceName: string;
  chat: ChatState;
  sessions: MobileSessionMeta[];
  sessionsHasMore?: boolean;
  loadMoreSessions?: () => void;
  unreadSessionIds: ReadonlySet<string>;
  activeSessionId?: string;
  /** User navigation changes this; asynchronously binding a new session does not. */
  conversationRevision: number;
  /** Increments when this browser's pending session creation fails or loses its connection. */
  sessionCreationFailures?: number;
  /** A never-submitted draft needs a new Host selection after reconnecting. */
  emptySessionReplacement?: {
    fromSessionId: string;
    toSessionId?: string;
    status: "pending" | "failed" | "complete";
  };
  retryEmptySessionReplacement?: () => void;
  activeCwd?: string | null;
  projects: MobileProjectMeta[];
  /** The bound room — for the user this is always an external CC (Claude Code)
   *  session. The room is internal transport; there is no user-facing room list. */
  activeRoom?: RoomPublic;
  /** Set while a CLI room is bound, even before its metadata has loaded. */
  activeRoomId?: string;
  approvals: PendingApproval[];
  permissionMode: PermissionMode;
  runtimeModels?: MobileRuntimeModel[];
  runtimeModelsLoading?: boolean;
  runtimeModelsError?: string;
  refreshRuntimeModels?: () => void;
  loading: {
    sessions: boolean;
    sessionHistory: boolean;
    /** Internal: the room.list fetch that resolves `activeRoom`'s metadata for a
     *  bound CC session. No user-facing room list consumes this. */
    rooms: boolean;
    projects: boolean;
    roomHistory: boolean;
    ccSessions: boolean;
  };
  notice?: string;
  sessionHistoryProgress?: MobileRecoveryProgress;
  historyHasEarlier?: boolean;
  historyLoadingEarlier?: boolean;
  historyEarlierError?: string;
  loadEarlierHistory?: () => Promise<void>;
  loadHistoryDetail?: (ref: string) => Promise<MobileHistoryDetail>;
  reloadHistory?: () => void;
  outputHistoryFailed?: boolean;
  outputHistoricalGap?: boolean;
  outputRecoveryIdentity?: string;
  getSessionOutputRecoveryPlan?: (sessionId: string) => Promise<OutputHistoryRecoveryPlan>;
  applySessionOutputRecovery?: (
    sessionId: string,
    acceptance: OutputHistoryRecoveryAcceptance,
  ) => Promise<OutputHistoryRecoveryResult>;
  logout: () => void;
  // actions
  /** Resolves true once the host accepted the message. */
  sendChat: (input: {
    text: string;
    attachments: MobileComposerAttachment[];
    modelKey?: string;
    modelTraceSource?: string;
    /** Retry an earlier intent whose delivery could not be confirmed. The host
     *  ignores an ID it already recorded, so the task never runs twice. */
    clientMessageId?: string;
    /** The frame reached the socket but neither acceptance nor rejection
     *  arrived (lost connection or timeout): the host may have run it. */
    onUncertain?: (clientMessageId: string) => void;
    onRetired?: () => void;
  }) => Promise<boolean>;
  stopRun: () => void;
  selectSession: (id: string) => void;
  newSession: (target?: MobileSessionCreateTarget, name?: string) => void;
  /** Omit roots to refresh the current scope; [] selects all projects. */
  refreshSessions: (cwds?: string[]) => void;
  respondApproval: (
    requestId: string,
    decision: "approve" | "reject",
    opts?: {
      reason?: string;
      answer?: string;
      scope?: ApprovalScope;
      pathScope?: ApprovalPathScope;
    },
  ) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  extendGoal: (sessionId: string) => void;
  clearGoal: (sessionId: string) => void;
  /** Leave the bound CC session (drops the room binding, clears the feed). */
  leaveRoom: () => void;
  // cc rooms (external claude CLI sessions, per selected project)
  activeProjectCwd: string | null;
  activeProjectId: string | null;
  selectProject: (projectIdOrCwd: string) => void;
  ccSessions: CcDiscoveredSession[];
  ccSessionsTotal?: number;
  loadAllCcSessions?: () => void;
  ccProbe: { available: boolean; reason?: string } | null;
  /** Selected CC CLI (Claude Code / Codex). Switching re-probes + re-lists. */
  ccCliKind: CcCliKind;
  setCcCliKind: (kind: CcCliKind) => void;
  openCcSession: (sessionId: string, cwd: string, mode: PermissionMode) => void;
  respondCcApproval: (roomId: string, requestId: string, decision: CcApprovalDecision) => void;
}

type CcApprovalDecision = Extract<
  import("@cjhyy/code-shell-core").MobileClientEvent,
  { type: "ccRoom.respondApproval" }
>["decision"];

export type MobileSessionCreateTarget =
  | { projectId: string; rootId?: string }
  | { projectId: null }
  | string
  | null;

/** Tools whose grants can be remembered with a path scope (file/dir). */
const PATH_SCOPED = new Set([
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "Glob",
  "Grep",
  "ApplyPatch",
]);

function projectContextCwd(
  cwd: string | null | undefined,
  projects: MobileProjectMeta[],
): string | null | undefined {
  if (!cwd) return cwd;
  return projectForCwd(cwd, projects)?.path ?? cwd;
}

type ChatAction =
  | { kind: "raw"; raw: unknown }
  | {
      kind: "user";
      text: string;
      clientMessageId?: string;
      attachments?: Array<{ name: string; mime?: string; size: number }>;
    }
  | { kind: "hydrate"; chat: ChatState; verifiedInputIds?: string[] }
  | { kind: "prependHistory"; sessionId: string; items: MobileHistoryItem[] }
  | { kind: "reset" }
  | { kind: "stream_epoch_changed" }
  | { kind: "replay"; events: unknown[] }
  | { kind: "append"; events: unknown[] };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "raw":
      return reduceStream(state, action.raw);
    case "user":
      return appendUserMessage(state, action.text, action.attachments, action.clientMessageId);
    case "prependHistory": {
      if (state.sessionId !== action.sessionId) return state;
      const seen = new Set(state.items.map((item) => item.id));
      return {
        ...state,
        items: [...action.items.filter((item) => !seen.has(item.id)), ...state.items],
      };
    }
    case "hydrate": {
      const ids = new Set(
        action.chat.items.flatMap((item) =>
          item.kind === "user" && item.clientMessageId ? [item.clientMessageId] : [],
        ),
      );
      for (const id of action.verifiedInputIds ?? []) ids.add(id);
      const pending = state.items.filter(
        (item) => item.kind === "user" && item.clientMessageId && !ids.has(item.clientMessageId),
      );
      return { ...action.chat, items: [...action.chat.items, ...pending] };
    }
    case "reset":
      return initialChatState();
    case "stream_epoch_changed": {
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        run: "idle",
        liveByAgent: {},
        orphanResults: undefined,
        items: state.items.map((item) =>
          item.kind === "assistant"
            ? { ...item, done: true }
            : item.kind === "tool"
              ? { ...item, id: `prior-${seq}-${item.id}`, done: true }
              : item,
        ),
      };
    }
    case "replay":
      return action.events.reduce(reduceStream, initialChatState());
    case "append":
      return action.events.reduce(reduceStream, state);
  }
}

export interface RemoteAppOptions {
  /** Browser host features may observe notifications without opening a second
   * transport or changing the session/room reducer's ownership. */
  onNotification?: (method: string, params: Record<string, unknown>) => void;
}

export function useRemoteApp(options: RemoteAppOptions = {}): RemoteApp {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [chat, dispatchChat] = useReducer(chatReducer, undefined, initialChatState);
  const [sessions, setSessions] = useState<MobileSessionMeta[]>([]);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const sessionListCursorRef = useRef<string | null>(null);
  const sessionListScopeRef = useRef<string[] | undefined>(undefined);
  const sessionListSequenceRef = useRef(0);
  const sessionListPagedRef = useRef(false);
  const sessionListRequestRef = useRef<{ requestId: string; append: boolean } | undefined>(
    undefined,
  );
  const [runtimeModels, setRuntimeModels] = useState<MobileRuntimeModel[]>([]);
  const [runtimeModelsLoading, setRuntimeModelsLoading] = useState(false);
  const [runtimeModelsError, setRuntimeModelsError] = useState<string>();
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [sessionCreationFailures, setSessionCreationFailures] = useState(0);
  const [activeSessionCwd, setActiveSessionCwd] = useState<string | null | undefined>();
  const [rooms, setRooms] = useState<RoomPublic[]>([]);
  const roomsRef = useRef<RoomPublic[]>(rooms);
  roomsRef.current = rooms;
  const [projects, setProjects] = useState<MobileProjectMeta[]>([]);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>();
  // activeRoomId via ref so socket callbacks see the latest value.
  const activeRoomIdRef = useRef<string | undefined>(undefined);
  activeRoomIdRef.current = activeRoomId;
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const approvalsRef = useRef(approvals);
  approvalsRef.current = approvals;
  const submittingAsyncApprovalsRef = useRef(new Set<string>());
  /** Synchronous approvals whose card was consumed on send. A correlated
   *  delivery error asks Main to replay them if Core still holds the request. */
  const submittedApprovalsRef = useRef(new Set<string>());
  const retiredApprovalsRef = useRef(new Set<string>());
  const requestActiveResyncRef = useRef<() => void>(() => undefined);
  // The SELECTED project (one-true-source for "what am I looking at"), distinct
  // from activeSessionCwd which is derived from the bound session. Drives session
  // list filtering AND ccRoom.listSessions.
  const [activeProjectCwd, setActiveProjectCwd] = useState<string | null>(null);
  const activeProjectCwdRef = useRef(activeProjectCwd);
  activeProjectCwdRef.current = activeProjectCwd;
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  // Which external CLI the CC pane is showing (Claude Code or Codex). Switching
  // re-probes + re-lists for that CLI (mirrors desktop CCRoomView's cliKind).
  const [ccCliKind, setCcCliKind] = useState<CcCliKind>("claude-code");
  const ccCliKindRef = useRef<CcCliKind>(ccCliKind);
  ccCliKindRef.current = ccCliKind;
  // External-CLI sessions discovered for activeProjectCwd (under ccCliKind).
  const [ccSessions, setCcSessions] = useState<CcDiscoveredSession[]>([]);
  const [ccSessionsTotal, setCcSessionsTotal] = useState(0);
  const ccShowAllRef = useRef(false);
  const [ccProbe, setCcProbe] = useState<{ available: boolean; reason?: string } | null>(null);
  /** socket.send via ref — onServerEvent is created BEFORE the socket (it's the
   *  socket's callback), so it can't close over `socket` directly. */
  const sendRef = useRef<
    | ((
        e: import("@cjhyy/code-shell-core").MobileClientEvent,
        expectedGeneration?: number,
      ) => boolean)
    | null
  >(null);
  const connectionGenerationRef = useRef(0);
  /** Image PUTs in flight; a lost connection aborts them so sending recovers. */
  const uploadAbortsRef = useRef(new Set<AbortController>());
  const uploadWaitersRef = useRef(
    new Map<
      string,
      {
        resolve: (ticket: MobileUploadTicket) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        connectionGeneration: number;
      }
    >(),
  );
  const conversationRevisionRef = useRef(0);
  const socketOnlineRef = useRef(false);
  const historyWindowRef = useRef<
    | { sessionId: string; id: string; hasEarlier: boolean; loading?: boolean; error?: string }
    | undefined
  >(undefined);
  const [historyWindow, setHistoryWindow] = useState<typeof historyWindowRef.current>();
  const [historyProgress, setHistoryProgress] = useState<{
    sessionId: string;
    progress: MobileRecoveryProgress;
  }>();
  const [outputHistory, setOutputHistory] = useState<{
    sessionId: string;
    failed: boolean;
    historicalGap?: boolean;
  }>();
  const recoveryFencesRef = useRef(new Set<string>());
  const outputWriteGenerationRef = useRef(0);
  const applyingHistoryRef = useRef<string | undefined>(undefined);
  const [historyRecovery] = useState(
    () =>
      new MobileHistoryRecoveryRequests({
        send: (event) => sendRef.current?.(event) ?? false,
        current: () => ({
          sessionId: boundSessionRef.current,
          roomId: activeRoomIdRef.current,
          revision: conversationRevisionRef.current,
          generation: connectionGenerationRef.current,
          online: socketOnlineRef.current,
        }),
      }),
  );
  useEffect(() => () => historyRecovery.cancel(), [historyRecovery]);
  // A first send can use the Host's implicit session. Once an uncertain reply
  // identifies it, pin retries to that session even if the Host's selection moves.
  const uncertainMessageSessionsRef = useRef(new Map<string, string>());
  const pendingCreateRef = useRef<{
    clientRequestId: string;
    permissionMode: PermissionMode;
    target: MobileSessionCreateTarget;
    replacesSessionId?: string;
    conversationRevision: number;
    connectionGeneration: number;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const unsentCreatedSessionRef = useRef<{
    sessionId: string;
    generation: number;
    target: MobileSessionCreateTarget;
  } | null>(null);
  const replacementSourceRef = useRef<typeof unsentCreatedSessionRef.current>(null);
  const [emptySessionReplacement, setEmptySessionReplacementState] =
    useState<RemoteApp["emptySessionReplacement"]>();
  const emptySessionReplacementRef = useRef<RemoteApp["emptySessionReplacement"]>(undefined);
  const setEmptySessionReplacement = useCallback((value: RemoteApp["emptySessionReplacement"]) => {
    emptySessionReplacementRef.current = value;
    setEmptySessionReplacementState(value);
  }, []);
  const messageAckWaitersRef = useRef(
    new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        connectionGeneration: number;
        conversationRevision: number;
      }
    >(),
  );
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("default");
  const permissionModeRef = useRef<PermissionMode>("default");
  const creationPermissionEchoRef = useRef<{ sessionId: string; mode: PermissionMode } | null>(
    null,
  );
  /** Transient banner message (errors, room-missing, …). Auto-clears. */
  const [notice, setNoticeState] = useState<string | undefined>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeMounted = useRef(true);
  useEffect(() => {
    noticeMounted.current = true;
    return () => {
      noticeMounted.current = false;
      if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current);
      noticeTimer.current = undefined;
    };
  }, []);
  const setNotice = useCallback((msg: string) => {
    if (!noticeMounted.current) return;
    setNoticeState(msg);
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      if (!noticeMounted.current) return;
      noticeTimer.current = undefined;
      setNoticeState(undefined);
    }, 5000);
  }, []);
  const failSessionCreation = useCallback((clientRequestId?: string): boolean => {
    const pending = pendingCreateRef.current;
    if (!pending || (clientRequestId && pending.clientRequestId !== clientRequestId)) return false;
    clearTimeout(pending.timer);
    pendingCreateRef.current = null;
    if (
      pending.replacesSessionId &&
      emptySessionReplacementRef.current?.fromSessionId === pending.replacesSessionId
    )
      setEmptySessionReplacement({ fromSessionId: pending.replacesSessionId, status: "failed" });
    setSessionCreationFailures((value) => value + 1);
    return true;
  }, []);
  const beginMobileUpload = useCallback(
    (metadata: MobileImageBase, expectedGeneration: number): Promise<MobileUploadTicket> => {
      return new Promise((resolve, reject) => {
        if (!sendRef.current) {
          reject(new Error("Remote connection is unavailable"));
          return;
        }
        const previous = uploadWaitersRef.current.get(metadata.clientId);
        if (previous) {
          clearTimeout(previous.timer);
          previous.reject(new Error("Attachment upload was replaced"));
        }
        const timer = setTimeout(() => {
          uploadWaitersRef.current.delete(metadata.clientId);
          reject(new Error("Attachment upload ticket timed out"));
        }, 10_000);
        uploadWaitersRef.current.set(metadata.clientId, {
          resolve,
          reject,
          timer,
          connectionGeneration: expectedGeneration,
        });
        if (
          !sendRef.current({ type: "attachment.upload.begin", ...metadata }, expectedGeneration)
        ) {
          uploadWaitersRef.current.delete(metadata.clientId);
          clearTimeout(timer);
          reject(new Error("Remote connection changed before upload ticket request"));
        }
      });
    },
    [],
  );

  const waitForMessageAck = useCallback(
    (
      clientMessageId: string,
      connectionGeneration: number,
      conversationRevision: number,
    ): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          messageAckWaitersRef.current.delete(clientMessageId);
          reject(new Error("Message acknowledgement timed out"));
        }, 15_000);
        messageAckWaitersRef.current.set(clientMessageId, {
          resolve,
          reject,
          timer,
          connectionGeneration,
          conversationRevision,
        });
      }),
    [],
  );

  const settleMessageAck = useCallback((clientMessageId: string, error?: Error): void => {
    const waiter = messageAckWaitersRef.current.get(clientMessageId);
    if (!waiter) return;
    messageAckWaitersRef.current.delete(clientMessageId);
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }, []);

  useEffect(
    () => () => {
      clearTimeout(pendingCreateRef.current?.timer);
      pendingCreateRef.current = null;
      for (const upload of uploadAbortsRef.current) upload.abort(new Error("Remote app closed"));
      uploadAbortsRef.current.clear();
      for (const waiter of uploadWaitersRef.current.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Remote app closed"));
      }
      uploadWaitersRef.current.clear();
      for (const waiter of messageAckWaitersRef.current.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Remote app closed"));
      }
      messageAckWaitersRef.current.clear();
    },
    [],
  );
  /** Which session id the chat view is bound to (for filtering live stream). */
  const boundSessionRef = useRef<string | undefined>(undefined);
  /** Observed/applied cursors always belong to the same Main process epoch. */
  const sessionCursorsRef = useRef<Map<string, SessionStreamCursor>>(new Map());
  /** A newly selected epoch must load its durable history before live recovery. */
  const epochHistorySessionRef = useRef<string | undefined>(undefined);
  const sessionCursor = useCallback((sessionId: string): SessionStreamCursor => {
    let cursor = sessionCursorsRef.current.get(sessionId);
    if (!cursor) {
      cursor = { appliedSeq: 0, observedSeq: 0, awaitingSnapshot: false };
      sessionCursorsRef.current.set(sessionId, cursor);
    }
    return cursor;
  }, []);
  /** Highest room message seq seen per active room. Used as room.history cursor. */
  const lastRoomSeqRef = useRef<Map<string, number>>(new Map());
  /** Recent room seqs already folded into the reducer, for idempotent history/live merge. */
  const roomCatchupRef = useRef<
    | {
        roomId: string;
        requestId: string;
        pager: RoomHistoryAccumulator;
        live: Map<number, unknown>;
        failed?: boolean;
      }
    | undefined
  >(undefined);
  const roomRequestCounterRef = useRef(0);
  const appliedRoomSeqsRef = useRef<Map<string, Set<number>>>(new Map());
  /** The cc (external claude CLI) session id whose on-disk transcript is the
   *  backlog for the current room view. Set on ccRoom.opened, cleared whenever we
   *  switch to a plain session/room so late disk-history replies cannot replay
   *  into a different conversation. */
  const ccHistorySessionRef = useRef<string | undefined>(undefined);
  /** Cwd bound to the currently-open CC room. Project selection may change
   * independently while this room stays open, so reconnect must not derive the
   * subscription cwd from activeProjectCwd. */
  const ccHistoryCwdRef = useRef<string | undefined>(undefined);
  /** openSession replies do not echo cwd. Keep it keyed by the requested
   * session until ccRoom.opened confirms which room acquired it. The
   * conversation revision of the request lets a reply that arrives after the
   * user navigated elsewhere be discarded instead of navigating back. */
  const pendingCcOpensRef = useRef<Map<string, { cwd: string; revision: number }>>(new Map());
  const ccBacklogLoadedRef = useRef(false);
  /** Which CLI the currently-open cc session belongs to — selects the on-disk
   *  history reader (claude vs codex rollout) for ccRoom.readHistory. Captured
   *  at open time so a later CLI switch can't misroute this session's backlog. */
  const ccHistoryKindRef = useRef<CcCliKind>("claude-code");
  const activeCwdRef = useRef<string | null | undefined>(undefined);
  const [loading, setLoading] = useState<RemoteApp["loading"]>({
    sessions: false,
    sessionHistory: false,
    rooms: false,
    projects: false,
    roomHistory: false,
    ccSessions: false,
  });

  const setLoadingKey = useCallback((key: keyof RemoteApp["loading"], value: boolean) => {
    setLoading((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const requestSessionList = useCallback(
    (append = false, cwds?: string[]) => {
      if (append && (!sessionListCursorRef.current || sessionListRequestRef.current)) return;
      if (cwds !== undefined) {
        const next = cwds.length ? [...new Set(cwds)].sort() : undefined;
        if (JSON.stringify(next) !== JSON.stringify(sessionListScopeRef.current)) setSessions([]);
        sessionListScopeRef.current = next;
      }
      const cursor = append ? sessionListCursorRef.current : undefined;
      const requestId = `sessions-${++sessionListSequenceRef.current}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      sessionListRequestRef.current = { requestId, append };
      if (!append) {
        sessionListCursorRef.current = null;
        setSessionsHasMore(false);
      }
      setLoadingKey("sessions", true);
      if (
        !sendRef.current?.({
          type: "session.list",
          requestId,
          ...(cursor ? { cursor } : {}),
          ...(sessionListScopeRef.current ? { cwds: sessionListScopeRef.current } : {}),
        })
      ) {
        sessionListRequestRef.current = undefined;
        setLoadingKey("sessions", false);
      }
    },
    [setLoadingKey],
  );

  const clearApproval = useCallback((requestId: string) => {
    submittingAsyncApprovalsRef.current.delete(requestId);
    submittedApprovalsRef.current.delete(requestId);
    approvalsRef.current = removeResolvedApproval(approvalsRef.current, requestId);
    setApprovals((prev) => removeResolvedApproval(prev, requestId));
  }, []);

  const rememberRoomMessages = useCallback(
    (roomId: string, messages: unknown[], latestSeq?: number) => {
      const current = lastRoomSeqRef.current.get(roomId) ?? 0;
      lastRoomSeqRef.current.set(roomId, maxRoomSeq(current, messages, latestSeq));
      for (const msg of messages) {
        const seq = roomMessageSeq(msg);
        if (seq !== undefined) markRoomSeqApplied(appliedRoomSeqsRef.current, roomId, seq);
      }
    },
    [],
  );

  const requestRoomCatchup = useCallback(
    (roomId: string, sinceSeq: number) => {
      const requestId = `room-history:${++roomRequestCounterRef.current}`;
      roomCatchupRef.current = {
        roomId,
        requestId,
        pager: new RoomHistoryAccumulator(sinceSeq),
        live: new Map(),
      };
      setLoadingKey("roomHistory", true);
      sendRef.current?.({
        type: "room.history",
        roomId,
        sinceSeq,
        page: true,
        requestId,
        limit: 200,
      });
    },
    [setLoadingKey],
  );

  const wrapSessionEvents = useCallback(
    (sessionId: string, events: unknown[]) =>
      events.map((event) => ({
        method: "agent/streamEvent",
        params: { sessionId, event },
      })),
    [],
  );

  const clearApprovalsIfTerminal = useCallback((events: unknown[]) => {
    if (
      events.some((event) => {
        const type = (event as { type?: unknown } | null)?.type;
        return type === "turn_complete" || type === "error";
      })
    ) {
      // Asynchronous questions outlive the current run. Only a resolution
      // notification (or a new worker epoch) makes their answer stale.
      approvalsRef.current = approvalsRef.current.filter((approval) => approval.asynchronous);
      setApprovals((prev) => prev.filter((approval) => approval.asynchronous));
    }
  }, []);

  const appendSessionEvents = useCallback(
    (sessionId: string, events: unknown[]) => {
      if (events.length === 0) return;
      dispatchChat({ kind: "append", events: wrapSessionEvents(sessionId, events) });
      clearApprovalsIfTerminal(events);
    },
    [clearApprovalsIfTerminal, wrapSessionEvents],
  );

  const clearSessionUnread = useCallback((sessionId?: string) => {
    setUnreadSessionIds((prev) => clearUnreadSession(prev, sessionId));
  }, []);

  const sessionCwdById = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const s of sessions) out.set(s.id, s.cwd || null);
    return out;
  }, [sessions]);

  const addApproval = useCallback((a: PendingApproval) => {
    if (retiredApprovalsRef.current.has(a.requestId)) return;
    if (
      applyingHistoryRef.current &&
      (a.sessionId ?? boundSessionRef.current) === applyingHistoryRef.current
    ) {
      retiredApprovalsRef.current.add(a.requestId);
      return;
    }
    // Isolate to the bound session: an approval for some OTHER desktop session
    // must not pop on this phone's feed. If nothing is bound yet, auto-bind to
    // the approval's session (same first-coherent-conversation rule as streams)
    // so the request the user sees belongs to the conversation they're driving.
    if (activeRoomIdRef.current) return; // rooms don't surface chat approvals
    if (a.sessionId) {
      if (boundSessionRef.current && a.sessionId !== boundSessionRef.current) return;
      // A pending creation owns the unbound view; only its acceptance binds it.
      if (!boundSessionRef.current && pendingCreateRef.current) return;
      if (!boundSessionRef.current) {
        boundSessionRef.current = a.sessionId;
        setActiveSessionId(a.sessionId);
      }
    }
    setApprovals((prev) => (prev.some((p) => p.requestId === a.requestId) ? prev : [...prev, a]));
  }, []);

  const requestSessionHistory = useCallback(
    (sessionId: string, select = false) => {
      if (
        (select && !sendRef.current?.({ type: "session.select", sessionId })) ||
        !sendRef.current?.({ type: "session.history", sessionId })
      ) {
        setLoadingKey("sessionHistory", false);
        setNotice(t("mobile.notice.sessionRecoveryIncomplete"));
        return false;
      }
      return true;
    },
    [setLoadingKey, setNotice],
  );

  const outputClientRef = useRef<MobileOutputClient | null>(null);
  const outputClient = (outputClientRef.current ??= new MobileOutputClient({
    send: (event) => sendRef.current?.(event) ?? false,
    current: () => ({
      sessionId: boundSessionRef.current,
      roomId: activeRoomIdRef.current,
      revision: conversationRevisionRef.current,
    }),
    historyWindow: (sessionId, window) => {
      const previous = historyWindowRef.current;
      const value = window
        ? { sessionId, ...window }
        : previous?.sessionId === sessionId
          ? undefined
          : previous;
      historyWindowRef.current = value;
      setHistoryWindow(value);
    },
    prependHistory: (sessionId, items) =>
      dispatchChat({ kind: "prependHistory", sessionId, items }),
    progress: (sessionId, progress) =>
      setHistoryProgress((previous) =>
        progress
          ? { sessionId, progress }
          : previous?.sessionId === sessionId
            ? undefined
            : previous,
      ),
    commit: (sessionId, result) => {
      const cursor = sessionCursor(sessionId);
      cursor.epoch = result.snapshot.epoch;
      cursor.appliedSeq = result.snapshot.nextSeq - 1;
      cursor.observedSeq = cursor.appliedSeq;
      cursor.awaitingSnapshot = false;
      cursor.historyUnpaired = undefined;
      epochHistorySessionRef.current = undefined;
      recoveryFencesRef.current.delete(sessionId);
      setOutputHistory((previous) => ({
        sessionId,
        failed: false,
        historicalGap:
          (result.snapshot as { historicalGap?: true }).historicalGap ||
          (previous?.sessionId === sessionId && previous.historicalGap) ||
          undefined,
      }));
      dispatchChat({
        kind: "hydrate",
        chat: result.chat,
        verifiedInputIds: result.verifiedInputIds ?? result.view?.verifiedInputIds,
      });
      setLoadingKey("sessionHistory", false);
      setNoticeState(undefined);
    },
    legacy: (sessionId, events?: Record<string, unknown>[]) => {
      if (boundSessionRef.current !== sessionId || activeRoomIdRef.current) return;
      // An explicit repair must prove its new journal before writes resume.
      if (recoveryFencesRef.current.has(sessionId)) {
        setLoadingKey("sessionHistory", false);
        return;
      }
      if (events) {
        // The output client has joined every bounded, selected legacy page.
        // This proves saved display history, never a live output cursor.
        epochHistorySessionRef.current = undefined;
        const cursor = sessionCursor(sessionId);
        cursor.historyUnpaired = true;
        cursor.awaitingSnapshot = true;
        dispatchChat({ kind: "replay", events });
        dispatchChat({ kind: "stream_epoch_changed" });
        setNotice(t("mobile.notice.sessionRecoveryHistoryOnly"));
        setLoadingKey("sessionHistory", false);
        return;
      }
      epochHistorySessionRef.current = sessionId;
      sessionCursor(sessionId).historyUnpaired = true;
      requestSessionHistory(sessionId);
    },
    awaitingJournal: () => {
      // A selected live producer has no prior output. No read/request remains
      // pending while the user composes its first input.
      setLoadingKey("sessionHistory", false);
    },
    failed: (sessionId) => {
      recoveryFencesRef.current.add(sessionId);
      setOutputHistory((previous) => ({
        sessionId,
        failed: true,
        historicalGap: previous?.sessionId === sessionId ? previous.historicalGap : undefined,
      }));
      sessionCursor(sessionId).awaitingSnapshot = true;
      dispatchChat({ kind: "stream_epoch_changed" });
      setNotice(t("mobile.notice.sessionRecoveryIncomplete"));
      setLoadingKey("sessionHistory", false);
    },
  }));
  useEffect(() => () => outputClient.cancel(false), [outputClient]);

  const loadEarlierHistory = useCallback(async () => {
    const window = historyWindowRef.current;
    if (!window || window.loading || !window.hasEarlier)
      throw new Error(t("mobile.historyRecovery.detailUnavailable"));
    const current = () =>
      historyWindowRef.current?.sessionId === window.sessionId &&
      historyWindowRef.current?.id === window.id;
    historyWindowRef.current = { ...window, loading: true, error: undefined };
    setHistoryWindow(historyWindowRef.current);
    try {
      await outputClient.loadEarlier();
    } catch (error) {
      const message = t(
        error instanceof HistoryReadBusyError
          ? "mobile.historyRecovery.detailBusy"
          : "mobile.historyRecovery.detailUnavailable",
      );
      if (current()) {
        historyWindowRef.current = { ...historyWindowRef.current!, loading: false, error: message };
        setHistoryWindow(historyWindowRef.current);
      }
      throw new Error(message, { cause: error });
    } finally {
      if (current() && historyWindowRef.current?.loading) {
        historyWindowRef.current = { ...historyWindowRef.current, loading: false };
        setHistoryWindow(historyWindowRef.current);
      }
    }
  }, [outputClient]);
  const loadHistoryDetail = useCallback(
    async (ref: string) => {
      try {
        return await outputClient.loadDetail(ref);
      } catch (error) {
        throw new Error(
          t(
            error instanceof HistoryReadBusyError
              ? "mobile.historyRecovery.detailBusy"
              : "mobile.historyRecovery.detailUnavailable",
          ),
          { cause: error },
        );
      }
    },
    [outputClient],
  );
  const reloadHistory = useCallback(() => {
    const sessionId = boundSessionRef.current;
    if (!socketOnlineRef.current || !sessionId || activeRoomIdRef.current) return;
    if (
      emptySessionReplacementRef.current &&
      emptySessionReplacementRef.current.status !== "complete"
    )
      return;
    if (
      unsentCreatedSessionRef.current?.sessionId === sessionId &&
      unsentCreatedSessionRef.current.generation === connectionGenerationRef.current
    )
      return;
    setLoadingKey("sessionHistory", true);
    if (!outputClient.begin(sessionId)) requestSessionHistory(sessionId, true);
  }, [outputClient, requestSessionHistory, setLoadingKey]);

  const onServerEvent = useCallback(
    (event: MobileServerEvent) => {
      const unsent = unsentCreatedSessionRef.current;
      const source = unsent ?? replacementSourceRef.current;
      if (
        source &&
        ((event.type === "session.stream" && event.sessionId === source.sessionId) ||
          (event.type === "session.list.ok" &&
            event.sessions.some((session) => session.id === source.sessionId)))
      ) {
        unsentCreatedSessionRef.current = null;
        replacementSourceRef.current = null;
        if (
          emptySessionReplacementRef.current?.status !== "complete" &&
          emptySessionReplacementRef.current?.fromSessionId === source.sessionId
        ) {
          if (pendingCreateRef.current?.replacesSessionId === source.sessionId) {
            clearTimeout(pendingCreateRef.current.timer);
            pendingCreateRef.current = null;
          }
          setEmptySessionReplacement(undefined);
          if (event.type === "session.list.ok")
            queueMicrotask(() => requestActiveResyncRef.current());
        }
      }
      if (
        event.type === "auth.ok" &&
        unsent &&
        boundSessionRef.current === unsent.sessionId &&
        !activeRoomIdRef.current
      ) {
        // This proves only an unused draft, not authority on the new socket.
        // Keep its local content visible while normal creation obtains a new grant.
        replacementSourceRef.current = unsent;
        setEmptySessionReplacement({ fromSessionId: unsent.sessionId, status: "pending" });
        setLoadingKey("sessionHistory", false);
        setOutputHistory(undefined);
      }
      if (event.type === "auth.ok") unsentCreatedSessionRef.current = null;
      if (historyRecovery.observe(event)) return;
      if (
        "sessionId" in event &&
        event.sessionId === applyingHistoryRef.current &&
        (event.type === "session.snapshot" ||
          event.type === "session.history.ok" ||
          event.type === "session.stream")
      )
        return;
      if (outputClient.observe(event)) return;
      switch (event.type) {
        case "auth.ok":
          socketOnlineRef.current = true;
          // Pull the world on connect.
          break;
        case "chat.accepted": {
          const waiter = event.clientMessageId
            ? messageAckWaitersRef.current.get(event.clientMessageId)
            : undefined;
          const creation = pendingCreateRef.current;
          const mayBind = event.clientRequestId
            ? Boolean(
                creation &&
                creation.clientRequestId === event.clientRequestId &&
                creation.conversationRevision === conversationRevisionRef.current &&
                creation.connectionGeneration === connectionGenerationRef.current,
              )
            : (!emptySessionReplacementRef.current ||
                emptySessionReplacementRef.current.status === "complete") &&
              (!event.clientMessageId ||
                Boolean(
                  waiter &&
                  waiter.conversationRevision === conversationRevisionRef.current &&
                  waiter.connectionGeneration === connectionGenerationRef.current,
                ));
          if (
            creation &&
            ((event.clientRequestId && creation.clientRequestId === event.clientRequestId) ||
              (!event.clientRequestId &&
                !event.clientMessageId &&
                event.sessionId &&
                mayBind &&
                creation.conversationRevision === conversationRevisionRef.current &&
                creation.connectionGeneration === connectionGenerationRef.current))
          ) {
            clearTimeout(creation.timer);
            pendingCreateRef.current = null;
            if (event.clientRequestId && event.sessionId && mayBind) {
              const target =
                event.projectId !== undefined
                  ? {
                      projectId: event.projectId,
                      ...(event.rootId ? { rootId: event.rootId } : {}),
                    }
                  : "cwd" in event
                    ? (event.cwd ?? null)
                    : creation.target;
              unsentCreatedSessionRef.current = {
                sessionId: event.sessionId,
                generation: creation.connectionGeneration,
                target,
              };
              if (creation.replacesSessionId)
                setEmptySessionReplacement({
                  fromSessionId: creation.replacesSessionId,
                  toSessionId: event.sessionId,
                  status: "complete",
                });
            }
            if (
              mayBind &&
              event.sessionId &&
              creation.permissionMode !== permissionModeRef.current
            ) {
              // The user can change the draft while creation is in flight. Apply
              // that choice to the new id, never to the previous selection.
              creationPermissionEchoRef.current = {
                sessionId: event.sessionId,
                mode: permissionModeRef.current,
              };
              sendRef.current?.({
                type: "permission.setMode",
                sessionId: event.sessionId,
                mode: permissionModeRef.current,
              });
            }
          }
          if (event.clientMessageId) {
            if (waiter) uncertainMessageSessionsRef.current.delete(event.clientMessageId);
            settleMessageAck(
              event.clientMessageId,
              waiter && waiter.connectionGeneration !== connectionGenerationRef.current
                ? new Error("Message acknowledgement arrived on a different connection")
                : undefined,
            );
          }
          if (mayBind && event.sessionId) {
            setActiveSessionId(event.sessionId);
            boundSessionRef.current = event.sessionId;
            clearSessionUnread(event.sessionId);
          }
          if (mayBind && "cwd" in event) setActiveSessionCwd(event.cwd ?? null);
          if (mayBind && event.sessionId && event.modelKey) {
            // A newly started external producer has no old subscription. Recover
            // its first journal entries and subscribe before live output continues.
            if (outputClient.begin(event.sessionId))
              setLoadingKey("sessionHistory", outputClient.pending(event.sessionId));
          }
          // A freshly minted session won't be on disk until its first turn, so
          // pull the list now so the new conversation shows up as a row.
          requestSessionList();
          break;
        }
        case "attachment.upload.ready": {
          const waiter = uploadWaitersRef.current.get(event.clientId);
          if (!waiter) break;
          uploadWaitersRef.current.delete(event.clientId);
          clearTimeout(waiter.timer);
          if (waiter.connectionGeneration !== connectionGenerationRef.current) {
            waiter.reject(new Error("Upload ticket arrived on a different connection"));
          } else {
            waiter.resolve(event);
          }
          break;
        }
        case "attachment.upload.failed": {
          const waiter = uploadWaitersRef.current.get(event.clientId);
          if (!waiter) break;
          uploadWaitersRef.current.delete(event.clientId);
          clearTimeout(waiter.timer);
          waiter.reject(new Error(event.message));
          break;
        }
        case "room.accepted": {
          const waiter = messageAckWaitersRef.current.get(event.clientMessageId);
          settleMessageAck(
            event.clientMessageId,
            waiter && waiter.connectionGeneration !== connectionGenerationRef.current
              ? new Error("Message acknowledgement arrived on a different connection")
              : undefined,
          );
          break;
        }
        case "chat.uncertain":
          if (messageAckWaitersRef.current.has(event.clientMessageId))
            uncertainMessageSessionsRef.current.set(event.clientMessageId, event.sessionId);
          settleMessageAck(event.clientMessageId, new Error(event.message));
          setNotice(event.message);
          break;
        case "session.list.ok": {
          const pending = sessionListRequestRef.current;
          if (event.requestId) {
            if (event.requestId !== pending?.requestId) break;
            sessionListPagedRef.current = true;
          } else if (sessionListPagedRef.current || (pending && event.nextCursor !== undefined)) {
            // Socket health probes have no request id and must not replace a
            // selected project's list or discard already loaded pages.
            break;
          }
          sessionListRequestRef.current = undefined;
          sessionListCursorRef.current = event.nextCursor ?? null;
          setSessionsHasMore(Boolean(event.nextCursor));
          setSessions((previous) =>
            pending?.append
              ? [
                  ...new Map(
                    [...previous, ...event.sessions].map((session) => [session.id, session]),
                  ).values(),
                ]
              : event.sessions,
          );
          // A page/project is only part of the catalog, so its missing ids do
          // not prove that another conversation or its unread marker was deleted.
          setUnreadSessionIds((prev) =>
            clearUnreadSession(
              event.nextCursor === undefined
                ? pruneUnreadSessions(
                    prev,
                    event.sessions.map((session) => session.id),
                  )
                : prev,
              event.activeSessionId,
            ),
          );
          setLoadingKey("sessions", false);
          if (
            event.activeSessionId &&
            (conversationRevisionRef.current === 0 ||
              event.activeSessionId === boundSessionRef.current)
          ) {
            // A refresh may reflect an earlier async create or another tab's
            // device selection. Only an explicit acknowledgement/select owns
            // navigation once this browser has chosen its conversation.
            setActiveSessionId(event.activeSessionId);
            if (conversationRevisionRef.current === 0) {
              // A displayed initial conversation needs the same per-viewer
              // selection as a tapped row before it may receive commands.
              conversationRevisionRef.current += 1;
              boundSessionRef.current = event.activeSessionId;
              setLoadingKey("sessionHistory", true);
              if (!outputClient.begin(event.activeSessionId)) {
                requestSessionHistory(event.activeSessionId, true);
              }
            }
            const active = event.sessions.find((s) => s.id === event.activeSessionId);
            if (active) setActiveSessionCwd(active.cwd || null);
            else if (!pending?.append && !sessionListScopeRef.current)
              setActiveSessionCwd(undefined);
          }
          break;
        }
        case "session.history.ok":
          if (outputClient.owns(event.sessionId)) break;
          // Only apply if it's the session we're currently viewing.
          if (event.sessionId === boundSessionRef.current && !activeRoomIdRef.current) {
            const cursor = sessionCursor(event.sessionId);
            // An earlier retry may finish after a fresh live turn starts.
            // Only an explicitly requested history can replace that projection.
            if (
              cursor.historyUnpaired !== undefined &&
              epochHistorySessionRef.current !== event.sessionId
            )
              break;
            dispatchChat({ kind: "replay", events: event.events });
            if (epochHistorySessionRef.current === event.sessionId) {
              epochHistorySessionRef.current = undefined;
              dispatchChat({ kind: "stream_epoch_changed" });
              // History carries no live cursor. A full snapshot could repeat
              // a reply already saved here, so keep the durable projection
              // until a subsequent top-level start proves a fresh boundary.
              cursor.historyUnpaired = true;
              cursor.awaitingSnapshot = true;
              setNotice(t("mobile.notice.sessionRecoveryHistoryOnly"));
            }
            setLoadingKey("sessionHistory", false);
          }
          break;
        case "session.snapshot": {
          if (outputClient.owns(event.sessionId)) {
            outputClient.advanceSnapshot(event.sessionId, event.outputCursor);
            break;
          }
          if (event.sessionId !== boundSessionRef.current || activeRoomIdRef.current) break;
          if (epochHistorySessionRef.current === event.sessionId) break;
          const session = sessionCursor(event.sessionId);
          if (event.outputCursor && outputClient.begin(event.sessionId)) {
            session.awaitingSnapshot = true;
            break;
          }
          const changed = alignSessionEpoch(session, event.epoch);
          if (session.historyUnpaired) break;
          if (changed) {
            dispatchChat({ kind: "stream_epoch_changed" });
            setApprovals([]);
            session.awaitingSnapshot = true;
          }
          // After a restart only a full new-domain prefix can release the
          // barrier. An older filtered reply (or an evicted prefix) cannot.
          if (
            session.awaitingSnapshot &&
            event.nextSeq > 1 &&
            !event.entries.some((entry) => entry.seq === 1)
          ) {
            if (changed) {
              sendRef.current?.({
                type: "session.sync",
                sessionId: event.sessionId,
                sinceSeq: 0,
                epoch: session.epoch,
              });
            } else {
              setNotice(t("mobile.notice.sessionRecoveryIncomplete"));
            }
            setLoadingKey("sessionHistory", false);
            break;
          }
          if (
            event.entries.some(
              (entry, index) =>
                entry.seq > session.appliedSeq &&
                entry.seq !==
                  (index > 0 ? event.entries[index - 1]!.seq + 1 : session.appliedSeq + 1),
            )
          ) {
            session.awaitingSnapshot = true;
            if (!outputClient.begin(event.sessionId))
              setNotice(t("mobile.notice.sessionRecoveryIncomplete"));
            setLoadingKey("sessionHistory", false);
            break;
          }
          const appliedSeq = session.appliedSeq;
          const { events, cursor } = selectSessionReplayEntries(
            event.entries as SessionReplayEntry[],
            appliedSeq,
          );
          session.appliedSeq = cursor;
          session.observedSeq = Math.max(session.observedSeq, cursor);
          session.awaitingSnapshot = false;
          appendSessionEvents(event.sessionId, events);
          setLoadingKey("sessionHistory", false);
          break;
        }
        case "session.stream": {
          if (!Number.isSafeInteger(event.seq) || event.seq < 1) break;
          const session = sessionCursor(event.sessionId);
          const hadCursor =
            session.epoch !== undefined || session.appliedSeq > 0 || session.observedSeq > 0;
          const changed = alignSessionEpoch(session, event.epoch);
          if (changed) session.awaitingSnapshot = hadCursor || event.seq > 1;
          if (event.seq <= session.observedSeq) break;
          session.observedSeq = event.seq;
          if (activeRoomIdRef.current) {
            setUnreadSessionIds((prev) => markSessionUnread(prev, event.sessionId));
            break;
          }
          if (boundSessionRef.current) {
            if (event.sessionId !== boundSessionRef.current) {
              setUnreadSessionIds((prev) =>
                markSessionUnread(prev, event.sessionId, boundSessionRef.current),
              );
              break;
            }
          } else if (pendingCreateRef.current) {
            // Another task's output while a new session awaits its acceptance:
            // binding it would move the new conversation (and its draft) there.
            setUnreadSessionIds((prev) => markSessionUnread(prev, event.sessionId));
            break;
          } else {
            boundSessionRef.current = event.sessionId;
            setActiveSessionId(event.sessionId);
            setActiveSessionCwd(sessionCwdById.get(event.sessionId));
          }
          clearSessionUnread(event.sessionId);
          const rawOutput = event.event as { outputCursor?: string } | null;
          if (changed && outputClient.owns(event.sessionId)) outputClient.begin(event.sessionId);
          if (
            !outputClient.owns(event.sessionId) &&
            rawOutput?.outputCursor &&
            outputClient.begin(event.sessionId)
          ) {
            session.awaitingSnapshot = true;
          }
          const held = outputClient.hold(event.sessionId, event.event);
          if (held === "pending") break;
          if (held === "covered") {
            if (event.seq === session.appliedSeq + 1) session.appliedSeq = event.seq;
            else if (event.seq > session.appliedSeq + 1) {
              session.awaitingSnapshot = true;
              if (!outputClient.catchUp(event.sessionId)) outputClient.begin(event.sessionId);
            }
            break;
          }
          if (!changed && !session.awaitingSnapshot && event.seq > session.appliedSeq + 1) {
            session.awaitingSnapshot = true;
            if (!outputClient.catchUp(event.sessionId) && !outputClient.begin(event.sessionId))
              setNotice(t("mobile.notice.sessionRecoveryIncomplete"));
            break;
          }
          if (changed) {
            dispatchChat({ kind: "stream_epoch_changed" });
            setApprovals([]);
            session.awaitingSnapshot = hadCursor || event.seq > 1;
            if (session.awaitingSnapshot && epochHistorySessionRef.current !== event.sessionId) {
              // Main captures/replies synchronously on this ordered socket.
              // Its full snapshot covers every live frame preceding the reply,
              // so waiting needs no unbounded client-side event journal.
              sendRef.current?.({
                type: "session.sync",
                sessionId: event.sessionId,
                sinceSeq: 0,
                epoch: session.epoch,
              });
            }
          }
          if (session.historyUnpaired && epochHistorySessionRef.current !== event.sessionId) {
            const raw = event.event as Record<string, unknown> | null;
            if (raw?.type === "stream_request_start" && !raw.agentId) {
              session.historyUnpaired = false;
              session.awaitingSnapshot = false;
              // Every older snapshot entry is either already in history or
              // unprovable. None may be replayed into this new live turn.
              session.appliedSeq = event.seq - 1;
              setNoticeState((notice) =>
                notice === t("mobile.notice.sessionRecoveryHistoryOnly") ? undefined : notice,
              );
            }
          }
          if (session.awaitingSnapshot || event.seq <= session.appliedSeq) break;
          session.appliedSeq = event.seq;
          appendSessionEvents(event.sessionId, [event.event]);
          outputClient.applied(event.sessionId, event.event);
          break;
        }
        case "permission.mode":
          if (
            pendingCreateRef.current ||
            (emptySessionReplacementRef.current &&
              emptySessionReplacementRef.current.status !== "complete")
          )
            break;
          if (
            creationPermissionEchoRef.current &&
            creationPermissionEchoRef.current.sessionId === event.sessionId
          ) {
            if (creationPermissionEchoRef.current.mode !== event.mode) break;
            creationPermissionEchoRef.current = null;
          }
          if (
            !event.sessionId ||
            !boundSessionRef.current ||
            event.sessionId === boundSessionRef.current
          ) {
            permissionModeRef.current = event.mode;
            setPermissionModeState(event.mode);
          }
          break;
        case "approval.resolved":
          clearApproval(event.approvalId);
          break;
        case "room.list.ok":
          setRooms(event.rooms);
          setLoadingKey("rooms", false);
          break;
        case "room.projects.ok":
          projectsRef.current = event.projects;
          setProjects(event.projects);
          if (activeProjectIdRef.current) {
            const selected = event.projects.find(
              (project) => project.id === activeProjectIdRef.current,
            );
            if (selected) setActiveProjectCwd(selected.path);
          }
          setLoadingKey("projects", false);
          break;
        case "room.message":
          if (event.roomId === activeRoomIdRef.current && event.msg) {
            // CC disk backlog is replayed with `replay` below. Folding live room
            // messages before that replay would display them briefly and then
            // wipe them while also advancing sinceSeq, so let room.history pull
            // them after the backlog has landed.
            if (ccHistorySessionRef.current && !ccBacklogLoadedRef.current) break;
            const seq = roomMessageSeq(event.msg);
            if (seq === undefined) {
              setNotice("Room message has an invalid sequence");
              break;
            }
            const catchup = roomCatchupRef.current;
            if (catchup?.roomId === event.roomId) {
              if (catchup.failed) break;
              if (catchup.live.size >= 10_000 && !catchup.live.has(seq)) {
                catchup.failed = true;
                setLoadingKey("roomHistory", false);
                setNotice("Room catchup live buffer exceeds its limit; reconnect to recover");
                break;
              }
              catchup.live.set(seq, event.msg);
              break;
            }
            if (seq > (lastRoomSeqRef.current.get(event.roomId) ?? 0) + 1) {
              requestRoomCatchup(event.roomId, lastRoomSeqRef.current.get(event.roomId) ?? 0);
              roomCatchupRef.current!.live.set(seq, event.msg);
              break;
            }
            const freshMessages = filterNewRoomMessages(
              event.roomId,
              [event.msg],
              appliedRoomSeqsRef.current,
            );
            if (freshMessages.length === 0) break;
            rememberRoomMessages(event.roomId, freshMessages);
            dispatchChat({ kind: "raw", raw: roomMsgToEvent(freshMessages[0]) });
          }
          break;
        case "room.history.ok": {
          if (event.roomId !== activeRoomIdRef.current) break;
          const catchup = roomCatchupRef.current;
          if (
            !catchup ||
            catchup.failed ||
            catchup.roomId !== event.roomId ||
            event.requestId !== catchup.requestId
          )
            break;
          try {
            if (!event.page) throw new Error("This Host does not support complete room history");
            const cursor = catchup.pager.accept({ ...event.page, messages: event.messages });
            if (cursor) {
              sendRef.current?.({
                type: "room.history",
                roomId: event.roomId,
                page: true,
                cursor,
                limit: 200,
                requestId: catchup.requestId,
              });
              break;
            }
            const fresh = filterNewRoomMessages(
              event.roomId,
              catchup.pager.messages,
              appliedRoomSeqsRef.current,
            );
            rememberRoomMessages(event.roomId, fresh, event.page.throughSeq);
            dispatchChat({ kind: "append", events: roomHistoryToEvents(fresh) });
            roomCatchupRef.current = undefined;
            const live = [...catchup.live.entries()].sort(([a], [b]) => a - b);
            for (const [seq, msg] of live) {
              const applied = lastRoomSeqRef.current.get(event.roomId) ?? 0;
              if (seq <= applied) continue;
              if (seq !== applied + 1) {
                requestRoomCatchup(event.roomId, applied);
                for (const [pendingSeq, pendingMsg] of live)
                  if (pendingSeq > applied)
                    roomCatchupRef.current!.live.set(pendingSeq, pendingMsg);
                break;
              }
              rememberRoomMessages(event.roomId, [msg]);
              dispatchChat({ kind: "raw", raw: roomMsgToEvent(msg) });
            }
            if (!roomCatchupRef.current) setLoadingKey("roomHistory", false);
          } catch (error) {
            // Keep the failed boundary and buffered live messages. Do not fold
            // a partial range or advance the durable catchup position.
            catchup.failed = true;
            setNotice(String(error));
            setLoadingKey("roomHistory", false);
          }
          break;
        }
        case "room.opened":
          // The room is internal CC-session transport; surface it as a 会话 to the
          // user (no room concept in the UI).
          if (event.status === "missing") {
            setNotice(t("mobile.notice.roomMissing"));
            setActiveRoomId(undefined);
            setLoadingKey("roomHistory", false);
          }
          break;
        case "room.closed":
          // Keep the internal room snapshot in sync (resolves activeRoom metadata).
          setRooms((prev) => prev.map((r) => (r.id === event.roomId ? { ...r, open: false } : r)));
          // The room's process is gone, so no turn is running any more. Its
          // stopped process cannot report its own turn end.
          if (event.roomId === activeRoomIdRef.current) {
            dispatchChat({ kind: "raw", raw: { type: "turn_complete", reason: "aborted_tools" } });
          }
          break;
        case "room.recovery":
          if (event.roomId === activeRoomIdRef.current) {
            ccBacklogLoadedRef.current = false;
            if (roomCatchupRef.current?.roomId === event.roomId)
              roomCatchupRef.current.failed = true;
            setLoadingKey("roomHistory", false);
            setNotice(event.message);
          }
          break;
        case "room.error":
          if (event.requestId && event.requestId !== roomCatchupRef.current?.requestId) break;
          if (
            event.roomId === activeRoomIdRef.current &&
            roomCatchupRef.current?.roomId === event.roomId
          ) {
            roomCatchupRef.current!.failed = true;
            setLoadingKey("roomHistory", false);
          }
          if (event.clientMessageId) {
            settleMessageAck(event.clientMessageId, new MessageRejectedError(event.message));
          }
          setNotice(event.message || t("mobile.notice.roomError"));
          break;
        case "error":
          if (event.clientRequestId && !failSessionCreation(event.clientRequestId)) break;
          if (event.approvalId) {
            submittingAsyncApprovalsRef.current.delete(event.approvalId);
            // The decision did not reach Core. The request may still be
            // pending there; an authoritative resync replays its card.
            if (submittedApprovalsRef.current.delete(event.approvalId)) {
              requestActiveResyncRef.current();
            }
          }
          if (event.clientMessageId) {
            // Older Hosts sent a generic error for this ambiguous timeout.
            // Preserve its intent ID just as for the additive chat.uncertain event.
            settleMessageAck(
              event.clientMessageId,
              event.message === "worker did not acknowledge the run"
                ? new Error(event.message)
                : new MessageRejectedError(event.message),
            );
          }
          setNotice(event.message);
          setLoading({
            sessions: false,
            sessionHistory: false,
            rooms: false,
            projects: false,
            roomHistory: false,
            ccSessions: false,
          });
          break;
        case "goal.extended":
          // Surface a real failure; success is silent (the run simply continues).
          if (!event.ok) setNotice(event.message || t("mobile.notice.goalExtendFailed"));
          break;
        case "model.current":
          // The worker confirmed the model actually applied. (No model display in
          // the phone UI yet; handled explicitly so it isn't a silent default.)
          break;
        case "runtime.models.ok":
          setRuntimeModels(event.models);
          setRuntimeModelsLoading(false);
          setRuntimeModelsError(event.message);
          break;
        case "approval.request": {
          // Legacy server-shaped approval (kept for back-compat).
          const { summary, risk } = summarizeApproval(undefined, event.risk);
          addApproval({
            requestId: event.approvalId,
            toolName: event.title,
            description: event.body,
            summary: event.body || summary,
            risk,
            pathScoped: false,
          });
          break;
        }
        case "ccRoom.probe.ok":
          // kind guard: ignore a probe reply for a CLI we've since switched away
          // from (else a slow claude probe could overwrite a codex result).
          if (event.kind === ccCliKindRef.current) {
            setCcProbe({ available: event.available, reason: event.reason });
          }
          break;
        case "ccRoom.listSessions.ok":
          // cwd + kind echo guard: ignore a reply for a project/CLI we've left.
          if (
            event.cwd === activeProjectCwdRef.current &&
            event.kind === ccCliKindRef.current &&
            Boolean(event.all) === ccShowAllRef.current
          ) {
            setCcSessions(event.sessions);
            setCcSessionsTotal(event.total ?? event.sessions.length);
            setLoadingKey("ccSessions", false);
          }
          break;
        case "ccRoom.opened": {
          const request = pendingCcOpensRef.current.get(event.sessionId);
          pendingCcOpensRef.current.delete(event.sessionId);
          // Only this browser's latest open request may change navigation.
          if (!request || request.revision !== conversationRevisionRef.current) break;
          if (event.status === "missing") {
            setNotice(t("mobile.notice.ccRoomOpenFailed"));
            break;
          }
          outputClient.cancel();
          // An opened cc room behaves like room.open — bind the room feed. But the
          // resident room only carries messages from open-time onward; the prior
          // external-CLI transcript lives on disk, so subscribeTranscript returns
          // its atomic backlog first, then keeps appending new lines through the
          // room feed. Without the snapshot the detail view looks empty.
          if (activeRoomIdRef.current && activeRoomIdRef.current !== event.roomId) {
            sendRef.current?.({
              type: "ccRoom.unsubscribeTranscript",
              roomId: activeRoomIdRef.current,
            });
          }
          activeRoomIdRef.current = event.roomId;
          setActiveRoomId(event.roomId);
          setRooms((previous) =>
            previous.map((room) =>
              room.id === event.roomId
                ? {
                    ...room,
                    open: event.status === "running",
                    observing: event.status === "observing",
                    ...(event.permissionMode ? { permissionMode: event.permissionMode } : {}),
                  }
                : room,
            ),
          );
          // Refresh metadata even when this room was created after the last
          // room.list snapshot, so the mobile view can display read-only state.
          sendRef.current?.({ type: "room.list" });
          ccHistorySessionRef.current = event.sessionId;
          ccHistoryCwdRef.current = request.cwd;
          ccBacklogLoadedRef.current = false;
          boundSessionRef.current = undefined;
          roomCatchupRef.current = undefined;
          setApprovals([]);
          setLoadingKey("sessionHistory", false);
          setLoadingKey("roomHistory", true);
          dispatchChat({ kind: "reset" });
          lastRoomSeqRef.current.set(event.roomId, 0);
          appliedRoomSeqsRef.current.delete(event.roomId);
          if (ccHistoryCwdRef.current) {
            sendRef.current?.({
              type: "ccRoom.subscribeTranscript",
              roomId: event.roomId,
              cwd: ccHistoryCwdRef.current,
              sessionId: event.sessionId,
              limit: 150,
              kind: ccHistoryKindRef.current,
            });
          } else {
            ccBacklogLoadedRef.current = true;
            requestRoomCatchup(event.roomId, 0);
          }
          break;
        }
        case "ccRoom.transcriptSubscribed":
          // Atomic snapshot + live subscription. roomCursor identifies exactly
          // where the snapshot ended in the shared room log; the incremental
          // history request closes response-delivery races and uses the same seq
          // dedupe as reconnect recovery.
          if (
            event.roomId === activeRoomIdRef.current &&
            event.sessionId === ccHistorySessionRef.current
          ) {
            if (!event.active) {
              setNotice("External transcript is not being followed");
              setLoadingKey("roomHistory", false);
              break;
            }
            dispatchChat({ kind: "replay", events: ccHistoryToEvents(event.messages) });
            setLoadingKey("roomHistory", false);
            ccBacklogLoadedRef.current = true;
            lastRoomSeqRef.current.set(event.roomId, event.roomCursor);
            appliedRoomSeqsRef.current.delete(event.roomId);
            setLoadingKey("roomHistory", true);
            requestRoomCatchup(event.roomId, event.roomCursor);
          }
          break;
        case "ccRoom.readHistory.ok":
          // Prior on-disk Claude Code transcript for the cc session we just opened.
          // Replay it as the conversation backlog. Guard on the session ref so a
          // late reply for a session we've since left can't clobber the feed.
          if (event.sessionId === ccHistorySessionRef.current) {
            dispatchChat({ kind: "replay", events: ccHistoryToEvents(event.messages) });
            setLoadingKey("roomHistory", false);
            ccBacklogLoadedRef.current = true;
            const roomId = activeRoomIdRef.current;
            if (roomId) {
              setLoadingKey("roomHistory", true);
              requestRoomCatchup(roomId, lastRoomSeqRef.current.get(roomId) ?? 0);
            }
          }
          break;
        case "ccRoom.approvalRequest": {
          // Only surface for the room this phone is viewing (rooms are shared, but
          // an approval card for some other room would be confusing here).
          if (event.roomId !== activeRoomIdRef.current) break;
          const { summary, risk } = summarizeApproval(
            event.req.input as Record<string, unknown> | undefined,
            undefined,
          );
          // AskUserQuestion is parsed in main → `askUser` carries the question +
          // option labels. Render a choice card; the chosen label is sent back as
          // the decision's `answer` (main bakes it into the CLI's `answers`
          // record). CC AskUser always allows a free-text "Other", so optionsOnly
          // stays false.
          const askUser = event.req.askUser;
          setApprovals((prev) =>
            prev.some((p) => p.requestId === event.req.requestId)
              ? prev
              : [
                  ...prev,
                  {
                    requestId: event.req.requestId,
                    roomId: event.roomId,
                    toolName: event.req.displayName ?? event.req.toolName,
                    description: askUser?.question ?? event.req.description ?? "",
                    summary: askUser ? askUser.question : summary,
                    risk,
                    options: askUser?.options,
                    optionsOnly: false,
                    ...(askUser?.questions && askUser.questions.length > 1
                      ? { questions: askUser.questions }
                      : {}),
                    pathScoped: PATH_SCOPED.has(event.req.toolName),
                  },
                ],
          );
          break;
        }
        case "ccRoom.approvalResolved":
          clearApproval(event.requestId);
          break;
        default:
          break;
      }
    },
    [
      addApproval,
      failSessionCreation,
      appendSessionEvents,
      clearApproval,
      clearSessionUnread,
      rememberRoomMessages,
      requestRoomCatchup,
      requestSessionList,
      requestSessionHistory,
      sessionCwdById,
      setLoadingKey,
      settleMessageAck,
      setNotice,
      sessionCursor,
    ],
  );

  const onRawLine = useCallback(
    (raw: unknown) => {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.method === "string") {
        optionsRef.current.onNotification?.(
          obj.method,
          obj.params && typeof obj.params === "object"
            ? (obj.params as Record<string, unknown>)
            : {},
        );
      }
      // Permission requests arrive as agent/approvalRequest worker lines.
      if (obj.method === "agent/approvalRequest" && obj.params) {
        const params = obj.params as Record<string, unknown>;
        const rq = params.request as
          | {
              toolName?: string;
              description?: string;
              args?: Record<string, unknown>;
              riskLevel?: string;
            }
          | undefined;
        if (rq) {
          const { summary, risk } = summarizeApproval(rq.args, rq.riskLevel, rq.toolName);
          const askOptions = extractAskUserOptions(rq.args);
          addApproval({
            requestId: String(params.requestId),
            sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
            toolName: rq.toolName ?? t("mobile.tool.fallbackName"),
            description: rq.description ?? "",
            summary: askOptions ? (rq.description ?? summary) : summary,
            risk,
            options: askOptions?.options,
            optionsOnly: askOptions?.optionsOnly,
            asynchronous: rq.toolName === "__ask_user__" && rq.args?.asynchronous === true,
            pathScoped: PATH_SCOPED.has(rq.toolName ?? ""),
          });
        }
        return;
      }
      const resolvedRequestId = rawApprovalResolvedRequestId(raw);
      if (resolvedRequestId) {
        clearApproval(resolvedRequestId);
        return;
      }
      // Everything else (agent/streamEvent) folds through the reducer, but it
      // MUST be isolated to ONE session — otherwise concurrent desktop sessions
      // interleave their text_deltas into one garbled feed ("不是同一个会话推到
      // 一起"). Rule:
      //   - in a room → ignore session streams entirely (room has its own feed)
      //   - bound to a session → only that session's events
      //   - nothing bound yet, event has a sessionId → AUTO-BIND to it (follow
      //     the first coherent conversation, never merge several)
      //   - event with no sessionId while unbound → drop (can't attribute it)
      if (obj.method === "agent/streamEvent" && obj.params) {
        if (activeRoomIdRef.current) return; // room view owns the feed
        if (applyingHistoryRef.current === boundSessionRef.current && applyingHistoryRef.current)
          return;
        const params = obj.params as Record<string, unknown>;
        if (params.sessionId === unsentCreatedSessionRef.current?.sessionId)
          unsentCreatedSessionRef.current = null;
        if (
          replacementSourceRef.current &&
          params.sessionId === replacementSourceRef.current.sessionId &&
          boundSessionRef.current === params.sessionId &&
          emptySessionReplacementRef.current?.status !== "complete"
        ) {
          replacementSourceRef.current = null;
          clearTimeout(pendingCreateRef.current?.timer);
          pendingCreateRef.current = null;
          setEmptySessionReplacement(undefined);
        }
        const sid = typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (boundSessionRef.current) {
          if (sid && sid !== boundSessionRef.current) return;
        } else if (pendingCreateRef.current) {
          return; // the pending creation's acceptance decides the binding
        } else if (sid) {
          // Auto-bind to the first session we see so the feed is coherent.
          boundSessionRef.current = sid;
          setActiveSessionId(sid);
          setActiveSessionCwd(sessionCwdById.get(sid));
        } else {
          return;
        }
        if (outputClient.rejectUnsequenced(boundSessionRef.current!)) return;
        dispatchChat({ kind: "raw", raw });
        clearApprovalsIfTerminal([params.event]);
      }
    },
    [addApproval, clearApproval, clearApprovalsIfTerminal, sessionCwdById],
  );

  const requestActiveResync = useCallback(() => {
    if (applyingHistoryRef.current) return;
    const roomId = activeRoomIdRef.current;
    if (roomId) {
      const ccSessionId = ccHistorySessionRef.current;
      const ccCwd = ccHistoryCwdRef.current;
      if (ccSessionId && ccCwd) {
        setLoadingKey("roomHistory", true);
        sendRef.current?.({
          type: "ccRoom.subscribeTranscript",
          roomId,
          cwd: ccCwd,
          sessionId: ccSessionId,
          limit: 150,
          kind: ccHistoryKindRef.current,
        });
        return;
      }
      if (ccHistorySessionRef.current && !ccBacklogLoadedRef.current) return;
      setLoadingKey("roomHistory", true);
      requestRoomCatchup(roomId, lastRoomSeqRef.current.get(roomId) ?? 0);
      return;
    }
    const sessionId = boundSessionRef.current;
    if (!sessionId) return;
    if (
      emptySessionReplacementRef.current &&
      emptySessionReplacementRef.current.status !== "complete"
    )
      return;
    if (
      unsentCreatedSessionRef.current?.sessionId === sessionId &&
      unsentCreatedSessionRef.current.generation === connectionGenerationRef.current
    )
      return;
    const cursor = sessionCursor(sessionId);
    const recovery = outputClient.resync(sessionId);
    if (recovery) {
      if (recovery === "started") {
        cursor.awaitingSnapshot = outputClient.pending(sessionId);
        setLoadingKey("sessionHistory", cursor.awaitingSnapshot);
      }
      return;
    }
    if (epochHistorySessionRef.current === sessionId || cursor.historyUnpaired) {
      epochHistorySessionRef.current = sessionId;
      setLoadingKey("sessionHistory", true);
      requestSessionHistory(sessionId);
      return;
    }
    sendRef.current?.({
      type: "session.sync",
      sessionId,
      sinceSeq: cursor.awaitingSnapshot ? 0 : cursor.appliedSeq,
      ...(cursor.epoch ? { epoch: cursor.epoch } : {}),
    });
  }, [setLoadingKey, sessionCursor, requestRoomCatchup, requestSessionHistory]);
  requestActiveResyncRef.current = requestActiveResync;

  const socket = useRemoteSocket({
    onServerEvent,
    onRawLine,
    onResyncNeeded: requestActiveResync,
  });
  sendRef.current = socket.send;
  connectionGenerationRef.current = socket.connectionGeneration;

  const retryEmptySessionReplacement = useCallback(() => {
    const source = replacementSourceRef.current;
    if (
      !source ||
      !socketOnlineRef.current ||
      activeRoomIdRef.current ||
      boundSessionRef.current !== source.sessionId ||
      pendingCreateRef.current ||
      emptySessionReplacementRef.current?.status === "complete"
    )
      return;
    const clientRequestId =
      globalThis.crypto?.randomUUID?.() ??
      `mobile-replace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const permissionMode = permissionModeRef.current;
    const generation = connectionGenerationRef.current;
    pendingCreateRef.current = {
      clientRequestId,
      permissionMode,
      target: source.target,
      replacesSessionId: source.sessionId,
      conversationRevision: conversationRevisionRef.current,
      connectionGeneration: generation,
      timer: setTimeout(() => {
        if (failSessionCreation(clientRequestId))
          setNotice("重新建立空白会话超时，输入内容已保留，请重试。");
      }, 30_000),
    };
    setEmptySessionReplacement({ fromSessionId: source.sessionId, status: "pending" });
    outputClient.cancel(false);
    setLoadingKey("sessionHistory", false);
    const target =
      source.target && typeof source.target === "object"
        ? source.target
        : { cwd: source.target ?? null };
    if (
      !sendRef.current?.(
        { type: "session.create", clientRequestId, permissionMode, ...target },
        generation,
      )
    ) {
      failSessionCreation(clientRequestId);
      setNotice("连接已变化，输入内容已保留，请重试建立会话。");
    }
  }, [failSessionCreation, outputClient, setEmptySessionReplacement, setLoadingKey, setNotice]);

  useEffect(() => {
    if (
      socket.status === "online" &&
      emptySessionReplacementRef.current?.status === "pending" &&
      !pendingCreateRef.current
    )
      retryEmptySessionReplacement();
  }, [socket.status, socket.connectionGeneration, retryEmptySessionReplacement]);

  useEffect(() => {
    historyRecovery.cancel();
  }, [
    historyRecovery,
    activeSessionId,
    activeRoomId,
    activeProjectId,
    socket.connectionGeneration,
  ]);

  useEffect(() => {
    socketOnlineRef.current = socket.status === "online";
    if (socketOnlineRef.current) return;
    creationPermissionEchoRef.current = null;
    failSessionCreation();
    sessionListRequestRef.current = undefined;
    setLoadingKey("sessions", false);
    outputClient.cancel(false);
    historyRecovery.cancel();
    roomCatchupRef.current = undefined;
    setLoadingKey("sessionHistory", false);
    setLoadingKey("roomHistory", false);
    submittingAsyncApprovalsRef.current.clear();
    submittedApprovalsRef.current.clear();
    const error = new Error("Remote connection was lost");
    for (const upload of uploadAbortsRef.current) upload.abort(error);
    uploadAbortsRef.current.clear();
    for (const waiter of uploadWaitersRef.current.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    uploadWaitersRef.current.clear();
    for (const waiter of messageAckWaitersRef.current.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    messageAckWaitersRef.current.clear();
  }, [socket.status, failSessionCreation]);

  // ── actions ────────────────────────────────────────────────────────────
  const getSessionOutputRecoveryPlan = useCallback(
    (sessionId: string) => historyRecovery.plan(sessionId),
    [historyRecovery],
  );
  const applySessionOutputRecovery = useCallback(
    async (
      sessionId: string,
      acceptance: OutputHistoryRecoveryAcceptance,
    ): Promise<OutputHistoryRecoveryResult> => {
      if (
        !socketOnlineRef.current ||
        activeRoomIdRef.current ||
        boundSessionRef.current !== sessionId ||
        applyingHistoryRef.current
      )
        throw new Error("Recovery selection changed");
      recoveryFencesRef.current.add(sessionId);
      applyingHistoryRef.current = sessionId;
      outputWriteGenerationRef.current++;
      setOutputHistory((previous) => ({
        sessionId,
        failed: true,
        historicalGap: previous?.sessionId === sessionId ? previous.historicalGap : undefined,
      }));
      const error = new MessageRetiredError(
        "History recovery retired the pending submission; its draft is retained",
      );
      for (const upload of uploadAbortsRef.current) upload.abort(error);
      for (const waiter of uploadWaitersRef.current.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      uploadWaitersRef.current.clear();
      for (const [id, waiter] of messageAckWaitersRef.current) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
        messageAckWaitersRef.current.delete(id);
      }
      approvalsRef.current = approvalsRef.current.filter((approval) => {
        if (approval.roomId || (approval.sessionId && approval.sessionId !== sessionId))
          return true;
        retiredApprovalsRef.current.add(approval.requestId);
        return false;
      });
      for (const id of submittedApprovalsRef.current) retiredApprovalsRef.current.add(id);
      for (const id of submittingAsyncApprovalsRef.current) retiredApprovalsRef.current.add(id);
      setApprovals(approvalsRef.current);
      submittedApprovalsRef.current.clear();
      submittingAsyncApprovalsRef.current.clear();
      // Preserve the Host's selected-session authority while retiring local old reads.
      outputClient.cancel(false);
      const revision = conversationRevisionRef.current;
      try {
        const result = await historyRecovery.apply(sessionId, acceptance);
        if (revision !== conversationRevisionRef.current || boundSessionRef.current !== sessionId)
          throw new Error("Recovery selection changed");
        if (result.status === "applied") {
          for (const [id, target] of uncertainMessageSessionsRef.current)
            if (target === sessionId) uncertainMessageSessionsRef.current.delete(id);
          sessionCursorsRef.current.delete(sessionId);
          epochHistorySessionRef.current = undefined;
          setOutputHistory({ sessionId, failed: true, historicalGap: true });
          dispatchChat({ kind: "stream_epoch_changed" });
          // An acknowledgement only starts a fresh proof; commit() alone unlocks writes.
          applyingHistoryRef.current = undefined;
          outputClient.begin(sessionId);
          setLoadingKey("sessionHistory", outputClient.pending(sessionId));
        }
        return result;
      } finally {
        if (applyingHistoryRef.current === sessionId) applyingHistoryRef.current = undefined;
      }
    },
    [historyRecovery, outputClient, setLoadingKey],
  );

  const sendChat = useCallback(
    async (input: {
      text: string;
      attachments: MobileComposerAttachment[];
      modelKey?: string;
      modelTraceSource?: string;
      clientMessageId?: string;
      onUncertain?: (clientMessageId: string) => void;
      onRetired?: () => void;
    }): Promise<boolean> => {
      const permissionMode = permissionModeRef.current;
      const text = input.text.trim();
      if (!text && input.attachments.length === 0) return false;
      if (socket.status !== "online") return false;
      if (
        pendingCreateRef.current ||
        (emptySessionReplacementRef.current &&
          emptySessionReplacementRef.current.status !== "complete")
      )
        return false;
      unsentCreatedSessionRef.current = null;
      replacementSourceRef.current = null;
      const connectionGeneration = socket.connectionGeneration;
      const conversationRevision = conversationRevisionRef.current;
      const outputWriteGeneration = outputWriteGenerationRef.current;
      const roomId = activeRoomIdRef.current;
      const sessionId =
        (input.clientMessageId
          ? uncertainMessageSessionsRef.current.get(input.clientMessageId)
          : undefined) ?? boundSessionRef.current;
      if (!roomId && sessionId && recoveryFencesRef.current.has(sessionId)) return false;
      const clientMessageId =
        input.clientMessageId ??
        globalThis.crypto?.randomUUID?.() ??
        `mobile-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let attachments;
      if (roomId && roomsRef.current.find((room) => room.id === roomId)?.observing) {
        setNotice(t("mobile.notice.ccRoomObserving"));
        return false;
      }
      const upload = new AbortController();
      uploadAbortsRef.current.add(upload);
      try {
        attachments = await prepareMobileAttachments(input.attachments, {
          beginUpload: (metadata) => beginMobileUpload(metadata, connectionGeneration),
          fetch: window.fetch.bind(window),
          signal: upload.signal,
        });
      } catch (error) {
        if (outputWriteGeneration !== outputWriteGenerationRef.current) {
          input.onRetired?.();
          setNotice(t("mobile.historyRecovery.noReplay"));
          return false;
        }
        setNotice(
          t("mobile.notice.attachmentSendFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return false;
      } finally {
        uploadAbortsRef.current.delete(upload);
      }
      if (outputWriteGeneration !== outputWriteGenerationRef.current) {
        input.onRetired?.();
        return false;
      }
      if (
        conversationRevision !== conversationRevisionRef.current ||
        (!roomId && sessionId && recoveryFencesRef.current.has(sessionId))
      )
        return false;
      const summaries = attachments.map(({ name, mime, size }) => ({ name, mime, size }));
      const acknowledged = waitForMessageAck(
        clientMessageId,
        connectionGeneration,
        conversationRevision,
      );
      let queued: boolean;
      if (roomId) {
        // NO optimistic echo for rooms: RoomManager persists the user line and
        // broadcasts it back to every client (incl. us) as a `room.message`,
        // which the reducer renders. Echoing locally too would double the
        // bubble. The broadcast round-trips over loopback/LAN ~instantly.
        queued = socket.send(
          {
            type: "room.send",
            roomId,
            text,
            clientMessageId,
            attachments,
          },
          connectionGeneration,
        );
      } else {
        queued = socket.send(
          {
            type: "chat.send",
            permissionMode,
            ...(input.modelKey ? { modelKey: input.modelKey } : {}),
            ...(input.modelTraceSource ? { modelTraceSource: input.modelTraceSource } : {}),
            text,
            sessionId,
            clientMessageId,
            attachments,
          },
          connectionGeneration,
        );
      }
      if (!queued) {
        settleMessageAck(clientMessageId, new Error("Remote connection changed before send"));
        await acknowledged.catch(() => undefined);
        return false;
      }
      try {
        await acknowledged;
      } catch (error) {
        // Only an explicit host rejection proves the message was not admitted.
        const retired = error instanceof MessageRetiredError;
        if (retired) input.onRetired?.();
        const uncertain = !retired && !(error instanceof MessageRejectedError);
        if (uncertain) input.onUncertain?.(clientMessageId);
        setNotice(
          retired
            ? t("mobile.historyRecovery.noReplay")
            : uncertain
              ? t("mobile.composer.sendUncertain")
              : t("mobile.notice.attachmentSendFailed", {
                  error: error instanceof Error ? error.message : String(error),
                }),
        );
        return false;
      }
      if (
        !roomId &&
        conversationRevision === conversationRevisionRef.current &&
        !activeRoomIdRef.current &&
        (sessionId === undefined || boundSessionRef.current === sessionId)
      ) {
        // Sessions don't echo the user turn back over the stream, so add the
        // local bubble only after the server has accepted this exact message.
        dispatchChat({ kind: "user", text, attachments: summaries, clientMessageId });
      }
      return true;
    },
    [beginMobileUpload, setNotice, settleMessageAck, socket, waitForMessageAck],
  );

  const stopRun = useCallback(() => {
    const roomId = activeRoomIdRef.current;
    if (roomId) {
      // A CLI room runs in its own resident process, not a native session.
      // Closing it stops the process; the next message resumes the same CLI
      // conversation.
      socket.send({ type: "room.close", roomId });
      return;
    }
    socket.send({ type: "run.stop", sessionId: boundSessionRef.current });
  }, [socket]);

  const refreshSessions = useCallback(
    (cwds?: string[]) => {
      requestSessionList(false, cwds);
    },
    [requestSessionList],
  );
  const loadMoreSessions = useCallback(() => requestSessionList(true), [requestSessionList]);

  const selectSession = useCallback(
    (id: string) => {
      if (!socketOnlineRef.current) {
        setNotice(t("mobile.connection.offlineTitle"));
        return;
      }
      conversationRevisionRef.current += 1;
      unsentCreatedSessionRef.current = null;
      replacementSourceRef.current = null;
      setEmptySessionReplacement(undefined);
      clearTimeout(pendingCreateRef.current?.timer);
      pendingCreateRef.current = null;
      creationPermissionEchoRef.current = null;
      if (activeRoomIdRef.current) {
        socket.send({
          type: "ccRoom.unsubscribeTranscript",
          roomId: activeRoomIdRef.current,
        });
      }
      setActiveSessionId(id);
      clearSessionUnread(id);
      setActiveSessionCwd(sessionCwdById.get(id) ?? null);
      boundSessionRef.current = id;
      const cursor = sessionCursor(id);
      epochHistorySessionRef.current =
        cursor.awaitingSnapshot || cursor.historyUnpaired !== undefined ? id : undefined;
      ccHistorySessionRef.current = undefined;
      ccHistoryCwdRef.current = undefined;
      ccBacklogLoadedRef.current = false;
      roomCatchupRef.current = undefined;
      setActiveRoomId(undefined);
      setApprovals([]);
      setLoadingKey("roomHistory", false);
      setLoadingKey("sessionHistory", true);
      dispatchChat({ kind: "reset" });
      activeRoomIdRef.current = undefined;
      if (!outputClient.begin(id)) {
        requestSessionHistory(id, true);
      }
    },
    [
      clearSessionUnread,
      socket,
      sessionCwdById,
      setLoadingKey,
      sessionCursor,
      requestSessionHistory,
      setNotice,
    ],
  );

  /** Select a project (like the desktop sidebar): set the one-true-source cwd and
   *  pull that project's chat sessions + external cc sessions. */
  const selectProject = useCallback(
    (projectIdOrCwd: string) => {
      outputClient.cancel();
      conversationRevisionRef.current += 1;
      setLoadingKey("sessionHistory", false);
      setLoadingKey("roomHistory", false);
      roomCatchupRef.current = undefined;
      const project = projectsRef.current.find(
        (candidate) => candidate.id === projectIdOrCwd || candidate.path === projectIdOrCwd,
      );
      const cwd = project?.path ?? projectIdOrCwd;
      setActiveProjectId(project?.id ?? null);
      setActiveProjectCwd(cwd);
      const roots = project?.roots?.length ? project.roots.map((root) => root.path) : [cwd];
      // Selecting an older row in the current project must retain loaded pages
      // and their provider metadata instead of immediately resetting to page 1.
      if (
        JSON.stringify([...new Set(roots)].sort()) !== JSON.stringify(sessionListScopeRef.current)
      )
        requestSessionList(false, roots);
      socket.send({ type: "room.projects" });
      // CC discovery (probe + listSessions) is driven by the auto-discover effect
      // keyed on the effective cwd — setting activeProjectCwd above triggers it.
      // Doing it here too would double-fetch.
    },
    [socket, requestSessionList, setLoadingKey],
  );

  const openCcSession = useCallback(
    (sessionId: string, cwd: string, mode: PermissionMode) => {
      if (!socketOnlineRef.current) {
        setNotice(t("mobile.connection.offlineTitle"));
        return;
      }
      outputClient.cancel();
      unsentCreatedSessionRef.current = null;
      replacementSourceRef.current = null;
      setEmptySessionReplacement(undefined);
      clearTimeout(pendingCreateRef.current?.timer);
      pendingCreateRef.current = null;
      creationPermissionEchoRef.current = null;
      conversationRevisionRef.current += 1;
      setLoadingKey("sessionHistory", false);
      setLoadingKey("roomHistory", false);
      roomCatchupRef.current = undefined;
      // Pin the CLI this session belongs to so its on-disk backlog is read with
      // the right reader even if the user switches the pane's CLI afterward.
      ccHistoryKindRef.current = ccCliKindRef.current;
      pendingCcOpensRef.current.set(sessionId, {
        cwd,
        revision: conversationRevisionRef.current,
      });
      socket.send({ type: "ccRoom.openSession", sessionId, cwd, mode, kind: ccCliKindRef.current });
    },
    [socket, setLoadingKey, setNotice],
  );

  const respondCcApproval = useCallback(
    (roomId: string, requestId: string, decision: CcApprovalDecision) => {
      const a = approvalsRef.current.find((p) => p.requestId === requestId);
      if (!a) return; // approve-once: already resolved
      // An unsent response never reaches the CLI, which is still waiting.
      // Keep the card so the user can retry once the connection recovers.
      if (!socket.send({ type: "ccRoom.respondApproval", roomId, requestId, decision })) {
        setNotice(t("mobile.notice.approvalSendFailed"));
        return;
      }
      approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== requestId);
      setApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [setNotice, socket],
  );

  const newSession = useCallback(
    (target?: MobileSessionCreateTarget, name?: string) => {
      const clientRequestId =
        globalThis.crypto?.randomUUID?.() ??
        `mobile-create-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const stableTarget =
        target === undefined && activeProjectIdRef.current
          ? { projectId: activeProjectIdRef.current }
          : target;
      // Creation needs the host's acceptance. Send it before switching the
      // view: offline, a dropped frame used to leave the view on the new target
      // while a later first send fell back to the previous (possibly another
      // project's) session.
      const permissionMode = permissionModeRef.current;
      const created = socket.send(
        stableTarget && typeof stableTarget === "object"
          ? {
              type: "session.create",
              clientRequestId,
              permissionMode,
              ...stableTarget,
              ...(name ? { name } : {}),
            }
          : stableTarget === undefined
            ? { type: "session.create", clientRequestId, permissionMode, ...(name ? { name } : {}) }
            : {
                type: "session.create",
                permissionMode,
                clientRequestId,
                cwd: stableTarget,
                ...(name ? { name } : {}),
              },
      );
      if (!created) {
        if (!failSessionCreation()) setSessionCreationFailures((value) => value + 1);
        setNotice(t("mobile.notice.createOffline"));
        return;
      }
      outputClient.cancel();
      conversationRevisionRef.current += 1;
      unsentCreatedSessionRef.current = null;
      replacementSourceRef.current = null;
      setEmptySessionReplacement(undefined);
      creationPermissionEchoRef.current = null;
      clearTimeout(pendingCreateRef.current?.timer);
      pendingCreateRef.current = {
        clientRequestId,
        permissionMode,
        target: stableTarget ?? null,
        conversationRevision: conversationRevisionRef.current,
        connectionGeneration: socket.connectionGeneration,
        timer: setTimeout(() => {
          if (failSessionCreation(clientRequestId)) setNotice("创建会话超时，请重试。");
        }, 30_000),
      };
      if (activeRoomIdRef.current) {
        socket.send({
          type: "ccRoom.unsubscribeTranscript",
          roomId: activeRoomIdRef.current,
        });
      }
      const selectedProject =
        stableTarget && typeof stableTarget === "object" && stableTarget.projectId
          ? projectsRef.current.find((project) => project.id === stableTarget.projectId)
          : undefined;
      const selectedRoot =
        selectedProject &&
        stableTarget &&
        typeof stableTarget === "object" &&
        "rootId" in stableTarget &&
        stableTarget.rootId
          ? selectedProject.roots?.find((root) => root.id === stableTarget.rootId)
          : selectedProject?.roots?.find((root) => root.id === selectedProject.primaryRootId);
      const nextCwd =
        stableTarget && typeof stableTarget === "object"
          ? stableTarget.projectId === null
            ? null
            : (selectedRoot?.path ?? selectedProject?.path)
          : stableTarget === undefined
            ? activeCwdRef.current
            : stableTarget;
      if (stableTarget && typeof stableTarget === "object") {
        setActiveProjectId(stableTarget.projectId);
        setActiveProjectCwd(
          stableTarget.projectId === null ? null : (selectedProject?.path ?? null),
        );
      }
      boundSessionRef.current = undefined;
      ccHistorySessionRef.current = undefined;
      ccHistoryCwdRef.current = undefined;
      ccBacklogLoadedRef.current = false;
      roomCatchupRef.current = undefined;
      // Enter a visible "fresh conversation" state immediately — clear the active
      // session + chat so the user sees the new-conversation surface right away
      // (the drawer closes after this; without it the screen looks unchanged and
      // tapping 新建 feels like a no-op). The real id arrives via chat.accepted.
      setActiveSessionId(undefined);
      // The real id arrives via chat.accepted, which binds boundSessionRef. A
      // chat.send sent before then carries sessionId:undefined, which the server
      // resolves to this device's just-minted session (WS-ordered: session.create
      // is processed before the following chat.send) — so no id race to guard.
      setActiveRoomId(undefined);
      setActiveSessionCwd(nextCwd === undefined ? undefined : (nextCwd ?? null));
      setApprovals([]);
      setLoadingKey("sessionHistory", false);
      setLoadingKey("roomHistory", false);
      dispatchChat({ kind: "reset" });
    },
    [socket, setLoadingKey, setNotice, failSessionCreation],
  );

  const respondApproval = useCallback(
    (
      requestId: string,
      decision: "approve" | "reject",
      opts?: {
        reason?: string;
        answer?: string;
        scope?: ApprovalScope;
        pathScope?: ApprovalPathScope;
      },
    ) => {
      const a = approvalsRef.current.find((p) => p.requestId === requestId);
      // Dedup at the source: if this approval is already gone from the ref it was
      // already responded to (rapid double-tap before setApprovals flushes / the
      // card unmounts). Sending again would violate the approve-once invariant.
      if (
        !a ||
        retiredApprovalsRef.current.has(requestId) ||
        recoveryFencesRef.current.has(a.sessionId ?? boundSessionRef.current ?? "")
      )
        return;
      if (a.asynchronous && submittingAsyncApprovalsRef.current.has(requestId)) return;
      const sent = socket.send({
        type: "approval.respond",
        approvalId: requestId,
        decision,
        sessionId: a?.sessionId,
        reason: opts?.reason,
        answer: opts?.answer,
        scope: opts?.scope,
        pathScope: opts?.pathScope,
      });
      if (!sent) return;
      if (a.asynchronous) {
        // Keep the card until the worker accepts this late answer. A rejected
        // delivery unlocks it for retry without losing the user's question.
        submittingAsyncApprovalsRef.current.add(requestId);
        return;
      }
      submittedApprovalsRef.current.add(requestId);
      // Update the ref synchronously too so a second tap in the same tick (before
      // the async setApprovals commits) sees it gone and no-ops above.
      approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== requestId);
      setApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [socket],
  );
  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      // A CLI room's mode is a spawn-time argument of its process; the native
      // session mode does not govern it. Never pretend to change it here.
      if (activeRoomIdRef.current) return;
      if (boundSessionRef.current && recoveryFencesRef.current.has(boundSessionRef.current)) return;
      permissionModeRef.current = mode;
      setPermissionModeState(mode);
      if (
        pendingCreateRef.current ||
        (emptySessionReplacementRef.current &&
          emptySessionReplacementRef.current.status !== "complete")
      )
        return;
      if (creationPermissionEchoRef.current) creationPermissionEchoRef.current.mode = mode;
      socket.send({ type: "permission.setMode", sessionId: boundSessionRef.current, mode });
    },
    [socket],
  );

  const extendGoal = useCallback(
    (sessionId: string) =>
      !recoveryFencesRef.current.has(sessionId) &&
      socket.send({ type: "goal.extend", sessionId, addTurns: 100 }),
    [socket],
  );

  const clearGoal = useCallback(
    (sessionId: string) =>
      !recoveryFencesRef.current.has(sessionId) && socket.send({ type: "goal.clear", sessionId }),
    [socket],
  );

  // Leave the bound CC session: drop the room binding and clear the feed. (There
  // is no user-facing room create/open/close — CC sessions are opened via
  // openCcSession; the room is internal transport.)
  const leaveRoom = useCallback(() => {
    outputClient.cancel();
    conversationRevisionRef.current += 1;
    if (activeRoomIdRef.current) {
      socket.send({
        type: "ccRoom.unsubscribeTranscript",
        roomId: activeRoomIdRef.current,
      });
    }
    setActiveRoomId(undefined);
    ccHistorySessionRef.current = undefined;
    ccHistoryCwdRef.current = undefined;
    ccBacklogLoadedRef.current = false;
    roomCatchupRef.current = undefined;
    // The room's cards belong to the conversation being left and must not
    // block other conversations. The host keeps the requests pending and
    // replays them when the room is opened again.
    approvalsRef.current = approvalsRef.current.filter((approval) => !approval.roomId);
    setApprovals((prev) => prev.filter((approval) => !approval.roomId));
    setLoadingKey("roomHistory", false);
    setLoadingKey("sessionHistory", false);
    dispatchChat({ kind: "reset" });
  }, [setLoadingKey, socket]);

  // activeRoom resolves the bound room's metadata (name/cwd) from the room.list
  // snapshot — used for the CC session's title/subtitle and the cc-history cwd.
  // There is no rendered room list; this lookup is internal.
  const activeRoom = useMemo(() => rooms.find((r) => r.id === activeRoomId), [rooms, activeRoomId]);
  const activeCwd = activeRoom?.cwd || activeSessionCwd;
  const refreshRuntimeModels = useCallback(() => {
    if (socket.status !== "online") return;
    setRuntimeModelsError(undefined);
    setRuntimeModelsLoading(socket.send({ type: "runtime.models" }));
  }, [socket.status, socket.send]);
  useEffect(() => {
    if (!runtimeModelsLoading) return;
    const timeout = setTimeout(() => {
      setRuntimeModelsLoading(false);
      setRuntimeModelsError("无法读取外部模型，请重试或更新桌面端。");
    }, 15_000);
    return () => clearTimeout(timeout);
  }, [runtimeModelsLoading]);
  useEffect(() => {
    if (socket.status !== "online") setRuntimeModelsLoading(false);
  }, [socket.status]);
  const activeContextCwd = projectContextCwd(activeCwd, projects);
  activeCwdRef.current = activeContextCwd;

  useEffect(() => {
    if (socket.status !== "online") return;
    setLoadingKey("rooms", true);
    socket.send({ type: "room.list" });
    // Pull the disk project list on connect; main re-broadcasts room.projects.ok
    // on every disk change, so a desktop add/remove/pin reaches us live too.
    socket.send({ type: "room.projects" });
  }, [socket.status, socket.send, activeCwd, setLoadingKey]);

  // Auto-discover CC (external claude CLI) sessions for the effective project cwd
  // — mirrors the desktop CCRoomView, which probes + lists on mount/cwd-change.
  // Without this, the CcSessionList shows (its cwd derives from activeCwd) but the
  // probe is never sent unless the user happens to tap a project via
  // selectProject, so it hangs on "正在检测…" forever. selectProject still does an
  // eager refresh on explicit project switches; this covers the implicit cwd.
  const ccDiscoverCwd = activeProjectCwd ?? activeContextCwd ?? null;
  const loadAllCcSessions = useCallback(() => {
    if (socket.status !== "online" || !ccDiscoverCwd) return;
    ccShowAllRef.current = true;
    setLoadingKey("ccSessions", true);
    if (
      !socket.send({ type: "ccRoom.listSessions", cwd: ccDiscoverCwd, kind: ccCliKind, all: true })
    )
      setLoadingKey("ccSessions", false);
  }, [socket, ccDiscoverCwd, ccCliKind, setLoadingKey]);
  useEffect(() => {
    if (socket.status !== "online" || !ccDiscoverCwd) return;
    // Adopt this cwd as the project context so the listSessions echo guard
    // (event.cwd === activeProjectCwdRef.current) matches the reply.
    setActiveProjectCwd(ccDiscoverCwd);
    const project = projectForCwd(ccDiscoverCwd, projectsRef.current);
    if (project?.id) setActiveProjectId(project.id);
    setCcProbe(null);
    ccShowAllRef.current = false;
    setCcSessions([]);
    setCcSessionsTotal(0);
    setLoadingKey("ccSessions", true);
    socket.send({ type: "ccRoom.probe", kind: ccCliKind });
    socket.send({ type: "ccRoom.listSessions", cwd: ccDiscoverCwd, kind: ccCliKind });
  }, [socket.status, socket.send, ccDiscoverCwd, ccCliKind, setLoadingKey]);

  return {
    status: socket.status,
    emptySessionReplacement,
    retryEmptySessionReplacement,
    accessRequired: socket.accessRequired,
    deviceName: socket.deviceName,
    chat,
    sessions,
    sessionsHasMore,
    loadMoreSessions,
    unreadSessionIds,
    activeSessionId,
    conversationRevision: conversationRevisionRef.current,
    sessionCreationFailures,
    activeCwd,
    projects,
    activeRoom,
    activeRoomId,
    approvals,
    permissionMode,
    runtimeModels,
    runtimeModelsLoading,
    runtimeModelsError,
    refreshRuntimeModels,
    loading,
    notice,
    historyHasEarlier:
      !activeRoomId && historyWindow?.sessionId === activeSessionId && historyWindow?.hasEarlier,
    historyLoadingEarlier:
      !activeRoomId && historyWindow?.sessionId === activeSessionId && historyWindow?.loading,
    historyEarlierError:
      !activeRoomId && historyWindow?.sessionId === activeSessionId
        ? historyWindow?.error
        : undefined,
    loadEarlierHistory,
    loadHistoryDetail,
    reloadHistory,
    sessionHistoryProgress:
      !activeRoomId && loading.sessionHistory && historyProgress?.sessionId === activeSessionId
        ? historyProgress?.progress
        : undefined,
    outputHistoryFailed:
      !activeRoomId && !!activeSessionId && recoveryFencesRef.current.has(activeSessionId),
    outputHistoricalGap:
      !activeRoomId && outputHistory?.sessionId === activeSessionId
        ? outputHistory?.historicalGap
        : undefined,
    outputRecoveryIdentity: `${socket.connectionGeneration}:${conversationRevisionRef.current}:${activeProjectId ?? ""}:${activeSessionId ?? ""}`,
    getSessionOutputRecoveryPlan,
    applySessionOutputRecovery,
    logout: socket.logout,
    sendChat,
    stopRun,
    selectSession,
    newSession,
    refreshSessions,
    respondApproval,
    setPermissionMode,
    extendGoal,
    clearGoal,
    leaveRoom,
    activeProjectCwd,
    activeProjectId,
    selectProject,
    ccSessions,
    ccSessionsTotal,
    loadAllCcSessions,
    ccProbe,
    ccCliKind,
    setCcCliKind,
    openCcSession,
    respondCcApproval,
  };
}
