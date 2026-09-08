import React from "react";
import {
  useRemoteApp,
  type RemoteApp,
  type MobileSessionCreateTarget,
} from "../src/hooks/useRemoteApp.js";
import { deviceStore } from "../src/lib/storage.js";
import { generateSecret } from "../src/lib/deviceCredential.js";
import { projectForCwd } from "../src/lib/format.js";
import {
  MOBILE_MAX_ATTACHMENTS,
  MOBILE_MAX_ATTACHMENT_TOTAL_BYTES,
} from "../src/lib/mobileAttachments.js";
import { ApiError, browserId, ensureDesktopHttpSession, post, type AuthSession } from "./auth.js";
import { setApiWorkspace } from "./api-context.js";
import { readConfiguration, type HubConfiguration } from "./configuration.js";
import { SessionDrafts } from "./drafts.js";
import { sessionTitle } from "./chat.js";
import { Workbench } from "./Workbench.js";
import { DesktopApproval, DesktopChatControls, DesktopSidebar } from "./DesktopControls.js";
import type { WorkbenchController } from "./workbench-types.js";

/** The Desktop adapter drives the already resident Desktop worker through its
 * paired-device protocol. It never starts a Hub ProtocolClient or another WS. */
export function DesktopApp() {
  const notificationRef = React.useRef<(method: string, params: Record<string, unknown>) => void>(
    () => {},
  );
  const app = useRemoteApp({
    onNotification: (method, params) => notificationRef.current(method, params),
  });
  const [session, setSession] = React.useState<AuthSession>();
  const [authError, setAuthError] = React.useState("");
  const [authRevision, setAuthRevision] = React.useState(0);
  const retryAuth = React.useCallback(() => {
    setAuthError("");
    setAuthRevision((value) => value + 1);
  }, []);
  React.useEffect(() => {
    if (app.status !== "online") return;
    let current = true;
    setAuthError("");
    const deviceId = deviceStore.getId();
    const secretHash = deviceStore.getOrCreateSecret(generateSecret);
    void ensureDesktopHttpSession({ deviceId, secretHash })
      .then((next) => {
        if (current) setSession(next);
      })
      .catch((error) => {
        if (current) {
          setAuthError(error instanceof Error ? error.message : "无法完成桌面连接。");
          if (error instanceof ApiError && error.status === 401) {
            setSession(undefined);
            app.logout();
          }
        }
      });
    return () => {
      current = false;
    };
  }, [app.status, authRevision]);
  React.useEffect(() => {
    if (app.status === "unpaired") setSession(undefined);
  }, [app.status]);
  const controller = useDesktopController(app, session, retryAuth);
  notificationRef.current = controller.onHostNotification;
  if (!session) {
    const unpaired = app.status === "unpaired";
    return (
      <main className="desktop-connection">
        <div className="desktop-connection-card">
          <h1>
            {unpaired ? "连接 CodeShell 桌面" : authError ? "桌面连接需要重试" : "正在连接桌面…"}
          </h1>
          <p>
            {authError ||
              (unpaired
                ? "请在桌面端开启 Web 访问，扫描新的配对二维码打开此页。"
                : "正在恢复已配对设备与桌面工作区的连接。")}
          </p>
          {authError ? (
            <div className="library-actions">
              <button className="library-button primary" onClick={retryAuth}>
                重试
              </button>
              <button className="library-button" onClick={app.logout}>
                重新配对
              </button>
            </div>
          ) : null}
        </div>
      </main>
    );
  }
  return <Workbench controller={controller} />;
}

function selectedTargetCwd(
  app: RemoteApp,
  target: MobileSessionCreateTarget | undefined,
): string | null | undefined {
  if (target === undefined) return app.activeProjectCwd ?? app.activeCwd;
  if (target === null || typeof target === "string") return target;
  if (target.projectId === null) return null;
  const project = app.projects.find((item) => item.id === target.projectId);
  return (
    ("rootId" in target && target.rootId
      ? project?.roots?.find((root) => root.id === target.rootId)?.path
      : undefined) ??
    project?.roots?.find((root) => root.id === project.primaryRootId)?.path ??
    project?.path
  );
}

