import React from "react";
import {
  defaultWsUrl,
  ProtocolClient,
  ProtocolRequestError,
  type ApprovalRequestPayload,
  type ConnectionState,
  type SessionSummary,
  type StreamEventPayload,
  type HubStreamCursor,
} from "./protocol.js";
import {
  appendUserMessage,
  initialChatState,
  reduceStream,
  type ChatState,
} from "../src/lib/streamReducer.js";
import { chatFromSnapshot, isNewStreamEvent, sessionIdFromSearch, sessionTitle } from "./chat.js";
import { ApiError, browserId, uploadFile, type AuthSession, type UploadedFile } from "./auth.js";
import { reduceApprovals, type ApprovalState } from "./approvals.js";
import { readConfiguration, type HubConfiguration } from "./configuration.js";
import { SessionDrafts, type SubmittedDraft } from "./drafts.js";
import { readManagedSessions } from "./HubSessions.js";
import { HubApprovalCard } from "./HubApprovalCard.js";
import { captureApiScope } from "./api-context.js";
import type { WorkbenchController } from "./workbench-types.js";
function newSessionId(): string {
  return browserId();
}

const noop = () => {};
const checkNoop = async () => {};

export function useHubController({
  session,
  hub = false,
  onAuthLost = noop,
  onCheckAuth = checkNoop,
}: {
  session?: AuthSession;
  hub?: boolean;
  onAuthLost?: () => void;
  onCheckAuth?: () => Promise<void>;
}): WorkbenchController {
  const clientRef = React.useRef<ProtocolClient | null>(null);
  const [connection, setConnection] = React.useState<ConnectionState>("connecting");
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const sessionsRef = React.useRef<SessionSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string>(
    () => sessionIdFromSearch(window.location.search) ?? newSessionId(),
  );
  const [chat, setChat] = React.useState<ChatState>(initialChatState());
  const [approvalState, dispatchApprovals] = React.useReducer(reduceApprovals, {} as ApprovalState);
  const [pendingDecisions, setPendingDecisions] = React.useState<Record<string, boolean>>({});
  const [draft, setDraft] = React.useState("");
  const [files, setFiles] = React.useState<UploadedFile[]>([]);
  const draftStore = React.useRef(new SessionDrafts());
  const [draftsRevision, setDraftsRevision] = React.useState(0);
  const [uploadingFor, setUploadingFor] = React.useState<string | null>(null);
  const uploading = uploadingFor === activeId;
  const [workerNote, setWorkerNote] = React.useState<string | null>(null);
  const [replayNote, setReplayNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [now, setNow] = React.useState(Date.now());
  const [sessionsVersion, setSessionsVersion] = React.useState(0);
  const [configuration, setConfiguration] = React.useState<HubConfiguration | null>(null);
  const [configurationVersion, setConfigurationVersion] = React.useState(0);
  const configurationRequest = React.useRef(0);
  const activeIdRef = React.useRef<string>(activeId);
  const activeStreamCursor = React.useRef<HubStreamCursor | null>(null);
  const submissions = React.useRef(
    new Map<
      string,
      {
        clientMessageId: string;
        draft: SubmittedDraft;
        accepted: boolean;
      }
    >(),
  );
  const uncertainSubmissions = React.useRef(
    new Map<
      string,
      {
        clientMessageId: string;
        draft: SubmittedDraft;
      }
    >(),
  );
  const runPending = React.useRef(new Set<string>());
  const liveRuns = React.useRef(new Set<string>());
  const decisionPending = React.useRef(new Set<string>());
  const mounted = React.useRef(false);
  const uploadController = React.useRef<AbortController | null>(null);
  const loadingTranscript = React.useRef<{
    sessionId: string;
    events: StreamEventPayload[];
    running?: boolean;
  } | null>(null);

  const syncDraft = React.useCallback((sessionId: string) => {
    setDraftsRevision((value) => value + 1);
    if (activeIdRef.current !== sessionId) return;
    const current = draftStore.current.get(sessionId);
    setDraft(current.text);
    setFiles(current.files);
  }, []);

  React.useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("session", activeId);
    window.history.replaceState(window.history.state, "", url);
  }, [activeId]);

  const restoreSubmission = React.useCallback(
    (submission: { clientMessageId: string; draft: SubmittedDraft }, reason?: string) => {
      const restored = draftStore.current.restore(submission.draft);
      syncDraft(submission.draft.sessionId);
      if (activeIdRef.current === submission.draft.sessionId) {
        setChat((previous) => ({
          ...previous,
          run: "error",
          items: previous.items.filter(
            (item) => item.kind !== "user" || item.clientMessageId !== submission.clientMessageId,
          ),
        }));
        if (restored)
          setError(`${reason ? `${reason} ` : "消息未送达。"}内容和附件已恢复，可以重试。`);
      }
    },
    [syncDraft],
  );

  const reportError = React.useCallback(
    (cause: unknown) => {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 401) onAuthLost();
      else setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    },
    [onAuthLost],
  );

  const refreshConfiguration = React.useCallback(async () => {
    if (!hub || !mounted.current) return;
    const request = ++configurationRequest.current;
    try {
      const next = await readConfiguration();
      if (mounted.current && request === configurationRequest.current) setConfiguration(next);
    } catch (cause) {
      if (mounted.current && cause instanceof ApiError && cause.status === 401) onAuthLost();
      // Configuration has its own error state in Settings. Keep chat usable
      // while a server is upgrading or temporarily cannot read its settings.
    }
  }, [hub, onAuthLost]);

  const refreshSessions = React.useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const data = hub
        ? (await readManagedSessions()).sessions
        : (await client.listSessions()).data;
      if (clientRef.current === client && mounted.current) {
        const sorted = [...data].sort(
          (a, b) => (b.lastActiveAt ?? b.startedAt) - (a.lastActiveAt ?? a.startedAt),
        );
        sessionsRef.current = sorted;
        setSessions(sorted);
      }
    } catch (cause) {
      reportError(cause);
    }
  }, [reportError, hub]);

  const recoverUncertainSubmissions = React.useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    for (const [sessionId, submission] of uncertainSubmissions.current) {
      try {
        const detail = await client.sessionDetail(sessionId);
        if (
          !mounted.current ||
          client !== clientRef.current ||
          uncertainSubmissions.current.get(sessionId) !== submission
        )
          continue;
        const restored = chatFromSnapshot(detail.data).chat;
        const consumed = restored.items.some(
          (item) => item.kind === "user" && item.clientMessageId === submission.clientMessageId,
        );
        if (consumed) uncertainSubmissions.current.delete(sessionId);
        else if (!detail.data.running) {
          uncertainSubmissions.current.delete(sessionId);
          restoreSubmission(submission);
        }
      } catch (cause) {
        if (
          !mounted.current ||
          client !== clientRef.current ||
          uncertainSubmissions.current.get(sessionId) !== submission
        )
          continue;
        if (
          cause instanceof ProtocolRequestError &&
          cause.kind === "response" &&
          cause.code === -32001 &&
          cause.message === `Session not found: ${sessionId}`
        ) {
          uncertainSubmissions.current.delete(sessionId);
          restoreSubmission(submission);
        }
      }
    }
  }, [restoreSubmission]);

  const loadTranscript = React.useCallback(
    async (sessionId: string) => {
      const client = clientRef.current;
      if (!client) return;
      const load: { sessionId: string; events: StreamEventPayload[]; running?: boolean } = {
        sessionId,
        events: [],
      };
      loadingTranscript.current = load;
      try {
        const detail = await client.sessionDetail(sessionId);
        if (
          !mounted.current ||
          loadingTranscript.current !== load ||
          activeIdRef.current !== sessionId
        )
          return;
        const latestRunning = load.running ?? detail.data.running;
        if (latestRunning) liveRuns.current.add(sessionId);
        else if (latestRunning === false) liveRuns.current.delete(sessionId);
        const snapshot = chatFromSnapshot(detail.data, load.events);
        const restored = snapshot.chat;
        activeStreamCursor.current = snapshot.cursor ?? null;
        setReplayNote(
          snapshot.truncated
            ? "这次运行的实时记录较长，已恢复已保存的内容；结束后重新打开可查看完整记录。"
            : null,
        );
        if (latestRunning || runPending.current.has(sessionId)) restored.run = "running";
        else if (
          latestRunning === false &&
          (restored.run === "running" || restored.run === "waiting")
        )
          restored.run = "idle";
        setChat(restored);
      } catch (cause) {
        if (activeIdRef.current === sessionId) reportError(cause);
      } finally {
        if (loadingTranscript.current === load) loadingTranscript.current = null;
      }
    },
    [reportError],
  );

  React.useEffect(() => {
    mounted.current = true;
    const client = new ProtocolClient(defaultWsUrl());
    clientRef.current = client;
    const offAuth = client.onAuthLost(onAuthLost);
    const offState = client.onStateChange((state) => {
      setConnection(state);
      if (state === "open") {
        setWorkerNote(null);
        setError("");
        void refreshSessions().then(() => {
          const id = activeIdRef.current;
          if (
            mounted.current &&
            clientRef.current === client &&
            (sessionsRef.current.some((item) => item.sessionId === id) ||
              liveRuns.current.has(id) ||
              runPending.current.has(id) ||
              uncertainSubmissions.current.has(id))
          )
            void loadTranscript(id);
        });
        void refreshConfiguration();
        void recoverUncertainSubmissions();
      } else if (state === "closed") {
        if (hub) void onCheckAuth();
        setChat((prev) => ({ ...prev, run: "idle" }));
      }
    });
    const offNotify = client.onNotification((method, params) => {
      if (method === "serve/sessionsChanged") {
        void refreshSessions();
        setSessionsVersion((value) => value + 1);
        return;
      }
      if (method === "agent/runAccepted" && typeof params.sessionId === "string") {
        const submission = submissions.current.get(params.sessionId);
        if (submission) submission.accepted = true;
        return;
      }
      if (method === "serve/configurationChanged") {
        void refreshConfiguration();
        setConfigurationVersion((value) => value + 1);
        return;
      }
      if (method === "agent/streamEvent") {
        const payload = params as unknown as StreamEventPayload;
        const { sessionId, event } = payload;
        const submission = submissions.current.get(sessionId);
        if (
          submission &&
          ["stream_request_start", "text_delta", "thinking_delta", "tool_use_start"].includes(
            String(event.type),
          )
        )
          submission.accepted = true;
        if (sessionId === activeIdRef.current) {
          if (loadingTranscript.current?.sessionId === sessionId)
            loadingTranscript.current.events.push(payload);
          if (!isNewStreamEvent(payload, activeStreamCursor.current)) return;
          if (payload.hubEpoch && payload.hubSequence !== undefined)
            activeStreamCursor.current = { epoch: payload.hubEpoch, sequence: payload.hubSequence };
          setChat((prev) => reduceStream(prev, event));
        }
        if (event.type === "stream_request_start") setWorkerNote(null);
        if (event.type === "turn_complete") void refreshSessions();
        return;
      }
      if (method === "serve/sessionStatus") {
        setSessionsVersion((value) => value + 1);
        const { sessionId, running } = params;
        if (typeof sessionId !== "string" || typeof running !== "boolean") return;
        if (loadingTranscript.current?.sessionId === sessionId)
          loadingTranscript.current.running = running;
        if (running) liveRuns.current.add(sessionId);
        else liveRuns.current.delete(sessionId);
        if (!running && uncertainSubmissions.current.has(sessionId))
          void recoverUncertainSubmissions();
        if (sessionId === activeIdRef.current) {
          setChat((prev) =>
            running
              ? { ...prev, run: "running" }
              : prev.run === "running" || prev.run === "waiting"
                ? { ...prev, run: "idle" }
                : prev,
          );
        }
        void refreshSessions();
        return;
      }
      if (
        method === "agent/approvalRequest" ||
        method === "agent/approvalResolved" ||
        method === "serve/approvalSnapshot" ||
        method === "serve/approvalLease"
      ) {
        dispatchApprovals({ method, params });
        return;
      }
      if (method === "serve/workerExit") {
        liveRuns.current.clear();
        const clean = (params as { clean?: boolean }).clean;
        setWorkerNote(
          clean ? "服务进程已退出，发送消息会自动重启" : "服务进程异常退出，发送消息会自动重启",
        );
        setChat((prev) => ({ ...prev, run: "idle" }));
      }
    });
    client.connect();
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
      offState();
      offNotify();
      offAuth();
      client.close();
      clientRef.current = null;
    };
  }, [
    refreshSessions,
    loadTranscript,
    refreshConfiguration,
    recoverUncertainSubmissions,
    onAuthLost,
    onCheckAuth,
    hub,
  ]);

  const hasLease = Object.values(approvalState).some(
    (a) => a.lease?.holderId && (a.lease.expiresAt ?? 0) > now,
  );
  React.useEffect(() => {
    if (!hasLease) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasLease]);

  const loadSelectedSession = async (sessionId: string): Promise<void> => {
    activeIdRef.current = sessionId;
    activeStreamCursor.current = null;
    setActiveId(sessionId);
    syncDraft(sessionId);
    setChat(initialChatState());
    setError("");
    setReplayNote(null);
    if (
      !sessions.some((item) => item.sessionId === sessionId) &&
      !liveRuns.current.has(sessionId) &&
      draftStore.current.unsent().some((item) => item.sessionId === sessionId)
    )
      return;
    await loadTranscript(sessionId);
  };

  const createNewSession = (): void => {
    const id = newSessionId();
    activeIdRef.current = id;
    activeStreamCursor.current = null;
    loadingTranscript.current = null;
    setActiveId(id);
    syncDraft(id);
    setChat(initialChatState());
    setError("");
    setReplayNote(null);
  };

  const send = (): boolean => {
    const currentDraft = draftStore.current.get(activeIdRef.current);
    const text = currentDraft.text.trim();
    const client = clientRef.current;
    if ((!text && !currentDraft.files.length) || !client || connection !== "open" || uploading)
      return false;
    const sessionId = activeIdRef.current;
    if (
      runPending.current.has(sessionId) ||
      liveRuns.current.has(sessionId) ||
      chat.run === "running" ||
      chat.run === "waiting" ||
      Object.values(approvalState).some((a) => a.payload.sessionId === sessionId) ||
      uncertainSubmissions.current.has(sessionId)
    )
      return false;
    activeIdRef.current = sessionId;
    setActiveId(sessionId);
    runPending.current.add(sessionId);
    const submission = {
      clientMessageId: browserId(),
      draft: draftStore.current.take(sessionId),
      accepted: false,
    };
    submissions.current.set(sessionId, submission);
    const attachments = submission.draft.draft.files;
    syncDraft(sessionId);
    setError("");
    setChat((prev) => ({
      ...appendUserMessage(
        prev,
        text,
        attachments.map((file) => ({
          name: file.name,
          mime: file.mimeType,
          size: file.size,
        })),
        submission.clientMessageId,
      ),
      run: "running",
    }));
    void client
      .run({
        sessionId,
        task: text,
        clientMessageId: submission.clientMessageId,
        displayText: text,
        ...(attachments.length ? { uploadIds: attachments.map((file) => file.id) } : {}),
      })
      .catch((cause) => {
        if (!mounted.current) return;
        reportError(cause);
        if (
          cause instanceof ProtocolRequestError &&
          (cause.kind === "transport" || cause.kind === "timeout")
        ) {
          uncertainSubmissions.current.set(sessionId, submission);
          setError("连接中断，重新连接后会核对这条消息是否已经送达。");
        } else if (!submission.accepted)
          restoreSubmission(
            submission,
            cause instanceof Error
              ? cause.message === "upload not found or expired"
                ? "附件已失效，请移除后重新上传。"
                : cause.message
              : undefined,
          );
        if (activeIdRef.current === sessionId) setChat((prev) => ({ ...prev, run: "error" }));
      })
      .finally(() => {
        runPending.current.delete(sessionId);
        if (submissions.current.get(sessionId) === submission)
          submissions.current.delete(sessionId);
        if (
          mounted.current &&
          activeIdRef.current === sessionId &&
          !liveRuns.current.has(sessionId)
        ) {
          setChat((prev) => (prev.run === "running" ? { ...prev, run: "idle" } : prev));
        }
      });
    return true;
  };

  const decide = (payload: ApprovalRequestPayload, approved: boolean, answer?: string): void => {
    const client = clientRef.current;
    if (!client || connection !== "open" || decisionPending.current.has(payload.requestId)) return;
    decisionPending.current.add(payload.requestId);
    setPendingDecisions((prev) => ({ ...prev, [payload.requestId]: true }));
    setError("");
    void client
      .approve(
        { ...payload, sessionId: payload.sessionId ?? activeIdRef.current ?? "" },
        approved,
        answer,
      )
      .then(() =>
        dispatchApprovals({
          method: "agent/approvalResolved",
          params: { requestId: payload.requestId },
        }),
      )
      .catch(reportError)
      .finally(() => {
        decisionPending.current.delete(payload.requestId);
        setPendingDecisions((prev) => {
          const next = { ...prev };
          delete next[payload.requestId];
          return next;
        });
      });
  };

  const stop = (): void => {
    if (activeId) void clientRef.current?.cancel(activeId).catch(reportError);
  };

  const addFiles = async (selected: FileList | null): Promise<void> => {
    if (!selected?.length || uploadController.current) return;
    const controller = new AbortController();
    const scope = captureApiScope();
    uploadController.current = controller;
    setUploadingFor(activeIdRef.current);
    setError("");
    const sessionId = activeIdRef.current;
    try {
      for (const file of Array.from(selected)) {
        if (!mounted.current || controller.signal.aborted) break;
        const uploaded = await uploadFile(file, { signal: controller.signal, scope });
        if (mounted.current && !controller.signal.aborted) {
          draftStore.current.addFile(sessionId, uploaded);
          syncDraft(sessionId);
        }
      }
    } catch (cause) {
      reportError(cause);
    } finally {
      if (uploadController.current === controller) uploadController.current = null;
      if (mounted.current) setUploadingFor(null);
    }
  };

  const approvals = Object.values(approvalState).filter(
    (a) => !a.payload.sessionId || a.payload.sessionId === activeId,
  );
  const approvalCount = (sessionId: string) =>
    Object.values(approvalState).filter((a) => a.payload.sessionId === sessionId).length;

  const running = chat.run === "running" || chat.run === "waiting" || approvals.length > 0;
  const localDrafts = React.useMemo(
    () =>
      draftStore.current
        .unsent()
        .filter((item) => !sessions.some((session) => session.sessionId === item.sessionId)),
    [draftsRevision, sessions],
  );
  const workspaceCwd =
    configuration?.workspace.path ??
    sessions.find((item) => item.sessionId === activeId)?.cwd ??
    sessions[0]?.cwd ??
    null;
  const workspaceName = workspaceCwd?.split(/[\\/]/).filter(Boolean).pop() ?? "服务端工作区";
  const empty = chat.items.length === 0 && approvals.length === 0;
  const activeSession = sessions.find((item) => item.sessionId === activeId);
  const title = empty
    ? "新对话"
    : activeSession?.customTitle ||
      chat.title ||
      activeSession?.title ||
      activeSession?.preview?.trim() ||
      sessionTitle(chat, activeId ?? "新对话");
  return {
    host: hub ? "hub" : "legacy",
    workspaceApi: hub,
    connection,
    session,
    activeId,
    chat,
    sessions,
    workspaceCwd,
    workspaceName,
    title,
    workspaceKey: workspaceCwd ?? "hub",
    configuration,
    configurationVersion,
    sessionsVersion,
    draft,
    files,
    uploading,
    uploadBusy: uploadingFor !== null,
    hasUnsent: draftStore.current.unsent().length > 0,
    localDrafts,
    uncertain: uncertainSubmissions.current.has(activeId),
    running,
    approvals: Object.values(approvalState).map((a) => ({
      id: a.payload.requestId,
      sessionId: a.payload.sessionId,
    })),
    approvalCount,
    approvalContent: approvals.map((a) => (
      <HubApprovalCard
        key={a.payload.requestId}
        payload={a.payload}
        onDecide={decide}
        busy={
          !!pendingDecisions[a.payload.requestId] ||
          !!(a.lease?.holderId && (a.lease.expiresAt ?? 0) > now)
        }
        connected={connection === "open"}
      />
    )),
    workerNote,
    replayNote,
    error,
    clearError: () => setError(""),
    setDraft: (text) => {
      draftStore.current.setText(activeIdRef.current, text);
      syncDraft(activeIdRef.current);
    },
    removeFile: (id) => {
      draftStore.current.removeFile(activeIdRef.current, id);
      syncDraft(activeIdRef.current);
    },
    selectSession: loadSelectedSession,
    newSession: createNewSession,
    send,
    stop,
    addFiles,
    refreshSessions,
    refreshConfiguration,
    onAuthLost,
  };
}
