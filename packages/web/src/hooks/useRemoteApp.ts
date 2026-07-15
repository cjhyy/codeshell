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
  noteSessionSeq,
  pruneUnreadSessions,
  rawApprovalResolvedRequestId,
  removeResolvedApproval,
  roomMessageSeq,
  selectSessionReplayEntries,
  type SessionReplayEntry,
} from "./remoteAppSync.js";

/** Which external coding-CLI the CC pane drives. Mirrors desktop CCRoomView. */
export type CcCliKind = "claude-code" | "codex";

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
  /** True for path-scoped tools (Read/Edit/Write/…) → show file/dir scope. */
  pathScoped: boolean;
}

export interface RemoteApp {
  status: ConnStatus;
  deviceName: string;
  chat: ChatState;
  sessions: MobileSessionMeta[];
  unreadSessionIds: ReadonlySet<string>;
  activeSessionId?: string;
  activeCwd?: string | null;
  projects: MobileProjectMeta[];
  /** The bound room — for the user this is always an external CC (Claude Code)
   *  session. The room is internal transport; there is no user-facing room list. */
  activeRoom?: RoomPublic;
  approvals: PendingApproval[];
  permissionMode: PermissionMode;
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
  logout: () => void;
  // actions
  sendChat: (input: { text: string; attachments: MobileComposerAttachment[] }) => Promise<boolean>;
  stopRun: () => void;
  selectSession: (id: string) => void;
  newSession: (cwd?: string | null, name?: string) => void;
  refreshSessions: () => void;
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
  selectProject: (cwd: string) => void;
  ccSessions: CcDiscoveredSession[];
  ccProbe: { available: boolean; reason?: string } | null;
  /** Selected CC CLI (Claude Code / Codex). Switching re-probes + re-lists. */
  ccCliKind: CcCliKind;
  setCcCliKind: (kind: CcCliKind) => void;
  openCcSession: (sessionId: string, cwd: string, mode: PermissionMode) => void;
  respondCcApproval: (
    roomId: string,
    requestId: string,
    decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string },
  ) => void;
}

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
      attachments?: Array<{ name: string; mime?: string; size: number }>;
    }
  | { kind: "reset" }
  | { kind: "replay"; events: unknown[] }
  | { kind: "append"; events: unknown[] };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "raw":
      return reduceStream(state, action.raw);
    case "user":
      return appendUserMessage(state, action.text, action.attachments);
    case "reset":
      return initialChatState();
    case "replay":
      return action.events.reduce(reduceStream, initialChatState());
    case "append":
      return action.events.reduce(reduceStream, state);
  }
}