function targetForCwd(app: RemoteApp, cwd: string | null): MobileSessionCreateTarget {
  if (cwd === null) return { projectId: null };
  const project = projectForCwd(cwd, app.projects);
  const root = project?.roots?.find((item) => item.path === cwd);
  return project?.id ? { projectId: project.id, ...(root ? { rootId: root.id } : {}) } : cwd;
}

export function useDesktopController(
  app: RemoteApp,
  session: AuthSession | undefined,
  onAuthLost: () => void,
): WorkbenchController & {
  onHostNotification: (method: string, params: Record<string, unknown>) => void;
} {
  const [workspaceOverride, setWorkspaceOverride] = React.useState<string | null>();
  const workspaceCwd =
    workspaceOverride === undefined
      ? (app.activeCwd ?? app.activeProjectCwd ?? null)
      : workspaceOverride;
  const workspaceKey = workspaceCwd ?? "desktop-unbound";
  // Layout effects run before any keyed management view issues passive fetches.
  React.useLayoutEffect(() => {
    setApiWorkspace(workspaceCwd ?? undefined);
  }, [workspaceCwd]);
  React.useEffect(() => () => setApiWorkspace(undefined), []);
  const [configuration, setConfiguration] = React.useState<HubConfiguration | null>(null);
  const [configurationVersion, setConfigurationVersion] = React.useState(0);
  const [sessionsVersion, setSessionsVersion] = React.useState(0);
  const configurationRequest = React.useRef(0);
  const workspaceRef = React.useRef(workspaceCwd);
  workspaceRef.current = workspaceCwd;
  const appRef = React.useRef(app);
  appRef.current = app;
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refreshConfiguration = React.useCallback(async () => {
    if (!session) return;
    const request = ++configurationRequest.current;
    const cwd = workspaceRef.current;
    try {
      const next = await readConfiguration();
      if (
        mounted.current &&
        request === configurationRequest.current &&
        workspaceRef.current === cwd
      ) {
        setConfiguration(next);
        setConfigurationVersion((value) => value + 1);
      }
    } catch (error) {
      if (mounted.current && error instanceof ApiError && error.status === 401) onAuthLost();
    }
  }, [session, onAuthLost]);
  React.useEffect(() => {
    setConfiguration(null);
    void refreshConfiguration();
  }, [workspaceCwd, refreshConfiguration]);
  React.useEffect(() => {
    if (app.status === "online") {
      appRef.current.refreshSessions();
      void refreshConfiguration();
    }
  }, [app.status, refreshConfiguration]);
  React.useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") {
        void refreshConfiguration();
        appRef.current.refreshSessions();
        setSessionsVersion((value) => value + 1);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshConfiguration]);

  const drafts = React.useRef(new SessionDrafts());
  const localFiles = React.useRef(new Map<string, File>());
  const draftWorkspaces = React.useRef(new Map<string, string | null>());
  const [draftRevision, setDraftRevision] = React.useState(0);
  const [newDraftId, setNewDraftId] = React.useState(() => `desktop-new-${browserId()}`);
  const activeId = app.activeRoom
    ? `room:${app.activeRoom.id}`
    : (app.activeSessionId ?? newDraftId);
  const navigationRevision = React.useRef(0);
  const pendingNewSend = React.useRef<{
    draftId: string;
    navigationRevision: number;
    accepted: boolean;
  } | null>(null);
  const pendingCreate = React.useRef<{
    draftId: string;
    navigationRevision: number;
    previousSessionId?: string;
  } | null>(null);
  const activeIdRef = React.useRef(activeId);
  activeIdRef.current = activeId;
  const [sendingId, setSendingId] = React.useState<string | null>(null);
  const sendingRef = React.useRef<string | null>(null);
  const [error, setError] = React.useState("");
  const draft = drafts.current.get(activeId);
  const changed = () => setDraftRevision((value) => value + 1);
  // A new Desktop session gets its durable ID asynchronously. Carry text typed
  // while its first message was being accepted into that ID, but never move a
  // draft after explicit navigation or overwrite an already edited destination.
  React.useLayoutEffect(() => {
    const pending = pendingNewSend.current;
    if (!pending?.accepted || !app.activeSessionId) return;
    pendingNewSend.current = null;
    if (pending.navigationRevision !== navigationRevision.current || app.activeRoom) return;
    if (drafts.current.get(app.activeSessionId).revision !== 0) return;
    const next = drafts.current.get(pending.draftId);
    if (!next.text && !next.files.length) return;
    const moved = drafts.current.take(pending.draftId).draft;
    drafts.current.setText(app.activeSessionId, moved.text);
    for (const file of moved.files) drafts.current.addFile(app.activeSessionId, file);
    changed();
  }, [app.activeSessionId, app.activeRoom, draftRevision]);
  React.useLayoutEffect(() => {
    const pending = pendingCreate.current;
    if (!pending || !app.activeSessionId || app.activeSessionId === pending.previousSessionId)
      return;
    pendingCreate.current = null;
    if (pending.navigationRevision !== navigationRevision.current || app.activeRoom) return;
    if (drafts.current.get(app.activeSessionId).revision !== 0) return;
    const next = drafts.current.get(pending.draftId);
    if (!next.text && !next.files.length) return;
    const moved = drafts.current.take(pending.draftId).draft;
    drafts.current.setText(app.activeSessionId, moved.text);
    for (const file of moved.files) drafts.current.addFile(app.activeSessionId, file);
    changed();
  }, [app.activeSessionId, app.activeRoom, draftRevision]);
  const selectedProject = workspaceCwd ? projectForCwd(workspaceCwd, app.projects) : undefined;
  const actions: RemoteApp = {
    ...app,
    selectProject: (id) => {
      navigationRevision.current += 1;
      const project = app.projects.find((item) => item.id === id || item.path === id);
      setWorkspaceOverride(project?.path ?? id);
      app.selectProject(id);
      // Project navigation must switch the actual worker target as well as
      // management APIs; otherwise a task labelled B would still run in A.
      actions.newSession(targetForCwd(app, project?.path ?? id));
    },
    selectSession: (id) => {
      navigationRevision.current += 1;
      const selected = app.sessions.find((item) => item.id === id);
      // Shared history is scoped to the current workspace and may contain
      // older rows absent from the paired protocol's recent-session cache.
      const cwd = selected?.cwd ?? workspaceCwd;
      setWorkspaceOverride(cwd);
      if (cwd) {
        const project = projectForCwd(cwd, app.projects);
        app.selectProject(project?.id ?? cwd);
      }
      app.selectSession(id);
      setError("");
    },
    newSession: (target, name) => {
      navigationRevision.current += 1;
      const selected = target === undefined ? targetForCwd(app, workspaceCwd) : target;
      setWorkspaceOverride(selectedTargetCwd(app, selected));
      const draftId = `desktop-new-${browserId()}`;
      draftWorkspaces.current.set(draftId, selectedTargetCwd(app, selected) ?? null);
      pendingCreate.current = {
        draftId,
        navigationRevision: navigationRevision.current,
        previousSessionId: app.activeSessionId,
      };
      setNewDraftId(draftId);
      app.newSession(selected, name);
      setError("");
    },
    openCcSession: (id, cwd, mode) => {
      navigationRevision.current += 1;
      setWorkspaceOverride(cwd);
      app.openCcSession(id, cwd, mode);
      setError("");
    },
  };
  const currentProject = workspaceCwd ? projectForCwd(workspaceCwd, app.projects) : undefined;
  const visibleSessions = app.sessions.filter(
    (item) =>
      !workspaceCwd ||
      item.cwd === workspaceCwd ||
      (currentProject && projectForCwd(item.cwd, app.projects)?.path === currentProject.path),
  );
  const sessions = visibleSessions.map((item) => ({
    sessionId: item.id,
    title: item.title,
    cwd: item.cwd,
    startedAt: item.updatedAt,
    lastActiveAt: item.updatedAt,
    model: "",
    status: item.id === app.activeSessionId ? app.chat.run : "saved",
    turnCount: 0,
  }));
  const running =
    app.chat.run === "running" || app.chat.run === "waiting" || app.approvals.length > 0;
  const send = (): boolean => {
    if (sendingRef.current || app.status !== "online" || running || app.activeRoom?.observing)
      return false;
    const id = activeIdRef.current;
    const current = drafts.current.get(id);
    if (!current.text.trim() && !current.files.length) return false;
    const attachments = current.files.flatMap((file) => {
      const source = localFiles.current.get(file.id);
      return source ? [{ clientId: file.id, file: source }] : [];
    });
    if (attachments.length !== current.files.length) {
      setError("附件已失效，请重新选择。");
      return false;
    }
    const pending =
      !app.activeSessionId && !app.activeRoom
        ? { draftId: id, navigationRevision: navigationRevision.current, accepted: false }
        : null;
    pendingNewSend.current = pending;
    const submitted = drafts.current.take(id);
    changed();
    sendingRef.current = id;
    setSendingId(id);
    setError("");
    void app
      .sendChat({ text: submitted.draft.text, attachments })
      .then((accepted) => {
        if (!accepted) {
          if (pendingNewSend.current === pending) pendingNewSend.current = null;
          drafts.current.restore(submitted);
          if (mounted.current) {
            changed();
            setError("消息未确认送达，内容和附件已保留。请检查连接后重试。");
          }
        } else {
          for (const file of submitted.draft.files) localFiles.current.delete(file.id);
          if (pending) pending.accepted = true;
          if (mounted.current) changed();
        }
      })
      .catch((cause) => {
        if (pendingNewSend.current === pending) pendingNewSend.current = null;
        drafts.current.restore(submitted);
        if (mounted.current) {
          changed();
          setError(cause instanceof Error ? cause.message : "发送失败，内容已保留。");
        }
      })
      .finally(() => {
        sendingRef.current = null;
        if (mounted.current) setSendingId(null);
      });
    return true;
  };
  const addFiles = (selected: FileList | null) => {
    if (!selected?.length) return;
    const id = activeIdRef.current;
    const current = drafts.current.get(id);
    if (!draftWorkspaces.current.has(id)) draftWorkspaces.current.set(id, workspaceCwd);
    const incoming = Array.from(selected);
    if (current.files.length + incoming.length > MOBILE_MAX_ATTACHMENTS) {
      setError(`每条消息最多添加 ${MOBILE_MAX_ATTACHMENTS} 张图片。`);
      return;
    }
    if (
      [...current.files, ...incoming].reduce((total, file) => total + file.size, 0) >
      MOBILE_MAX_ATTACHMENT_TOTAL_BYTES
    ) {
      setError("图片总大小不能超过 20 MiB。");
      return;
    }
    if (incoming.some((file) => file.type && !file.type.startsWith("image/"))) {
      setError("桌面远程会话目前支持图片附件，请选择图片文件。");
      return;
    }
    for (const file of incoming) {
      const id = browserId();
      localFiles.current.set(id, file);
      drafts.current.addFile(activeIdRef.current, {
        id,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        path: "",
      });
    }
    changed();
    setError("");
  };
  const localDrafts = React.useMemo(
    () => drafts.current.unsent().filter((item) => item.sessionId.startsWith("desktop-new-")),
    [draftRevision],
  );
  const selectSession = (id: string) => {
    if (id.startsWith("desktop-new-")) {
      navigationRevision.current += 1;
      pendingCreate.current = {
        draftId: id,
        navigationRevision: navigationRevision.current,
        previousSessionId: app.activeSessionId,
      };
      const cwd = draftWorkspaces.current.get(id) ?? null;
      setWorkspaceOverride(cwd);
      setNewDraftId(id);
      app.newSession(targetForCwd(app, cwd));
      return;
    }
    actions.selectSession(id);
  };
  const title =
    app.activeRoom?.name ||
    (!app.chat.items.length ? "新对话" : "") ||
    app.chat.title ||
    app.sessions.find((item) => item.id === app.activeSessionId)?.title ||
    sessionTitle(app.chat, activeId);
  return {
    host: "desktop",
    workspaceApi: Boolean(session),
    connection:
      app.status === "online"
        ? "open"
        : app.status === "offline" || app.status === "unpaired"
          ? "closed"
          : "connecting",
    session,
    activeId,
    chat: app.chat,
    sessions,
    workspaceCwd,
    workspaceKey,
    workspaceName: workspaceCwd?.split(/[\\/]/).filter(Boolean).pop() || "桌面工作区",
    title,
    configuration,
    configurationVersion,
    sessionsVersion,
    draft: draft.text,
    files: draft.files,
    uploading: sendingId === activeId,
    uploadBusy: sendingId !== null,
    hasUnsent: drafts.current.unsent().length > 0,
    uncertain: false,
    running,
    localDrafts,
    approvals: app.approvals.map((approval) => ({
      id: approval.requestId,
      sessionId: approval.roomId ? undefined : approval.sessionId,
    })),
    approvalCount: (id) => app.approvals.filter((approval) => approval.sessionId === id).length,
    approvalContent: app.approvals.map((approval) => (
      <DesktopApproval key={approval.requestId} approval={approval} app={app} />
    )),
    error: error || app.notice || "",
    clearError: () => setError(""),
    setDraft: (text) => {
      if (!draftWorkspaces.current.has(activeIdRef.current))
        draftWorkspaces.current.set(activeIdRef.current, workspaceCwd);
      drafts.current.setText(activeIdRef.current, text);
      changed();
    },
    removeFile: (id) => {
      drafts.current.removeFile(activeIdRef.current, id);
      localFiles.current.delete(id);
      changed();
    },
    selectSession,
    newSession: () => actions.newSession(),
    send,
    stop: app.stopRun,
    addFiles,
    refreshSessions: () => {
      app.refreshSessions();
      setSessionsVersion((value) => value + 1);
    },
    refreshConfiguration,
    onAuthLost,
    renderSidebar: (navigation) => (
      <DesktopSidebar
        cliCwd={
          app.activeProjectCwd ??
          (app.activeCwd
            ? (projectForCwd(app.activeCwd, app.projects)?.path ?? app.activeCwd)
            : null)
        }
        app={{
          ...actions,
          activeProjectId: selectedProject?.id ?? null,
          activeProjectCwd: workspaceCwd,
        }}
        navigation={navigation}
      />
    ),
    chatControls: <DesktopChatControls app={actions} />,
    goalActions: app.activeSessionId ? (
      <>
        <button className="library-button" onClick={() => app.extendGoal(app.activeSessionId!)}>
          继续目标
        </button>
        <button className="library-button" onClick={() => app.clearGoal(app.activeSessionId!)}>
          结束目标
        </button>
      </>
    ) : undefined,
    loading: app.loading.sessionHistory || app.loading.roomHistory,
    readOnly: app.activeRoom?.observing,
    readOnlyNote: app.activeRoom?.observing
      ? "此 CLI 会话正在桌面运行，当前设备以只读方式查看。"
      : undefined,
    attachmentAccept: "image/*",
    cameraAttachments: true,
    unreadSessionIds: app.unreadSessionIds,
    accountName: app.deviceName,
    showTurnCounts: false,
    logout: () => {
      void post("/api/v1/auth/logout")
        .catch(() => undefined)
        .finally(app.logout);
    },
    onHostNotification: (method, params) => {
      if (method === "serve/sessionsChanged") {
        appRef.current.refreshSessions();
        setSessionsVersion((value) => value + 1);
      }
      if (
        method === "serve/configurationChanged" &&
        (!params.cwd || params.cwd === workspaceRef.current)
      )
        void refreshConfiguration();
    },
  };
}
