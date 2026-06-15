import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type {
  MobileServerEvent,
  MobileSessionMeta,
  RoomPublic,
  PermissionMode,
  ApprovalScope,
  ApprovalPathScope,
} from "@protocol";
import {
  reduceStream,
  initialChatState,
  appendUserMessage,
  type ChatState,
} from "@mobile/lib/streamReducer";
import { summarizeApproval, type Risk } from "@mobile/lib/riskClassify";
import { roomMsgToEvent, extractAskUserOptions } from "@mobile/lib/messageMappers";
import { useRemoteSocket, type ConnStatus } from "./useRemoteSocket";

export interface PendingApproval {
  requestId: string;
  sessionId?: string;
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
  activeSessionId?: string;
  rooms: RoomPublic[];
  projects: { path: string; name: string }[];
  activeRoom?: RoomPublic;
  approvals: PendingApproval[];
  permissionMode: PermissionMode;
  notice?: string;
  logout: () => void;
  // actions
  sendChat: (text: string) => void;
  stopRun: () => void;
  selectSession: (id: string) => void;
  newSession: () => void;
  refreshSessions: () => void;
  respondApproval: (
    requestId: string,
    decision: "approve" | "reject",
    opts?: { reason?: string; answer?: string; scope?: ApprovalScope; pathScope?: ApprovalPathScope },
  ) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  extendGoal: (sessionId: string) => void;
  clearGoal: (sessionId: string) => void;
  // rooms
  refreshRooms: () => void;
  openRoom: (room: RoomPublic) => void;
  leaveRoom: () => void;
  createRoom: (cwd: string, name?: string) => void;
  closeRoom: (roomId: string) => void;
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

type ChatAction =
  | { kind: "raw"; raw: unknown }
  | { kind: "user"; text: string }
  | { kind: "reset" }
  | { kind: "replay"; events: unknown[] };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "raw":
      return reduceStream(state, action.raw);
    case "user":
      return appendUserMessage(state, action.text);
    case "reset":
      return initialChatState();
    case "replay":
      return action.events.reduce(reduceStream, initialChatState());
  }
}