export function useRemoteApp(): RemoteApp {
  const [chat, dispatchChat] = useReducer(chatReducer, undefined, initialChatState);
  const [sessions, setSessions] = useState<MobileSessionMeta[]>([]);
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [activeSessionCwd, setActiveSessionCwd] = useState<string | null | undefined>();
  const [rooms, setRooms] = useState<RoomPublic[]>([]);
  const [projects, setProjects] = useState<MobileProjectMeta[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>();
  // activeRoomId via ref so socket callbacks see the latest value.
  const activeRoomIdRef = useRef<string | undefined>(undefined);
  activeRoomIdRef.current = activeRoomId;
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const approvalsRef = useRef(approvals);
  approvalsRef.current = approvals;
  // The SELECTED project (one-true-source for "what am I looking at"), distinct
  // from activeSessionCwd which is derived from the bound session. Drives session
  // list filtering AND ccRoom.listSessions.
  const [activeProjectCwd, setActiveProjectCwd] = useState<string | null>(null);
  const activeProjectCwdRef = useRef(activeProjectCwd);
  activeProjectCwdRef.current = activeProjectCwd;
  // Which external CLI the CC pane is showing (Claude Code or Codex). Switching
  // re-probes + re-lists for that CLI (mirrors desktop CCRoomView's cliKind).
  const [ccCliKind, setCcCliKind] = useState<CcCliKind>("claude-code");
  const ccCliKindRef = useRef<CcCliKind>(ccCliKind);
  ccCliKindRef.current = ccCliKind;
  // External-CLI sessions discovered for activeProjectCwd (under ccCliKind).
  const [ccSessions, setCcSessions] = useState<CcDiscoveredSession[]>([]);
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
  const messageAckWaitersRef = useRef(
    new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        connectionGeneration: number;
      }
    >(),
  );
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("default");
  /** Transient banner message (errors, room-missing, …). Auto-clears. */
  const [notice, setNoticeState] = useState<string | undefined>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setNotice = useCallback((msg: string) => {
    setNoticeState(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNoticeState(undefined), 5000);
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
    (clientMessageId: string, connectionGeneration: number): Promise<void> =>
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
  /** Highest mobile snapshot seq applied per desktop session. */
  const appliedSeqRef = useRef<Map<string, number>>(new Map());
  /** Highest live/snapshot seq observed per desktop session, including sessions not being viewed. */
  const lastSessionSeqRef = useRef<Map<string, number>>(new Map());
  /** Highest room message seq seen per active room. Used as room.history cursor. */
  const lastRoomSeqRef = useRef<Map<string, number>>(new Map());
  /** Recent room seqs already folded into the reducer, for idempotent history/live merge. */
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
   * session until ccRoom.opened confirms which room acquired it. */
  const pendingCcOpenCwdsRef = useRef<Map<string, string>>(new Map());
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

  const clearApproval = useCallback((requestId: string) => {
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
      approvalsRef.current = [];
      setApprovals([]);
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
    // Isolate to the bound session: an approval for some OTHER desktop session
    // must not pop on this phone's feed. If nothing is bound yet, auto-bind to
    // the approval's session (same first-coherent-conversation rule as streams)
    // so the request the user sees belongs to the conversation they're driving.
    if (activeRoomIdRef.current) return; // rooms don't surface chat approvals
    if (a.sessionId) {
      if (boundSessionRef.current && a.sessionId !== boundSessionRef.current) return;
      if (!boundSessionRef.current) {
        boundSessionRef.current = a.sessionId;
        setActiveSessionId(a.sessionId);
      }
    }
    setApprovals((prev) => (prev.some((p) => p.requestId === a.requestId) ? prev : [...prev, a]));
  }, []);

  const onServerEvent = useCallback(
    (event: MobileServerEvent) => {
      switch (event.type) {
        case "auth.ok":
          // Pull the world on connect.
          break;
        case "chat.accepted":
          if (event.clientMessageId) {
            const waiter = messageAckWaitersRef.current.get(event.clientMessageId);
            settleMessageAck(
              event.clientMessageId,
              waiter && waiter.connectionGeneration !== connectionGenerationRef.current
                ? new Error("Message acknowledgement arrived on a different connection")
                : undefined,
            );
          }
          if (event.sessionId) {
            setActiveSessionId(event.sessionId);
            boundSessionRef.current = event.sessionId;
            clearSessionUnread(event.sessionId);
          }
          if ("cwd" in event) setActiveSessionCwd(event.cwd ?? null);
          // A freshly minted session won't be on disk until its first turn, so
          // pull the list now so the new conversation shows up as a row.
          sendRef.current?.({ type: "session.list" });
          break;
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
        case "session.list.ok":
          setSessions(event.sessions);
          setUnreadSessionIds((prev) => {
            const pruned = pruneUnreadSessions(
              prev,
              event.sessions.map((s) => s.id),
            );
            return clearUnreadSession(pruned, event.activeSessionId);
          });
          setLoadingKey("sessions", false);
          if (event.activeSessionId) {
            setActiveSessionId(event.activeSessionId);
            const active = event.sessions.find((s) => s.id === event.activeSessionId);
            if (active) setActiveSessionCwd(active.cwd || null);
            else setActiveSessionCwd(undefined);
          }
          break;
        case "session.history.ok":
          // Only apply if it's the session we're currently viewing.
          if (event.sessionId === boundSessionRef.current) {
            dispatchChat({ kind: "replay", events: event.events });
            setLoadingKey("sessionHistory", false);
          }
          break;
        case "session.snapshot": {
          if (event.sessionId !== boundSessionRef.current || activeRoomIdRef.current) break;
          const appliedSeq = appliedSeqRef.current.get(event.sessionId) ?? 0;
          const { events, cursor } = selectSessionReplayEntries(
            event.entries as SessionReplayEntry[],
            appliedSeq,
          );
          if (cursor > appliedSeq) appliedSeqRef.current.set(event.sessionId, cursor);
          if (cursor > 0) noteSessionSeq(lastSessionSeqRef.current, event.sessionId, cursor);
          appendSessionEvents(event.sessionId, events);
          setLoadingKey("sessionHistory", false);
          break;
        }
        case "session.stream": {
          if (!noteSessionSeq(lastSessionSeqRef.current, event.sessionId, event.seq)) break;
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
          } else {
            boundSessionRef.current = event.sessionId;
            setActiveSessionId(event.sessionId);
            setActiveSessionCwd(sessionCwdById.get(event.sessionId));
          }
          clearSessionUnread(event.sessionId);
          const appliedSeq = appliedSeqRef.current.get(event.sessionId) ?? 0;
          if (event.seq <= appliedSeq) break;
          appliedSeqRef.current.set(event.sessionId, event.seq);
          appendSessionEvents(event.sessionId, [event.event]);
          break;
        }
        case "permission.mode":
          if (
            !event.sessionId ||
            !boundSessionRef.current ||
            event.sessionId === boundSessionRef.current
          ) {
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
          setProjects(event.projects);
          setLoadingKey("projects", false);
          break;
        case "room.message":
          if (event.roomId === activeRoomIdRef.current && event.msg) {
            // CC disk backlog is replayed with `replay` below. Folding live room
            // messages before that replay would display them briefly and then
            // wipe them while also advancing sinceSeq, so let room.history pull
            // them after the backlog has landed.
            if (ccHistorySessionRef.current && !ccBacklogLoadedRef.current) break;
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
        case "room.history.ok":
          if (event.roomId === activeRoomIdRef.current) {
            const messages = Array.isArray(event.messages) ? event.messages : [];
            const freshMessages = filterNewRoomMessages(
              event.roomId,
              messages,
              appliedRoomSeqsRef.current,
            );
            rememberRoomMessages(event.roomId, freshMessages, event.latestSeq);
            dispatchChat({ kind: "append", events: roomHistoryToEvents(freshMessages) });
            setLoadingKey("roomHistory", false);
          }
          break;
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
          break;
        case "room.error":
          if (event.clientMessageId) {
            settleMessageAck(event.clientMessageId, new Error(event.message));
          }
          setNotice(event.message || t("mobile.notice.roomError"));
          break;
        case "error":
          if (event.clientMessageId) {
            settleMessageAck(event.clientMessageId, new Error(event.message));
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
          if (event.cwd === activeProjectCwdRef.current && event.kind === ccCliKindRef.current) {
            setCcSessions(event.sessions);
            setLoadingKey("ccSessions", false);
          }
          break;
        case "ccRoom.opened":
          if (event.status === "missing") {
            pendingCcOpenCwdsRef.current.delete(event.sessionId);
            setNotice(t("mobile.notice.ccRoomOpenFailed"));
            break;
          }
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
          setActiveRoomId(event.roomId);
          ccHistorySessionRef.current = event.sessionId;
          ccHistoryCwdRef.current =
            pendingCcOpenCwdsRef.current.get(event.sessionId) ??
            activeProjectCwdRef.current ??
            undefined;
          pendingCcOpenCwdsRef.current.delete(event.sessionId);
          ccBacklogLoadedRef.current = false;
          boundSessionRef.current = undefined;
          setApprovals([]);
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
            sendRef.current?.({ type: "room.history", roomId: event.roomId, sinceSeq: 0 });
          }
          break;
        case "ccRoom.transcriptSubscribed":
          // Atomic snapshot + live subscription. roomCursor identifies exactly
          // where the snapshot ended in the shared room log; the incremental
          // history request closes response-delivery races and uses the same seq
          // dedupe as reconnect recovery.
          if (
            event.roomId === activeRoomIdRef.current &&
            event.sessionId === ccHistorySessionRef.current
          ) {
            dispatchChat({ kind: "replay", events: ccHistoryToEvents(event.messages) });
            setLoadingKey("roomHistory", false);
            ccBacklogLoadedRef.current = true;
            lastRoomSeqRef.current.set(event.roomId, event.roomCursor);
            appliedRoomSeqsRef.current.delete(event.roomId);
            setLoadingKey("roomHistory", true);
            sendRef.current?.({
              type: "room.history",
              roomId: event.roomId,
              sinceSeq: event.roomCursor,
            });
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
              sendRef.current?.({
                type: "room.history",
                roomId,
                sinceSeq: lastRoomSeqRef.current.get(roomId) ?? 0,
              });
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
      appendSessionEvents,
      clearApproval,
      clearSessionUnread,
      rememberRoomMessages,
      sessionCwdById,
      setLoadingKey,
      settleMessageAck,
      setNotice,
    ],
  );

  const onRawLine = useCallback(
    (raw: unknown) => {
      const obj = raw as Record<string, unknown>;
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
          const { summary, risk } = summarizeApproval(rq.args, rq.riskLevel);
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
        const params = obj.params as Record<string, unknown>;
        const sid = typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (boundSessionRef.current) {
          if (sid && sid !== boundSessionRef.current) return;
        } else if (sid) {
          // Auto-bind to the first session we see so the feed is coherent.
          boundSessionRef.current = sid;
          setActiveSessionId(sid);
          setActiveSessionCwd(sessionCwdById.get(sid));
        } else {
          return;
        }
        dispatchChat({ kind: "raw", raw });
        // A turn ending (or erroring) resolves any pending approval for this
        // session — clear stale cards so a request the user already handled (or
        // that the desktop answered) doesn't linger ("点了还存在").
        const ev = (params.event as { type?: string } | undefined)?.type;
        if (ev === "turn_complete" || ev === "error") {
          // We only ever hold bound-session approvals, so the turn ending clears
          // them all (the request can no longer be answered).
          approvalsRef.current = [];
          setApprovals([]);
        }
      }
    },
    [addApproval, clearApproval, sessionCwdById],
  );

  const requestActiveResync = useCallback(() => {
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
      sendRef.current?.({
        type: "room.history",
        roomId,
        sinceSeq: lastRoomSeqRef.current.get(roomId) ?? 0,
      });
      return;
    }
    const sessionId = boundSessionRef.current;
    if (!sessionId) return;
    sendRef.current?.({
      type: "session.sync",
      sessionId,
      sinceSeq: appliedSeqRef.current.get(sessionId) ?? 0,
    });
  }, [setLoadingKey]);

  const socket = useRemoteSocket({
    onServerEvent,
    onRawLine,
    onResyncNeeded: requestActiveResync,
  });
  sendRef.current = socket.send;
  connectionGenerationRef.current = socket.connectionGeneration;

  useEffect(() => {
    if (socket.status === "online") return;
    const error = new Error("Remote connection was lost");
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
  }, [socket.status]);

  // ── actions ────────────────────────────────────────────────────────────
  const sendChat = useCallback(
    async (input: { text: string; attachments: MobileComposerAttachment[] }): Promise<boolean> => {
      const text = input.text.trim();
      if (!text && input.attachments.length === 0) return false;
      if (socket.status !== "online") return false;
      const connectionGeneration = socket.connectionGeneration;
      const roomId = activeRoomIdRef.current;
      const sessionId = boundSessionRef.current;
      const clientMessageId =
        globalThis.crypto?.randomUUID?.() ??
        `mobile-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let attachments;
      try {
        attachments = await prepareMobileAttachments(input.attachments, {
          beginUpload: (metadata) => beginMobileUpload(metadata, connectionGeneration),
          fetch: window.fetch.bind(window),
        });
      } catch (error) {
        setNotice(
          t("mobile.notice.attachmentSendFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return false;
      }
      const summaries = attachments.map(({ name, mime, size }) => ({ name, mime, size }));
      const acknowledged = waitForMessageAck(clientMessageId, connectionGeneration);
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
        setNotice(
          t("mobile.notice.attachmentSendFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return false;
      }
      if (
        !roomId &&
        !activeRoomIdRef.current &&
        (sessionId === undefined || boundSessionRef.current === sessionId)
      ) {
        // Sessions don't echo the user turn back over the stream, so add the
        // local bubble only after the server has accepted this exact message.
        dispatchChat({ kind: "user", text, attachments: summaries });
      }
      return true;
    },
    [beginMobileUpload, setNotice, settleMessageAck, socket, waitForMessageAck],
  );

  const stopRun = useCallback(() => {
    socket.send({ type: "run.stop", sessionId: boundSessionRef.current });
  }, [socket]);

  const refreshSessions = useCallback(() => {
    setLoadingKey("sessions", true);
    socket.send({ type: "session.list" });
  }, [socket, setLoadingKey]);

  const selectSession = useCallback(
    (id: string) => {
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
      ccHistorySessionRef.current = undefined;
      ccHistoryCwdRef.current = undefined;
      ccBacklogLoadedRef.current = false;
      setActiveRoomId(undefined);
      setApprovals([]);
      setLoadingKey("sessionHistory", true);
      dispatchChat({ kind: "reset" });
      socket.send({ type: "session.select", sessionId: id });
      socket.send({ type: "session.history", sessionId: id });
    },
    [clearSessionUnread, socket, sessionCwdById, setLoadingKey],
  );

  /** Select a project (like the desktop sidebar): set the one-true-source cwd and
   *  pull that project's chat sessions + external cc sessions. */
  const selectProject = useCallback(
    (cwd: string) => {
      setActiveProjectCwd(cwd);
      setLoadingKey("sessions", true);
      socket.send({ type: "session.list" });
      socket.send({ type: "room.projects" });
      // CC discovery (probe + listSessions) is driven by the auto-discover effect
      // keyed on the effective cwd — setting activeProjectCwd above triggers it.
      // Doing it here too would double-fetch.
    },
    [socket, setLoadingKey],
  );

  const openCcSession = useCallback(
    (sessionId: string, cwd: string, mode: PermissionMode) => {
      // Pin the CLI this session belongs to so its on-disk backlog is read with
      // the right reader even if the user switches the pane's CLI afterward.
      ccHistoryKindRef.current = ccCliKindRef.current;
      pendingCcOpenCwdsRef.current.set(sessionId, cwd);
      socket.send({ type: "ccRoom.openSession", sessionId, cwd, mode, kind: ccCliKindRef.current });
    },
    [socket],
  );

  const respondCcApproval = useCallback(
    (
      roomId: string,
      requestId: string,
      decision:
        | { behavior: "allow"; updatedInput?: unknown }
        | { behavior: "deny"; message: string },
    ) => {
      const a = approvalsRef.current.find((p) => p.requestId === requestId);
      if (!a) return; // approve-once: already resolved
      socket.send({ type: "ccRoom.respondApproval", roomId, requestId, decision });
      approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== requestId);
      setApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [socket],
  );

  const newSession = useCallback(
    (cwd?: string | null, name?: string) => {
      if (activeRoomIdRef.current) {
        socket.send({
          type: "ccRoom.unsubscribeTranscript",
          roomId: activeRoomIdRef.current,
        });
      }
      const nextCwd = cwd === undefined ? activeCwdRef.current : cwd;
      boundSessionRef.current = undefined;
      ccHistorySessionRef.current = undefined;
      ccHistoryCwdRef.current = undefined;
      ccBacklogLoadedRef.current = false;
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
      dispatchChat({ kind: "reset" });
      socket.send(
        cwd === undefined
          ? { type: "session.create", ...(name ? { name } : {}) }
          : { type: "session.create", cwd, ...(name ? { name } : {}) },
      );
    },
    [socket, setLoadingKey],
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
      if (!a) return;
      socket.send({
        type: "approval.respond",
        approvalId: requestId,
        decision,
        sessionId: a?.sessionId,
        reason: opts?.reason,
        answer: opts?.answer,
        scope: opts?.scope,
        pathScope: opts?.pathScope,
      });
      // Update the ref synchronously too so a second tap in the same tick (before
      // the async setApprovals commits) sees it gone and no-ops above.
      approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== requestId);
      setApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [socket],
  );
  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      setPermissionModeState(mode);
      socket.send({ type: "permission.setMode", sessionId: boundSessionRef.current, mode });
    },
    [socket],
  );

  const extendGoal = useCallback(
    (sessionId: string) => socket.send({ type: "goal.extend", sessionId, addTurns: 100 }),
    [socket],
  );

  const clearGoal = useCallback(
    (sessionId: string) => socket.send({ type: "goal.clear", sessionId }),
    [socket],
  );

  // Leave the bound CC session: drop the room binding and clear the feed. (There
  // is no user-facing room create/open/close — CC sessions are opened via
  // openCcSession; the room is internal transport.)
  const leaveRoom = useCallback(() => {
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
    setLoadingKey("roomHistory", false);
    dispatchChat({ kind: "reset" });
  }, [setLoadingKey, socket]);

  // activeRoom resolves the bound room's metadata (name/cwd) from the room.list
  // snapshot — used for the CC session's title/subtitle and the cc-history cwd.
  // There is no rendered room list; this lookup is internal.
  const activeRoom = useMemo(() => rooms.find((r) => r.id === activeRoomId), [rooms, activeRoomId]);
  const activeCwd = activeRoom?.cwd || activeSessionCwd;
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
  useEffect(() => {
    if (socket.status !== "online" || !ccDiscoverCwd) return;
    // Adopt this cwd as the project context so the listSessions echo guard
    // (event.cwd === activeProjectCwdRef.current) matches the reply.
    setActiveProjectCwd(ccDiscoverCwd);
    setCcProbe(null);
    setCcSessions([]);
    setLoadingKey("ccSessions", true);
    socket.send({ type: "ccRoom.probe", kind: ccCliKind });
    socket.send({ type: "ccRoom.listSessions", cwd: ccDiscoverCwd, kind: ccCliKind });
  }, [socket.status, socket.send, ccDiscoverCwd, ccCliKind, setLoadingKey]);

  return {
    status: socket.status,
    deviceName: socket.deviceName,
    chat,
    sessions,
    unreadSessionIds,
    activeSessionId,
    activeCwd,
    projects,
    activeRoom,
    approvals,
    permissionMode,
    loading,
    notice,
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
    selectProject,
    ccSessions,
    ccProbe,
    ccCliKind,
    setCcCliKind,
    openCcSession,
    respondCcApproval,
  };
}
