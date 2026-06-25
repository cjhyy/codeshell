import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  MobileServerEvent,
  MobileSessionMeta,
  MobileProjectMeta,
  RoomPublic,
  PermissionMode,
  ApprovalScope,
  ApprovalPathScope,
  CcDiscoveredSession,
} from "@protocol";
import {
  reduceStream,
  initialChatState,
  appendUserMessage,
  type ChatState,
} from "@mobile/lib/streamReducer";
import { summarizeApproval, type Risk } from "@mobile/lib/riskClassify";
import {
  roomMsgToEvent,
  roomHistoryToEvents,
  ccHistoryToEvents,
  extractAskUserOptions,
} from "@mobile/lib/messageMappers";
import { projectForCwd } from "@mobile/lib/format";
import { useRemoteSocket, type ConnStatus } from "./useRemoteSocket";

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
  sendChat: (text: string) => void;
  stopRun: () => void;
  selectSession: (id: string) => void;
  newSession: (cwd?: string | null, name?: string) => void;
  refreshSessions: () => void;
  respondApproval: (
    requestId: string,
    decision: "approve" | "reject",
    opts?: { reason?: string; answer?: string; scope?: ApprovalScope; pathScope?: ApprovalPathScope },
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
  const [activeSessionCwd, setActiveSessionCwd] = useState<string | null | undefined>();
  const [rooms, setRooms] = useState<RoomPublic[]>([]);
  const [projects, setProjects] = useState<MobileProjectMeta[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const approvalsRef = useRef(approvals);
  approvalsRef.current = approvals;
  // The SELECTED project (one-true-source for "what am I looking at"), distinct
  // from activeSessionCwd which is derived from the bound session. Drives session
  // list filtering AND ccRoom.listSessions.
  const [activeProjectCwd, setActiveProjectCwd] = useState<string | null>(null);
  const activeProjectCwdRef = useRef(activeProjectCwd);
  activeProjectCwdRef.current = activeProjectCwd;
  // External claude-CLI sessions discovered for activeProjectCwd.
  const [ccSessions, setCcSessions] = useState<CcDiscoveredSession[]>([]);
  const [ccProbe, setCcProbe] = useState<{ available: boolean; reason?: string } | null>(null);
  /** socket.send via ref — onServerEvent is created BEFORE the socket (it's the
   *  socket's callback), so it can't close over `socket` directly. */
  const sendRef = useRef<((e: import("@protocol").MobileClientEvent) => void) | null>(null);
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
  /** The cc (external claude CLI) session id whose on-disk transcript is the
   *  backlog for the current room view. Set on ccRoom.opened, cleared whenever we
   *  switch to a plain session/room — gates whether room.history is allowed to
   *  replay (it must not clobber the cc backlog). */
  const ccHistorySessionRef = useRef<string | undefined>(undefined);
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

  const sessionCwdById = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const s of sessions) out.set(s.id, s.cwd || null);
    return out;
  }, [sessions]);

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
        if ("cwd" in event) setActiveSessionCwd(event.cwd ?? null);
        // A freshly minted session won't be on disk until its first turn, so
        // pull the list now so the new conversation shows up as a row.
        sendRef.current?.({ type: "session.list" });
        break;
      case "session.list.ok":
        setSessions(event.sessions);
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
      case "permission.mode":
        if (!event.sessionId || !boundSessionRef.current || event.sessionId === boundSessionRef.current) {
          setPermissionModeState(event.mode);
        }
        break;
      case "approval.resolved":
        approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== event.approvalId);
        setApprovals((prev) => prev.filter((p) => p.requestId !== event.approvalId));
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
          dispatchChat({ kind: "raw", raw: roomMsgToEvent(event.msg) });
        }
        break;
      case "room.history.ok":
        if (event.roomId === activeRoomIdRef.current) {
          // For a cc-opened session, ccRoom.readHistory owns the backlog (the
          // original Claude Code transcript). Both replays reset state, so the
          // room.history replay would clobber the cc backlog — skip it; live
          // turns still arrive via room.message and append. For a plain room
          // (no cc session bound) room.history is the only backlog → replay it.
          if (ccHistorySessionRef.current) break;
          dispatchChat({
            kind: "replay",
            events: roomHistoryToEvents(event.messages),
          });
          setLoadingKey("roomHistory", false);
        }
        break;
      case "room.opened":
        // The room is internal CC-session transport; surface it as a 会话 to the
        // user (no room concept in the UI).
        if (event.status === "missing") {
          setNotice("会话不存在或未就绪");
          setActiveRoomId(undefined);
          setLoadingKey("roomHistory", false);
        }
        break;
      case "room.closed":
        // Keep the internal room snapshot in sync (resolves activeRoom metadata).
        setRooms((prev) => prev.map((r) => (r.id === event.roomId ? { ...r, open: false } : r)));
        break;
      case "room.error":
        setNotice(event.message || "会话错误");
        break;
      case "error":
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
      case "ccRoom.probe.ok":
        setCcProbe({ available: event.available, reason: event.reason });
        break;
      case "ccRoom.listSessions.ok":
        // cwd echo guard: ignore a reply for a project we've since left.
        if (event.cwd === activeProjectCwdRef.current) {
          setCcSessions(event.sessions);
          setLoadingKey("ccSessions", false);
        }
        break;
      case "ccRoom.opened":
        if (event.status === "missing") {
          setNotice("cc 会话无法打开");
          break;
        }
        // An opened cc room behaves like room.open — bind the room feed. But the
        // resident room only carries messages from open-time onward; the prior
        // Claude Code transcript lives on disk, so pull it via ccRoom.readHistory
        // FIRST (rendered as the conversation's backlog), then bind the live feed
        // for new turns. Without this the detail view looks empty ("点进去没历史").
        setActiveRoomId(event.roomId);
        ccHistorySessionRef.current = event.sessionId;
        boundSessionRef.current = undefined;
        setApprovals([]);
        setLoadingKey("roomHistory", true);
        dispatchChat({ kind: "reset" });
        if (activeProjectCwdRef.current) {
          sendRef.current?.({
            type: "ccRoom.readHistory",
            cwd: activeProjectCwdRef.current,
            sessionId: event.sessionId,
            limit: 50,
          });
        }
        sendRef.current?.({ type: "room.history", roomId: event.roomId });
        break;
      case "ccRoom.readHistory.ok":
        // Prior on-disk Claude Code transcript for the cc session we just opened.
        // Replay it as the conversation backlog. Guard on the session ref so a
        // late reply for a session we've since left can't clobber the feed.
        if (event.sessionId === ccHistorySessionRef.current) {
          dispatchChat({ kind: "replay", events: ccHistoryToEvents(event.messages) });
          setLoadingKey("roomHistory", false);
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
        setApprovals((prev) =>
          prev.some((p) => p.requestId === event.req.requestId)
            ? prev
            : [
                ...prev,
                {
                  requestId: event.req.requestId,
                  roomId: event.roomId,
                  toolName: event.req.displayName ?? event.req.toolName,
                  description: event.req.description ?? "",
                  summary,
                  risk,
                  pathScoped: PATH_SCOPED.has(event.req.toolName),
                },
              ],
        );
        break;
      }
      case "ccRoom.approvalResolved":
        approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== event.requestId);
        setApprovals((prev) => prev.filter((p) => p.requestId !== event.requestId));
        break;
      default:
        break;
    }
  }, [setLoadingKey, setNotice]);

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
          setApprovals([]);
        }
      }
    },
    [addApproval, sessionCwdById],
  );

  const socket = useRemoteSocket({ onServerEvent, onRawLine });
  sendRef.current = socket.send;

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

  const refreshSessions = useCallback(() => {
    setLoadingKey("sessions", true);
    socket.send({ type: "session.list" });
  }, [socket, setLoadingKey]);

  const selectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
      setActiveSessionCwd(sessionCwdById.get(id) ?? null);
      boundSessionRef.current = id;
      ccHistorySessionRef.current = undefined;
      setActiveRoomId(undefined);
      setApprovals([]);
      setLoadingKey("sessionHistory", true);
      dispatchChat({ kind: "reset" });
      socket.send({ type: "session.select", sessionId: id });
      socket.send({ type: "session.history", sessionId: id });
    },
    [socket, sessionCwdById, setLoadingKey],
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
      socket.send({ type: "ccRoom.openSession", sessionId, cwd, mode });
    },
    [socket],
  );

  const respondCcApproval = useCallback(
    (
      roomId: string,
      requestId: string,
      decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string },
    ) => {
      const a = approvalsRef.current.find((p) => p.requestId === requestId);
      if (!a) return; // approve-once: already resolved
      socket.send({ type: "ccRoom.respondApproval", roomId, requestId, decision });
      approvalsRef.current = approvalsRef.current.filter((p) => p.requestId !== requestId);
      setApprovals((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [socket],
  );

  const newSession = useCallback((cwd?: string | null, name?: string) => {
    const nextCwd = cwd === undefined ? activeCwdRef.current : cwd;
    boundSessionRef.current = undefined;
    ccHistorySessionRef.current = undefined;
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
    setActiveSessionCwd(nextCwd === undefined ? undefined : nextCwd ?? null);
    setApprovals([]);
    setLoadingKey("sessionHistory", false);
    dispatchChat({ kind: "reset" });
    socket.send(
      cwd === undefined
        ? { type: "session.create", ...(name ? { name } : {}) }
        : { type: "session.create", cwd, ...(name ? { name } : {}) },
    );
  }, [socket, setLoadingKey]);

  const respondApproval = useCallback(
    (
      requestId: string,
      decision: "approve" | "reject",
      opts?: { reason?: string; answer?: string; scope?: ApprovalScope; pathScope?: ApprovalPathScope },
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
    setActiveRoomId(undefined);
    ccHistorySessionRef.current = undefined;
    setLoadingKey("roomHistory", false);
    dispatchChat({ kind: "reset" });
  }, [setLoadingKey]);

  // activeRoom resolves the bound room's metadata (name/cwd) from the room.list
  // snapshot — used for the CC session's title/subtitle and the cc-history cwd.
  // There is no rendered room list; this lookup is internal.
  const activeRoom = useMemo(
    () => rooms.find((r) => r.id === activeRoomId),
    [rooms, activeRoomId],
  );
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
    socket.send({ type: "ccRoom.probe" });
    socket.send({ type: "ccRoom.listSessions", cwd: ccDiscoverCwd });
  }, [socket.status, socket.send, ccDiscoverCwd, setLoadingKey]);

  return {
    status: socket.status,
    deviceName: socket.deviceName,
    chat,
    sessions,
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
    openCcSession,
    respondCcApproval,
  };
}