export function useRemoteApp(): RemoteApp {
  const [chat, dispatchChat] = useReducer(chatReducer, undefined, initialChatState);
  const [sessions, setSessions] = useState<MobileSessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [rooms, setRooms] = useState<RoomPublic[]>([]);
  const [projects, setProjects] = useState<{ path: string; name: string }[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("default");
  /** Transient banner message (errors, room-missing, …). Auto-clears. */
  const [notice, setNoticeState] = useState<string | undefined>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setNotice = useCallback((msg: string) => {
    setNoticeState(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNoticeState(undefined), 5000);
  }, []);
  /** Which session id the chat view is bound to (for filtering live stream). */
  const boundSessionRef = useRef<string | undefined>(undefined);

  const onServerEvent = useCallback((event: MobileServerEvent) => {
    switch (event.type) {
      case "auth.ok":
        // Pull the world on connect.
        break;
      case "chat.accepted":
        if (event.sessionId) {
          setActiveSessionId(event.sessionId);
          boundSessionRef.current = event.sessionId;
        }
        break;
      case "session.list.ok":
        setSessions(event.sessions);
        if (event.activeSessionId) setActiveSessionId(event.activeSessionId);
        break;
      case "session.history.ok":
        // Only apply if it's the session we're currently viewing.
        if (event.sessionId === boundSessionRef.current) {
          dispatchChat({ kind: "replay", events: event.events });
        }
        break;
      case "permission.mode":
        setPermissionModeState(event.mode);
        break;
      case "room.list.ok":
        setRooms(event.rooms);
        break;
      case "room.projects.ok":
        setProjects(event.projects);
        break;
      case "room.message":
        if (event.roomId === activeRoomIdRef.current && event.msg) {
          dispatchChat({ kind: "raw", raw: roomMsgToEvent(event.msg) });
        }
        break;
      case "room.history.ok":
        if (event.roomId === activeRoomIdRef.current) {
          dispatchChat({
            kind: "replay",
            events: (event.messages ?? []).map(roomMsgToEvent),
          });
        }
        break;
      case "room.opened":
        if (event.status === "missing") {
          setNotice("房间不存在或未就绪");
          setActiveRoomId(undefined);
        }
        break;
      case "room.closed":
        // Refresh the list so the closed room's online pip clears.
        setRooms((prev) => prev.map((r) => (r.id === event.roomId ? { ...r, open: false } : r)));
        break;
      case "room.error":
        setNotice(event.message || "房间错误");
        break;
      case "error":
        setNotice(event.message);
        break;
      case "goal.extended":
        // Surface a real failure; success is silent (the run simply continues).
        if (!event.ok) setNotice(event.message || "延长目标失败");
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
      default:
        break;
    }
  }, []);

  // activeRoomId via ref so the message handler closure sees the latest value.
  const activeRoomIdRef = useRef<string | undefined>(undefined);
  activeRoomIdRef.current = activeRoomId;

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

  const onRawLine = useCallback(
    (raw: unknown) => {
      const obj = raw as Record<string, unknown>;
      // Permission requests arrive as agent/approvalRequest worker lines.
      if (obj.method === "agent/approvalRequest" && obj.params) {
        const params = obj.params as Record<string, unknown>;
        const rq = params.request as
          | { toolName?: string; description?: string; args?: Record<string, unknown>; riskLevel?: string }
          | undefined;
        if (rq) {
          const { summary, risk } = summarizeApproval(rq.args, rq.riskLevel);
          const askOptions = extractAskUserOptions(rq.args);
          addApproval({
            requestId: String(params.requestId),
            sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
            toolName: rq.toolName ?? "操作",
            description: rq.description ?? "",
            summary,
            risk,
            options: askOptions?.options,
            optionsOnly: askOptions?.optionsOnly,
            pathScoped: PATH_SCOPED.has(rq.toolName ?? ""),
          });
        }
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
          setApprovals([]);
        }
      }
    },
    [addApproval],
  );

  const socket = useRemoteSocket({ onServerEvent, onRawLine });

  // ── actions ────────────────────────────────────────────────────────────
  const sendChat = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      if (activeRoomIdRef.current) {
        // NO optimistic echo for rooms: RoomManager persists the user line and
        // broadcasts it back to every client (incl. us) as a `room.message`,
        // which the reducer renders. Echoing locally too would double the
        // bubble. The broadcast round-trips over loopback/LAN ~instantly.
        socket.send({ type: "room.send", roomId: activeRoomIdRef.current, text: t });
      } else {
        // Sessions don't echo the user turn back over the stream (it only
        // resurfaces on history replay), so the local echo is required here.
        dispatchChat({ kind: "user", text: t });
        socket.send({ type: "chat.send", text: t, sessionId: boundSessionRef.current });
      }
    },
    [socket],
  );

  const stopRun = useCallback(() => {
    socket.send({ type: "run.stop", sessionId: boundSessionRef.current });
  }, [socket]);

  const refreshSessions = useCallback(() => socket.send({ type: "session.list" }), [socket]);

  const selectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
      boundSessionRef.current = id;
      setActiveRoomId(undefined);
      setApprovals([]);
      dispatchChat({ kind: "reset" });
      socket.send({ type: "session.select", sessionId: id });
      socket.send({ type: "session.history", sessionId: id });
    },
    [socket],
  );

  const newSession = useCallback(() => {
    boundSessionRef.current = undefined;
    setActiveRoomId(undefined);
    setApprovals([]);
    dispatchChat({ kind: "reset" });
    socket.send({ type: "session.create" });
  }, [socket]);

  const respondApproval = useCallback(
    (
      requestId: string,
      decision: "approve" | "reject",
      opts?: { reason?: string; answer?: string; scope?: ApprovalScope; pathScope?: ApprovalPathScope },
    ) => {
      const a = approvalsRef.current.find((p) => p.requestId === requestId);
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
      setApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [socket],
  );
  const approvalsRef = useRef(approvals);
  approvalsRef.current = approvals;

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

  const refreshRooms = useCallback(() => {
    socket.send({ type: "room.list" });
    socket.send({ type: "room.projects" });
  }, [socket]);

  const openRoom = useCallback(
    (room: RoomPublic) => {
      setActiveRoomId(room.id);
      boundSessionRef.current = undefined;
      setApprovals([]);
      dispatchChat({ kind: "reset" });
      socket.send({ type: "room.open", roomId: room.id });
      socket.send({ type: "room.history", roomId: room.id });
    },
    [socket],
  );

  const leaveRoom = useCallback(() => {
    setActiveRoomId(undefined);
    dispatchChat({ kind: "reset" });
  }, []);

  const createRoom = useCallback(
    (cwd: string, name?: string) => socket.send({ type: "room.create", cwd, name }),
    [socket],
  );

  const closeRoom = useCallback(
    (roomId: string) => socket.send({ type: "room.close", roomId }),
    [socket],
  );

  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId),
    [rooms, activeRoomId],
  );

  return {
    status: socket.status,
    deviceName: socket.deviceName,
    chat,
    sessions,
    activeSessionId,
    rooms,
    projects,
    activeRoom,
    approvals,
    permissionMode,
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
    refreshRooms,
    openRoom,
    leaveRoom,
    createRoom,
    closeRoom,
  };
}
