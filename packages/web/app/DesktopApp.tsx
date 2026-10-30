import { EnvironmentMenu } from "./EnvironmentMenu.js";
import React from "react";
import {
  useRemoteApp,
  type RemoteApp,
  type MobileSessionCreateTarget,
} from "../src/hooks/useRemoteApp.js";
import { deviceStore } from "../src/lib/storage.js";
import { generateSecret } from "../src/lib/deviceCredential.js";
import { projectForCwd, sameProjectPath } from "../src/lib/format.js";
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
import { DesktopModelPicker, desktopRuntimeModel } from "./DesktopModelPicker.js";
import type { WorkbenchController } from "./workbench-types.js";
import { DesktopAccessChallenge } from "./DesktopAccessChallenge.js";
import { DesktopPairingNotice } from "./DesktopPairingNotice.js";
import { OutputHistoryRecovery } from "../src/components/OutputHistoryRecovery.js";
import { t } from "../src/i18n/translate.js";

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
            // HTTP can reject a rotated entrance cookie while pairing is still
            // valid. Only the socket's device-auth failure discards that identity.
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
  React.useEffect(() => {
    if (!app.accessRequired || !controller.hasUnsent) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [app.accessRequired, controller.hasUnsent]);
  if (app.accessRequired)
    return (
      <DesktopAccessChallenge draft={controller.draft} onVerify={() => window.location.reload()} />
    );
  if (!session) {
    const unpaired = app.status === "unpaired";
    return (
      <main className="desktop-connection">
        <div className="desktop-connection-card">
          <EnvironmentMenu discover={false} />
          {unpaired ? (
            <DesktopPairingNotice />
          ) : (
            <>
              <h1>{authError ? "桌面连接需要重试" : "正在连接桌面…"}</h1>
              <p>{authError || "正在恢复已配对设备与桌面工作区的连接。"}</p>
            </>
          )}
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
  const root = project?.roots?.find((item) => sameProjectPath(item.path, cwd, project));
  return project?.id ? { projectId: project.id, ...(root ? { rootId: root.id } : {}) } : cwd;
}

export function useDesktopController(
  app: RemoteApp,
  session: AuthSession | undefined,
  onAuthLost: () => void,
): WorkbenchController & {
  onHostNotification: (method: string, params: Record<string, unknown>) => void;
} {
  const [workspaceOverride, setWorkspaceOverride] = React.useState<string | null | undefined>(
    () => {
      // Restore the management workspace captured before leaving for Link. The Host
      // still validates device/project permission on every request; never fall back to another project.
      if (window.location?.pathname !== "/mobile/") return undefined;
      const query = new URLSearchParams(window.location.search);
      return query.get("view") === "links" && query.getAll("workspace").length === 1
        ? query.get("workspace") || null
        : undefined;
    },
  );
  const [workspaceSessionId, setWorkspaceSessionId] = React.useState<string>();
  // Only an explicitly selected conversation owns this override. Link returns
  // and pending new/CLI conversations keep their separately selected workspace.
  const selectedSessionCwd =
    workspaceSessionId === app.activeSessionId && workspaceSessionId && !app.activeRoomId
      ? app.activeCwd
      : undefined;
  const workspaceCwd =
    selectedSessionCwd ??
    (workspaceOverride === undefined
      ? (app.activeCwd ?? app.activeProjectCwd ?? null)
      : workspaceOverride);
  React.useLayoutEffect(() => {
    // A paged or reconnecting catalog may temporarily omit the selected row.
    // Keep its last authoritative root instead of falling back to an older one.
    if (selectedSessionCwd != null) setWorkspaceOverride(selectedSessionCwd);
  }, [selectedSessionCwd]);
  const workspaceKey = workspaceCwd ?? "desktop-unbound";
  const sessionProject = projectForCwd(workspaceCwd, app.projects);
  const sessionScopeKey = JSON.stringify(
    workspaceCwd
      ? sessionProject?.roots?.length
        ? sessionProject.roots.map((root) => root.path).sort()
        : [sessionProject?.path ?? workspaceCwd]
      : [],
  );
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
  const onAuthLostRef = React.useRef(onAuthLost);
  onAuthLostRef.current = onAuthLost;
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
      if (mounted.current && error instanceof ApiError && error.status === 401)
        onAuthLostRef.current();
    }
  }, [session]);
  React.useEffect(() => {
    setConfiguration(null);
    void refreshConfiguration();
  }, [workspaceCwd, refreshConfiguration]);
  React.useEffect(() => {
    if (app.status === "online") {
      appRef.current.refreshSessions(JSON.parse(sessionScopeKey));
      appRef.current.refreshRuntimeModels?.();
      void refreshConfiguration();
    }
  }, [app.status, sessionScopeKey, refreshConfiguration]);
  React.useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") {
        void refreshConfiguration();
        appRef.current.refreshSessions();
        appRef.current.refreshRuntimeModels?.();
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
  const modelChoices = React.useRef(new Map<string, string>());
  const activeModelMetadata = React.useRef<{ sessionId: string; model: string } | undefined>(
    undefined,
  );
  const [draftRevision, setDraftRevision] = React.useState(0);
  const [newDraftId, setNewDraftId] = React.useState(() => `desktop-new-${browserId()}`);
  const activeId = app.activeRoom
    ? `room:${app.activeRoom.id}`
    : (app.activeSessionId ?? newDraftId);
  const navigationRevision = React.useRef(0);
  const pendingNewSend = React.useRef<{
    draftId: string;
    navigationRevision: number;
    settled: boolean;
  } | null>(null);
  const pendingCreate = React.useRef<{
    draftId: string;
    navigationRevision: number;
    previousSessionId?: string;
    failureCount: number;
  } | null>(null);
  const [creationNeedsRetry, setCreationNeedsRetry] = React.useState(false);
  const activeIdRef = React.useRef(activeId);
  activeIdRef.current = activeId;
  const [sendingId, setSendingId] = React.useState<string | null>(null);
  const sendingRef = React.useRef<string | null>(null);
  /** Per draft: a sent message whose acceptance never arrived. Retrying the
   *  unchanged draft reuses its intent ID so the host cannot run it twice. */
  const uncertainIntents = React.useRef(
    new Map<string, { clientMessageId: string; revision: number }>(),
  );
  const replacementMigration = React.useRef<{
    fromSessionId: string;
    navigationRevision: number;
    workspaceKey: string;
  } | null>(null);
  const emptyReplacement =
    !app.activeRoomId &&
    app.emptySessionReplacement &&
    app.emptySessionReplacement.fromSessionId === app.activeSessionId &&
    app.emptySessionReplacement.status !== "complete"
      ? app.emptySessionReplacement
      : undefined;
  const [error, setError] = React.useState("");
  const draft = drafts.current.get(activeId);
  const activeMetadata = app.sessions.find((item) => item.id === activeId);
  if (activeMetadata) {
    activeModelMetadata.current = {
      sessionId: activeId,
      model: desktopRuntimeModel(activeMetadata),
    };
  }
  // Refreshing page one does not change the producer of a selected older row.
  const persistedModel =
    activeModelMetadata.current?.sessionId === activeId ? activeModelMetadata.current.model : "";
  const selectedModel = modelChoices.current.get(activeId) ?? persistedModel;
  const changed = () => setDraftRevision((value) => value + 1);
  React.useLayoutEffect(() => {
    const replacement = app.emptySessionReplacement;
    if (!replacement) {
      replacementMigration.current = null;
      return;
    }
    if (replacement.status !== "complete") {
      if (replacement.fromSessionId === activeId && !replacementMigration.current)
        replacementMigration.current = {
          fromSessionId: replacement.fromSessionId,
          navigationRevision: navigationRevision.current,
          workspaceKey,
        };
      return;
    }
    const pending = replacementMigration.current;
    replacementMigration.current = null;
    const destination = replacement.toSessionId;
    if (
      !pending ||
      pending.fromSessionId !== replacement.fromSessionId ||
      pending.navigationRevision !== navigationRevision.current ||
      pending.workspaceKey !== workspaceKey ||
      !destination ||
      destination === replacement.fromSessionId ||
      activeId !== destination ||
      app.activeRoomId
    )
      return;
    // The hook proves this was never dispatched. Carry only local composer
    // state to the newly acknowledged ID; no message or upload is replayed.
    const source = replacement.fromSessionId;
    drafts.current.restore({ ...drafts.current.take(source), sessionId: destination });
    if (!modelChoices.current.has(destination) && modelChoices.current.has(source))
      modelChoices.current.set(destination, modelChoices.current.get(source)!);
    modelChoices.current.delete(source);
    if (!draftWorkspaces.current.has(destination) && draftWorkspaces.current.has(source))
      draftWorkspaces.current.set(destination, draftWorkspaces.current.get(source)!);
    draftWorkspaces.current.delete(source);
    setWorkspaceSessionId((id) => (id === source ? destination : id));
    changed();
  }, [app.emptySessionReplacement, activeId, app.activeRoomId, workspaceKey]);
  React.useLayoutEffect(() => {
    const pending = pendingCreate.current;
    if (!pending || (app.sessionCreationFailures ?? 0) <= pending.failureCount) return;
    pendingCreate.current = null;
    if (pending.navigationRevision !== navigationRevision.current || app.activeRoom) return;
    if (
      app.activeSessionId &&
      app.activeSessionId === pending.previousSessionId &&
      pending.draftId !== activeId
    ) {
      // A rejected socket send leaves the old conversation selected. Bring
      // its moved draft back into the visible composer without losing text or
      // attachments entered while creation was pending.
      const moved = drafts.current.take(pending.draftId);
      drafts.current.restore({ ...moved, sessionId: activeId });
      modelChoices.current.set(activeId, modelChoices.current.get(pending.draftId) ?? "");
      modelChoices.current.delete(pending.draftId);
      changed();
    }
    setCreationNeedsRetry(true);
    setError("新会话未建立。输入内容和模型选择已保留，请重试建立会话。");
  }, [app.sessionCreationFailures]);
  // A new Desktop session gets its durable ID asynchronously. Carry text typed
  // while its first message was being accepted into that ID, but never move a
  // draft after explicit navigation or overwrite an already edited destination.
  React.useLayoutEffect(() => {
    const pending = pendingNewSend.current;
    if (!pending?.settled || !app.activeSessionId) return;
    pendingNewSend.current = null;
    if (pending.navigationRevision !== navigationRevision.current || app.activeRoom) return;
    if (modelChoices.current.has(pending.draftId)) {
      modelChoices.current.set(app.activeSessionId, modelChoices.current.get(pending.draftId)!);
      modelChoices.current.delete(pending.draftId);
      changed();
    }
    if (drafts.current.get(app.activeSessionId).revision !== 0) return;
    const next = drafts.current.get(pending.draftId);
    if (!next.text && !next.files.length) return;
    const moved = drafts.current.take(pending.draftId).draft;
    drafts.current.setText(app.activeSessionId, moved.text);
    for (const file of moved.files) drafts.current.addFile(app.activeSessionId, file);
    const uncertain = uncertainIntents.current.get(pending.draftId);
    if (uncertain) {
      uncertainIntents.current.delete(pending.draftId);
      uncertainIntents.current.set(app.activeSessionId, {
        ...uncertain,
        revision: drafts.current.get(app.activeSessionId).revision,
      });
    }
    changed();
  }, [app.activeSessionId, app.activeRoom, draftRevision]);
  React.useLayoutEffect(() => {
    const pending = pendingCreate.current;
    if (!pending || !app.activeSessionId || app.activeSessionId === pending.previousSessionId)
      return;
    pendingCreate.current = null;
    if (pending.navigationRevision !== navigationRevision.current || app.activeRoom) return;
    if (modelChoices.current.has(pending.draftId)) {
      modelChoices.current.set(app.activeSessionId, modelChoices.current.get(pending.draftId)!);
      modelChoices.current.delete(pending.draftId);
      changed();
    }
    if (drafts.current.get(app.activeSessionId).revision !== 0) return;
    const next = drafts.current.get(pending.draftId);
    if (!next.text && !next.files.length) return;
    const moved = drafts.current.take(pending.draftId).draft;
    drafts.current.setText(app.activeSessionId, moved.text);
    for (const file of moved.files) drafts.current.addFile(app.activeSessionId, file);
    changed();
  }, [app.activeSessionId, app.activeRoom, draftRevision]);
  // Reconnect recovery shows whether an unconfirmed message was recorded. If
  // it was, its untouched restored copy would only invite a second send.
  React.useLayoutEffect(() => {
    if (app.outputHistoryFailed) return;
    const intent = uncertainIntents.current.get(activeId);
    if (
      !intent ||
      !app.chat.items.some(
        (item) => item.kind === "user" && item.clientMessageId === intent.clientMessageId,
      )
    )
      return;
    uncertainIntents.current.delete(activeId);
    if (drafts.current.get(activeId).revision === intent.revision) drafts.current.take(activeId);
    changed();
    setError("");
  }, [app.chat.items, activeId, app.outputHistoryFailed]);
  const selectedProject = workspaceCwd ? projectForCwd(workspaceCwd, app.projects) : undefined;
  const actions: RemoteApp = {
    ...app,
    selectProject: (id) => {
      if (app.status !== "online") {
        setError("连接已断开，重新连接后才能切换项目。");
        return;
      }
      navigationRevision.current += 1;
      setWorkspaceSessionId(undefined);
      const project = app.projects.find((item) => item.id === id || item.path === id);
      setWorkspaceOverride(project?.path ?? id);
      app.selectProject(id);
      // Project navigation must switch the actual worker target as well as
      // management APIs; otherwise a task labelled B would still run in A.
      actions.newSession(targetForCwd(app, project?.path ?? id));
    },
    selectSession: (id) => {
      if (app.status !== "online") {
        setError("连接已断开，重新连接后才能切换会话。");
        return;
      }
      navigationRevision.current += 1;
      pendingCreate.current = null;
      setCreationNeedsRetry(false);
      setWorkspaceSessionId(id);
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
      if (app.status !== "online") {
        setError("连接已断开，重新连接后才能新建任务。");
        return;
      }
      navigationRevision.current += 1;
      setWorkspaceSessionId(undefined);
      const selected = target === undefined ? targetForCwd(app, workspaceCwd) : target;
      setWorkspaceOverride(selectedTargetCwd(app, selected));
      const draftId = `desktop-new-${browserId()}`;
      draftWorkspaces.current.set(draftId, selectedTargetCwd(app, selected) ?? null);
      pendingCreate.current = {
        draftId,
        navigationRevision: navigationRevision.current,
        previousSessionId: app.activeSessionId,
        failureCount: app.sessionCreationFailures ?? 0,
      };
      setCreationNeedsRetry(false);
      setNewDraftId(draftId);
      app.newSession(selected, name);
      setError("");
    },
    openCcSession: (id, cwd, mode) => {
      if (app.status !== "online") {
        setError("连接已断开，重新连接后才能打开 CLI 会话。");
        return;
      }
      navigationRevision.current += 1;
      pendingCreate.current = null;
      setCreationNeedsRetry(false);
      setWorkspaceSessionId(undefined);
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
    model: item.model ?? "",
    status: item.id === app.activeSessionId ? app.chat.run : "saved",
    turnCount: 0,
  }));
  const running =
    app.chat.run === "running" ||
    app.chat.run === "waiting" ||
    app.approvals.some((approval) => !approval.asynchronous);
  const send = (options?: { modelTraceSource?: string }): boolean => {
    if (app.outputHistoryFailed || emptyReplacement) return false;
    if (sendingRef.current || app.status !== "online" || running || app.activeRoom?.observing)
      return false;
    if (pendingCreate.current || creationNeedsRetry) return false;
    if (selectedModel && (app.loading.sessionHistory || !app.activeSessionId)) return false;
    if ((app.activeCwd ?? app.activeProjectCwd ?? null) !== workspaceCwd) {
      setError("当前会话属于另一个工作区。请选择本项目的会话，或新建任务。");
      return false;
    }
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
        ? { draftId: id, navigationRevision: navigationRevision.current, settled: false }
        : null;
    pendingNewSend.current = pending;
    const retry = uncertainIntents.current.get(id);
    uncertainIntents.current.delete(id);
    const retryId = retry?.revision === current.revision ? retry.clientMessageId : undefined;
    const submitted = drafts.current.take(id);
    changed();
    sendingRef.current = id;
    setSendingId(id);
    setError("");
    // A failed retry (including upload/offline failure before send) cannot
    // prove that the original uncertain submission was never admitted.
    let uncertainId: string | undefined = retryId;
    let retired = false;
    void app
      .sendChat({
        text: submitted.draft.text,
        attachments,
        ...(selectedModel && !app.activeRoomId ? { modelKey: selectedModel } : {}),
        ...(options?.modelTraceSource ? { modelTraceSource: options.modelTraceSource } : {}),
        ...(retryId ? { clientMessageId: retryId } : {}),
        onUncertain: (clientMessageId) => {
          uncertainId = clientMessageId;
        },
        onRetired: () => {
          retired = true;
          uncertainId = undefined;
        },
      })
      .then((accepted) => {
        if (!accepted) {
          if (pendingNewSend.current === pending) {
            if (pending && uncertainId) pending.settled = true;
            else pendingNewSend.current = null;
          }
          const restored = drafts.current.restore(submitted);
          // Only an untouched draft can be the same intent; merged text with
          // later typing is a new message when the user sends it.
          if (uncertainId && restored === "restored")
            uncertainIntents.current.set(id, {
              clientMessageId: uncertainId,
              revision: drafts.current.get(id).revision,
            });
          if (mounted.current) {
            changed();
            setError(
              retired
                ? "恢复已取消旧发送等待。内容和附件已保留为草稿，请核对记录后手动处理。"
                : uncertainId
                  ? "无法确认消息是否已送达。内容已放回输入框；直接重试不会重复执行同一条消息。"
                  : restored === "merged"
                    ? "消息未送达。原内容和附件已放回输入框，之后输入的内容也已保留。"
                    : "消息未送达，内容和附件已保留。请检查连接后重试。",
            );
          }
        } else {
          for (const file of submitted.draft.files) localFiles.current.delete(file.id);
          if (pending) pending.settled = true;
          if (mounted.current) changed();
        }
      })
      .catch((cause) => {
        if (pendingNewSend.current === pending) pendingNewSend.current = null;
        // restore() never drops the submission: it is merged before later typing.
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
      if (app.status !== "online") {
        setError("连接已断开，重新连接后才能继续这个新任务。");
        return;
      }
      navigationRevision.current += 1;
      setWorkspaceSessionId(undefined);
      pendingCreate.current = {
        draftId: id,
        navigationRevision: navigationRevision.current,
        previousSessionId: app.activeSessionId,
        failureCount: app.sessionCreationFailures ?? 0,
      };
      setCreationNeedsRetry(false);
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
  const chooseRuntimeModel = (modelKey: string, forceCreation = false) => {
    if (
      app.status !== "online" ||
      running ||
      sendingRef.current ||
      app.loading.sessionHistory ||
      emptyReplacement?.status === "pending" ||
      uncertainIntents.current.has(activeId)
    )
      return;
    if (modelKey && !app.runtimeModels?.some((model) => model.key === modelKey)) return;
    if (emptyReplacement) {
      modelChoices.current.set(activeId, modelKey);
      changed();
      return;
    }
    if (
      forceCreation ||
      (modelKey && !app.activeSessionId && !pendingCreate.current) ||
      (!modelKey && (persistedModel || (selectedModel && app.chat.items.length)))
    ) {
      // Returning from an external producer to Core creates an explicit
      // native session; omitting modelKey must never silently reuse the CLI.
      const previous = drafts.current.take(activeId).draft;
      actions.newSession();
      const nextId = pendingCreate.current!.draftId;
      drafts.current.setText(nextId, previous.text);
      for (const file of previous.files) drafts.current.addFile(nextId, file);
      modelChoices.current.set(nextId, modelKey);
      if (!modelKey) setError("已新建默认模型会话，输入内容已保留。");
    } else {
      modelChoices.current.set(activeId, modelKey);
    }
    changed();
  };
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
    panelSessionId:
      app.activeRoomId ||
      creationNeedsRetry ||
      (pendingCreate.current && app.activeSessionId === pendingCreate.current.previousSessionId)
        ? undefined
        : app.activeSessionId,
    chat: app.chat,
    sessions,
    workspaceCwd,
    workspaceKey,
    projects: app.projects,
    selectedProjectId: selectedProject?.id ?? workspaceCwd ?? undefined,
    selectProject: actions.selectProject,
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
    uncertain: uncertainIntents.current.has(activeId),
    running,
    localDrafts,
    approvals: (app.outputHistoryFailed ? [] : app.approvals).map((approval) => ({
      id: approval.requestId,
      sessionId: approval.roomId ? undefined : approval.sessionId,
      ...(approval.asynchronous ? { asynchronous: true } : {}),
    })),
    approvalCount: (id) => app.approvals.filter((approval) => approval.sessionId === id).length,
    approvalContent: (app.outputHistoryFailed ? [] : app.approvals).map((approval) => (
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
    chatControls: (
      <>
        <DesktopChatControls app={actions} />
        {app.activeSessionId &&
        !app.activeRoomId &&
        app.getSessionOutputRecoveryPlan &&
        app.applySessionOutputRecovery ? (
          <OutputHistoryRecovery
            sessionId={app.activeSessionId}
            identity={app.outputRecoveryIdentity ?? `${workspaceKey}:${app.activeSessionId}`}
            failed={!!app.outputHistoryFailed}
            historicalGap={app.outputHistoricalGap}
            disabled={app.status !== "online" || app.loading.sessionHistory || sendingId !== null}
            plan={app.getSessionOutputRecoveryPlan}
            apply={app.applySessionOutputRecovery}
            onApplied={() => {
              // The content stays in the draft, but its old delivery identity is retired.
              uncertainIntents.current.delete(activeId);
              changed();
              setError("");
            }}
          />
        ) : null}
      </>
    ),
    modelSelector: app.activeRoomId ? undefined : (
      <DesktopModelPicker
        key={`${workspaceKey}:${activeId}`}
        models={app.runtimeModels ?? []}
        value={selectedModel}
        defaultLabel={
          configuration?.connections.find((item) => item.id === configuration.defaults.text)
            ?.model || "默认模型"
        }
        loading={app.runtimeModelsLoading}
        error={app.runtimeModelsError}
        disabled={
          app.status !== "online" ||
          app.outputHistoryFailed ||
          running ||
          sendingId !== null ||
          app.loading.sessionHistory ||
          emptyReplacement?.status === "pending" ||
          uncertainIntents.current.has(activeId)
        }
        onRefresh={app.refreshRuntimeModels}
        onChange={chooseRuntimeModel}
        onRetryCreation={
          emptyReplacement?.status === "failed"
            ? () => {
                const current = appRef.current;
                if (
                  current.activeSessionId === emptyReplacement.fromSessionId &&
                  current.emptySessionReplacement?.fromSessionId ===
                    emptyReplacement.fromSessionId &&
                  current.emptySessionReplacement.status === "failed"
                )
                  current.retryEmptySessionReplacement?.();
              }
            : creationNeedsRetry
              ? () => chooseRuntimeModel(selectedModel, true)
              : undefined
        }
      />
    ),
    goalActions:
      app.activeSessionId && !app.outputHistoryFailed ? (
        <>
          <button className="library-button" onClick={() => app.extendGoal(app.activeSessionId!)}>
            继续目标
          </button>
          <button className="library-button" onClick={() => app.clearGoal(app.activeSessionId!)}>
            结束目标
          </button>
        </>
      ) : undefined,
    loading:
      app.loading.sessionHistory ||
      app.loading.roomHistory ||
      Boolean(pendingCreate.current) ||
      Boolean(emptyReplacement),
    historyHasEarlier: app.historyHasEarlier,
    historyLoadingEarlier: app.historyLoadingEarlier,
    historyEarlierError: app.historyEarlierError,
    loadEarlierHistory: app.loadEarlierHistory,
    loadHistoryDetail: app.loadHistoryDetail,
    reloadHistory: app.reloadHistory,
    loadingLabel: emptyReplacement
      ? emptyReplacement.status === "failed"
        ? "新会话未建立。输入内容和附件已保留，请重试建立会话。"
        : "正在重新建立未发送的会话，输入内容和附件会保留。"
      : app.sessionHistoryProgress
        ? app.sessionHistoryProgress.totalBytes
          ? t("mobile.historyRecovery.loadingProgress", {
              percent: Math.min(
                99,
                Math.floor(
                  (app.sessionHistoryProgress.receivedBytes /
                    app.sessionHistoryProgress.totalBytes) *
                    100,
                ),
              ),
            })
          : t("mobile.historyRecovery.loadingPages", { pages: app.sessionHistoryProgress.pages })
        : undefined,
    readOnly: app.activeRoom?.observing || app.outputHistoryFailed,
    readOnlyNote: app.outputHistoryFailed
      ? "会话记录尚未完成核对。输入内容已保留为草稿，请先恢复记录。"
      : app.activeRoom?.observing
        ? "此 CLI 会话正在桌面运行，当前设备以只读方式查看。"
        : undefined,
    attachmentAccept: "image/*",
    cameraAttachments: true,
    unreadSessionIds: app.unreadSessionIds,
    accountName: app.deviceName,
    showTurnCounts: false,
    logout: () => {
      // The request already carries this browser's cookie, so the host revokes
      // the HTTP session whenever it arrives; a stalled network must not keep
      // the device signed in and connected locally.
      void post("/api/v1/auth/logout").catch(() => undefined);
      app.logout();
    },
    onHostNotification: (method, _params) => {
      if (method === "serve/sessionsChanged") {
        appRef.current.refreshSessions();
        setSessionsVersion((value) => value + 1);
      }
      // A Panel mutation names its binding project, while this view may execute
      // in a secondary root or an external worktree. Treat this as invalidation
      // only: reread the current authorized workspace, never the notified path.
      if (method === "serve/configurationChanged") void refreshConfiguration();
    },
  };
}
