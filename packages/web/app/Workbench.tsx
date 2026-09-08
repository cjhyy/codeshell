import React from "react";
import { Devices } from "./Devices.js";
import { HubSettings, type HubSettingsSection } from "./HubSettings.js";
import { HubFiles } from "./HubFiles.js";
import { HubSessions } from "./HubSessions.js";
import { HubLinks } from "./HubLinks.js";
import { HubPanels } from "./HubPanels.js";
import { PanelHost } from "./PanelHost.js";
import type { ManagedPanel } from "../../server/src/panels/types.js";
import { MessageContent, ToolMessage, subagentStatusLabel } from "./MessageContent.js";
import { sessionTitle } from "./chat.js";
import type { WorkbenchController } from "./workbench-types.js";
import "./app.css";
import "./workbench-desktop.css";

/** Both host controllers store drafts synchronously before send reads them. */
export function submitWorkbenchPanelPrompt(
  controller: WorkbenchController,
  request: { prompt: string; sessionId: string; workspaceKey: string },
): { accepted: true } {
  if (request.workspaceKey !== controller.workspaceKey || request.sessionId !== controller.activeId)
    throw new Error("当前工作区或对话已经变化，请重新打开面板后发送。");
  if (controller.connection !== "open" || controller.loading)
    throw new Error("工作台尚未连接，请连接后重新发送面板任务。");
  if (controller.readOnly) throw new Error("当前对话为只读，无法发送面板任务。");
  if (
    controller.running ||
    controller.chat.run === "running" ||
    controller.chat.run === "waiting" ||
    controller.approvals.some(
      (approval) => !approval.sessionId || approval.sessionId === request.sessionId,
    )
  )
    throw new Error("当前对话仍在处理任务，请完成后再发送面板任务。");
  if (controller.uncertain || controller.uploading || controller.uploadBusy)
    throw new Error("当前消息或附件仍在发送，请等待结果后重试。");
  if (controller.draft.length > 0 || controller.files.length > 0)
    throw new Error("当前对话还有草稿或附件，请先处理它们，再发送面板任务。");
  if (!request.prompt.trim() || request.prompt.length > 20000)
    throw new Error("面板任务内容无效。");
  controller.setDraft(request.prompt);
  if (!controller.send()) {
    // The synchronous setter/send pair cannot interleave with another input
    // event. A declined sender has not consumed our just-inserted draft.
    controller.setDraft("");
    throw new Error("当前对话暂时无法接收任务，请稍后重新发送。");
  }
  return { accepted: true };
}

export function Workbench({
  controller,
  onBackToProjects,
  projectName,
}: {
  controller: WorkbenchController;
  onBackToProjects?: () => void;
  projectName?: string;
}) {
  const {
    connection,
    sessions,
    activeId,
    chat,
    draft,
    files,
    uploading,
    workerNote,
    replayNote,
    error,
    workspaceCwd,
    workspaceName,
    configuration,
    configurationVersion,
    sessionsVersion,
    localDrafts,
    running,
    title,
    approvalCount,
    onAuthLost,
    refreshSessions,
    refreshConfiguration,
    session,
  } = controller;
  const hub = controller.workspaceApi;
  const hostLabel = controller.host === "desktop" ? "桌面" : "服务端";
  const [devicesOpen, setDevicesOpen] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const cameraInput = React.useRef<HTMLInputElement>(null);
  const [view, setView] = React.useState<
    "chat" | "settings" | "files" | "history" | "links" | "panels" | "panel"
  >("chat");
  const [openedPanel, setOpenedPanel] = React.useState<{
    panel: ManagedPanel;
    workspaceKey: string;
  }>();
  const [selectedFile, setSelectedFile] = React.useState<string | undefined>();
  const [fileOpenVersion, setFileOpenVersion] = React.useState(0);
  const [navigationDirty, setNavigationDirty] = React.useState(false);
  const [pendingNavigation, setPendingNavigation] = React.useState<(() => void) | null>(null);
  const [settingsSection, setSettingsSection] = React.useState<HubSettingsSection>("overview");
  const [narrow, setNarrow] = React.useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [sidebarOpen, setSidebarOpen] = React.useState(
    () => !window.matchMedia("(max-width: 760px)").matches,
  );
  const sidebarRef = React.useRef<HTMLElement>(null);
  const sidebarToggleRef = React.useRef<HTMLButtonElement>(null);
  const sidebarWasOpen = React.useRef(false);
  const messageListRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const followMessages = React.useRef(true);
  React.useEffect(() => {
    setOpenedPanel(undefined);
    setView((current) => (current === "panel" ? "panels" : current));
  }, [controller.workspaceKey]);
  React.useEffect(() => {
    if (narrow && !sidebarOpen && sidebarWasOpen.current && !devicesOpen) {
      sidebarToggleRef.current?.focus();
    }
    sidebarWasOpen.current = sidebarOpen;
  }, [narrow, sidebarOpen, devicesOpen]);

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const change = () => {
      setNarrow(media.matches);
      setSidebarOpen(!media.matches);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  React.useEffect(() => {
    if (!narrow || !sidebarOpen) return;
    const sidebar = sidebarRef.current;
    sidebar?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      // A native modal above the sidebar owns Escape and focus traversal.
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        setSidebarOpen(false);
        sidebarToggleRef.current?.focus();
      } else if (event.key === "Tab") {
        const buttons = Array.from(
          sidebar?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        ).filter((element) => element.getClientRects().length > 0);
        const first = buttons?.[0];
        const last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow, sidebarOpen]);

  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || view !== "chat") return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(180, Math.max(64, textarea.scrollHeight))}px`;
  }, [draft, view]);

  React.useLayoutEffect(() => {
    const list = messageListRef.current;
    if (list && followMessages.current && view === "chat") list.scrollTop = list.scrollHeight;
  }, [chat.items, controller.approvals.length, view]);

  const closeMobileSidebar = () => {
    if (narrow) {
      setSidebarOpen(false);
      sidebarToggleRef.current?.focus();
    }
  };

  const openSettings = (section: HubSettingsSection) => {
    if (view === "settings" && settingsSection === section) {
      closeMobileSidebar();
      return;
    }
    requestNavigation(() => {
      setSettingsSection(section);
      setView("settings");
      closeMobileSidebar();
    });
  };

  const requestNavigation = (action: () => void) => {
    if (navigationDirty) setPendingNavigation(() => action);
    else action();
  };
  const openFiles = (path?: string) =>
    requestNavigation(() => {
      setSelectedFile(path);
      setFileOpenVersion((value) => value + 1);
      setView("files");
      closeMobileSidebar();
    });
  // Keep settled Markdown memoized while typing, but always use current
  // navigation guards and viewport behavior when a file reference is opened.
  const openFilesHandler = React.useRef(openFiles);
  openFilesHandler.current = openFiles;
  const openMessageFile = React.useCallback((path: string) => openFilesHandler.current(path), []);
  React.useEffect(() => {
    if (!navigationDirty && !controller.uploadBusy && !controller.hasUnsent) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [navigationDirty, controller.uploadBusy, controller.hasUnsent]);

  const openConversation = (action: () => void) =>
    requestNavigation(() => {
      setView("chat");
      closeMobileSidebar();
      followMessages.current = true;
      action();
    });
  const openSession = (id: string) => openConversation(() => void controller.selectSession(id));
  const startNewSession = () => openConversation(controller.newSession);
  const send = () => {
    followMessages.current = true;
    controller.send();
  };
  const stop = controller.stop;
  const approvals = controller.approvals.filter((a) => !a.sessionId || a.sessionId === activeId);
  const otherApprovals = controller.approvals.filter(
    (a) => a.sessionId && a.sessionId !== activeId,
  );
  const empty = chat.items.length === 0 && approvals.length === 0;
  const defaultConnection = configuration?.connections.find(
    (item) => item.id === configuration.defaults.text,
  );
  const connectionLabel =
    connection === "open" ? "已连接" : connection === "connecting" ? "连接中" : "正在重连";
  const currentTitle =
    view === "chat"
      ? title
      : view === "files"
        ? "工作区文件"
        : view === "history"
          ? "历史对话"
          : view === "links"
            ? "Link"
            : view === "panels" || view === "panel"
              ? openedPanel && view === "panel"
                ? openedPanel.panel.title["zh-CN"] || openedPanel.panel.title.default
                : "面板"
              : settingsSection === "skills"
                ? "Skills"
                : "设置";
  return (
    <div className={`shell${sidebarOpen ? " sidebar-open" : ""}`}>
      {narrow && sidebarOpen ? (
        <div
          className="sidebar-backdrop"
          onClick={() => {
            setSidebarOpen(false);
            sidebarToggleRef.current?.focus();
          }}
          aria-hidden="true"
        />
      ) : null}
      <aside
        id="workbench-sidebar"
        ref={sidebarRef}
        className="rail"
        hidden={!sidebarOpen}
        role={narrow ? "dialog" : undefined}
        aria-modal={narrow && sidebarOpen ? true : undefined}
        aria-label="工作台导航"
      >
        <div className="rail-head">
          <span className="brand-mark">
            <WorkbenchIcon name="brand" />
          </span>
          <strong>CodeShell</strong>
          <span className="hub-badge">
            {controller.host === "desktop" ? "Desktop" : hub ? "Hub" : "Web"}
          </span>
          <button
            className="icon-button sidebar-close"
            aria-label="收起侧栏"
            onClick={() => {
              setSidebarOpen(false);
              sidebarToggleRef.current?.focus();
            }}
          >
            <WorkbenchIcon name="sidebar" />
          </button>
        </div>
        <nav className="workbench-nav" aria-label="主要功能">
          {onBackToProjects ? (
            <button
              className="nav-button"
              title={projectName}
              onClick={() => {
                if (navigationDirty || controller.hasUnsent || controller.uploadBusy)
                  setPendingNavigation(() => onBackToProjects);
                else onBackToProjects();
              }}
            >
              <WorkbenchIcon name="folder" />
              <span>返回项目列表</span>
            </button>
          ) : null}
          <button className="nav-button new-chat-button" onClick={startNewSession}>
            <WorkbenchIcon name="plus" />
            <span>新对话</span>
          </button>
          <button
            className={`nav-button${view === "chat" ? " active" : ""}`}
            onClick={() => {
              requestNavigation(() => {
                setView("chat");
                closeMobileSidebar();
              });
            }}
            aria-current={view === "chat" ? "page" : undefined}
          >
            <WorkbenchIcon name="chat" />
            <span>对话</span>
          </button>
          {hub ? (
            <>
              <button
                className={`nav-button${view === "history" ? " active" : ""}`}
                onClick={() =>
                  requestNavigation(() => {
                    setView("history");
                    closeMobileSidebar();
                  })
                }
                aria-current={view === "history" ? "page" : undefined}
              >
                <WorkbenchIcon name="history" />
                <span>历史对话</span>
              </button>
              <button
                className={`nav-button${view === "files" ? " active" : ""}`}
                onClick={() => openFiles()}
                aria-current={view === "files" ? "page" : undefined}
              >
                <WorkbenchIcon name="folder" />
                <span>文件</span>
              </button>
              <button
                className={`nav-button${view === "settings" && settingsSection === "skills" ? " active" : ""}`}
                onClick={() => openSettings("skills")}
                aria-current={
                  view === "settings" && settingsSection === "skills" ? "page" : undefined
                }
              >
                <WorkbenchIcon name="skills" />
                <span>Skills</span>
              </button>
              <button
                className={`nav-button${view === "panels" || view === "panel" ? " active" : ""}`}
                onClick={() =>
                  requestNavigation(() => {
                    setView("panels");
                    closeMobileSidebar();
                  })
                }
                aria-current={view === "panels" || view === "panel" ? "page" : undefined}
              >
                <WorkbenchIcon name="panels" />
                <span>面板</span>
              </button>
              <button
                className={`nav-button${view === "links" ? " active" : ""}`}
                onClick={() =>
                  requestNavigation(() => {
                    setView("links");
                    closeMobileSidebar();
                  })
                }
                aria-current={view === "links" ? "page" : undefined}
              >
                <WorkbenchIcon name="links" />
                <span>Link</span>
              </button>
              <button
                className={`nav-button${view === "settings" && settingsSection !== "skills" ? " active" : ""}`}
                onClick={() => openSettings("overview")}
                aria-current={
                  view === "settings" && settingsSection !== "skills" ? "page" : undefined
                }
              >
                <WorkbenchIcon name="settings" />
                <span>设置</span>
              </button>
            </>
          ) : null}
        </nav>
        <div className="rail-section-label">工作区</div>
        {hub ? (
          <button
            className="workspace-button"
            title={workspaceCwd ?? undefined}
            onClick={() => openFiles()}
          >
            <WorkbenchIcon name="folder" />
            <span>{projectName ?? workspaceName}</span>
            <WorkbenchIcon name="chevron" />
          </button>
        ) : (
          <div className="workspace-button" title={workspaceCwd ?? undefined}>
            <WorkbenchIcon name="folder" />
            <span>{projectName ?? workspaceName}</span>
          </div>
        )}
        <div className="rail-section-label history-label">
          <span>最近对话</span>
          <span>{sessions.length}</span>
        </div>
        {controller.renderSidebar?.({ guard: requestNavigation, conversation: openConversation })}
        <ul className="sessions" aria-label="最近对话">
          {localDrafts.map(({ sessionId, draft: pendingDraft }) => (
            <li key={`draft-${sessionId}`}>
              <button
                className={sessionId === activeId && view === "chat" ? "session active" : "session"}
                onClick={() => void openSession(sessionId)}
              >
                <span className="session-title">
                  {pendingDraft.text.trim() || `附件：${pendingDraft.files[0]?.name ?? "新对话"}`}
                </span>
                <span className="session-meta">草稿</span>
              </button>
            </li>
          ))}
          {sessions.map((item) => (
            <li key={item.sessionId}>
              <button
                className={
                  item.sessionId === activeId && view === "chat" ? "session active" : "session"
                }
                onClick={() => void openSession(item.sessionId)}
                aria-current={item.sessionId === activeId && view === "chat" ? "page" : undefined}
              >
                <span className="session-title">
                  {item.sessionId === activeId
                    ? item.customTitle ||
                      chat.title ||
                      item.title ||
                      sessionTitle(chat, item.sessionId)
                    : item.title || item.preview?.trim() || item.sessionId.slice(0, 8)}
                </span>
                <span className="session-meta">
                  {controller.unreadSessionIds?.has(item.sessionId) &&
                  item.sessionId !== activeId ? (
                    <span className="session-unread" aria-label="有新消息">
                      ●{" "}
                    </span>
                  ) : null}
                  {approvalCount(item.sessionId)
                    ? `${approvalCount(item.sessionId)} 项待审批`
                    : item.running
                      ? "进行中"
                      : sessionStatusLabel(item.status)}
                  {controller.showTurnCounts !== false ? <span> · {item.turnCount} 轮</span> : null}
                </span>
              </button>
            </li>
          ))}
          {sessions.length === 0 && localDrafts.length === 0 ? (
            <li className="empty">开始对话后，记录会保存在这里。</li>
          ) : null}
        </ul>
        <div className="rail-footer">
          <div className="host-label">
            <span className={`dot ${connection}`} />
            <span>
              {hostLabel}
              {connectionLabel}
            </span>
          </div>
          {controller.host === "hub" ? (
            <button
              className="account-button"
              onClick={() => {
                closeMobileSidebar();
                setDevicesOpen(true);
              }}
            >
              <span className="account-avatar">
                {(session?.username || "C").slice(0, 1).toUpperCase()}
              </span>
              <span className="account-copy">
                <strong>{session?.username || "账号"}</strong>
                <span>设备与退出</span>
              </span>
              <WorkbenchIcon name="chevron" />
            </button>
          ) : null}
          {controller.logout ? (
            <button className="account-button" onClick={controller.logout}>
              <span className="account-avatar">{(controller.accountName || "D").slice(0, 1)}</span>
              <span className="account-copy">
                <strong>{controller.accountName || "已配对设备"}</strong>
                <span>退出此设备</span>
              </span>
            </button>
          ) : null}
        </div>
      </aside>

      <main className="workbench-main" inert={narrow && sidebarOpen ? true : undefined}>
        <header className="workbench-topbar">
          <button
            ref={sidebarToggleRef}
            className="icon-button"
            aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
            aria-expanded={sidebarOpen}
            aria-controls="workbench-sidebar"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <WorkbenchIcon name="sidebar" />
          </button>
          <span className="topbar-title" title={currentTitle}>
            {currentTitle}
          </span>
          <span className="connection-pill" title={`任务在${hostLabel}工作区执行`}>
            <span className={`dot ${connection}`} />
            <span>{hostLabel}</span>
          </span>
        </header>
        {workerNote ? <div className="banner">{workerNote}</div> : null}
        {replayNote ? <div className="banner">{replayNote}</div> : null}
        {error ? (
          <div className="banner form-error" role="alert">
            {error}
            <button className="ghost" aria-label="关闭错误提示" onClick={controller.clearError}>
              ×
            </button>
          </div>
        ) : null}
        {otherApprovals.length ? (
          <div className="banner">
            其他会话有待处理审批。
            {otherApprovals.map((a) => (
              <button className="ghost" key={a.id} onClick={() => void openSession(a.sessionId!)}>
                打开 {a.sessionId!.slice(0, 8)}
              </button>
            ))}
          </div>
        ) : null}
        {connection !== "open" ? (
          <div className="banner">
            连接{connection === "connecting" ? "中…" : "已断开，重连中…"}
          </div>
        ) : null}
        {view !== "chat" && approvals.length > 0 ? (
          <div className="banner">
            当前对话需要你的确认。
            <button className="ghost" onClick={() => requestNavigation(() => setView("chat"))}>
              返回对话
            </button>
          </div>
        ) : null}
        <section
          className={`chat${empty ? " chat-empty" : ""}`}
          hidden={view !== "chat"}
          aria-label="对话"
        >
          <div
            className="messages"
            ref={messageListRef}
            onScroll={(event) => {
              const list = event.currentTarget;
              followMessages.current = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
            }}
          >
            <div className="transcript">
              {controller.chatControls}
              {controller.loading ? (
                <div className="banner" role="status">
                  正在恢复会话记录…
                </div>
              ) : null}
              {chat.goal ? (
                <div className="banner goal">
                  <span>{chat.goal}</span>
                  {controller.goalActions}
                </div>
              ) : null}
              {chat.items.map((item) => {
                switch (item.kind) {
                  case "user":
                    return (
                      <div key={item.id} className="msg user">
                        {item.text}
                        {item.attachments?.map((attachment, index) =>
                          hub && attachment.path ? (
                            <button
                              className="attachment attachment-open"
                              key={index}
                              onClick={() => openFiles(attachment.path)}
                            >
                              📎 {attachment.name}
                            </button>
                          ) : (
                            <span className="attachment" key={index}>
                              📎 {attachment.name}
                            </span>
                          ),
                        )}
                      </div>
                    );
                  case "assistant":
                    if (item.done && !item.text && !item.reasoning) return null;
                    return (
                      <div key={item.id} className="msg assistant">
                        <MessageContent
                          text={item.text}
                          reasoning={item.reasoning}
                          streaming={!item.done}
                          onOpenFile={hub ? openMessageFile : undefined}
                        />
                      </div>
                    );
                  case "tool":
                    return (
                      <div key={item.id} className={`msg tool${item.error ? " tool-error" : ""}`}>
                        <ToolMessage item={item} running={running} />
                      </div>
                    );
                  case "subagent":
                    return (
                      <div key={item.id} className="msg info">
                        ↳ {item.label} · {subagentStatusLabel(item.status)}
                      </div>
                    );
                  case "system_error":
                    return (
                      <div key={item.id} className="msg error">
                        {item.text}
                      </div>
                    );
                  default:
                    return null;
                }
              })}
              {controller.approvalContent}

              {empty ? (
                <div className="empty-chat">
                  <span className="welcome-mark">
                    <WorkbenchIcon name="brand" />
                  </span>
                  <h1>今天想完成什么？</h1>
                  <p>从一个问题或想法开始，让 CodeShell 帮你一步步完成。</p>
                  <span className="welcome-workspace">
                    <WorkbenchIcon name="folder" />
                    {projectName ?? workspaceName}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          {controller.readOnlyNote ? <div className="banner">{controller.readOnlyNote}</div> : null}
          <div className="composer-wrap">
            <footer className="composer">
              {files.length || (uploading && controller.host === "hub") ? (
                <div className="attachments" aria-live="polite">
                  {files.map((file) => (
                    <span className="attachment" key={file.id}>
                      <WorkbenchIcon name="attachment" />
                      {file.name}
                      <button
                        className="ghost"
                        aria-label={`移除 ${file.name}`}
                        onClick={() => {
                          controller.removeFile(file.id);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {uploading && controller.host === "hub" ? <span>正在上传…</span> : null}
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                aria-label="任务内容"
                value={draft}
                disabled={controller.readOnly}
                rows={2}
                placeholder="描述你的任务，或提出一个问题…"
                onChange={(event) => {
                  controller.setDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-toolbar">
                {hub ? (
                  <>
                    <input
                      hidden
                      multiple
                      type="file"
                      accept={controller.attachmentAccept}
                      ref={fileInput}
                      onChange={(event) => {
                        const input = event.currentTarget;
                        void Promise.resolve(controller.addFiles(input.files)).finally(() => {
                          input.value = "";
                        });
                      }}
                    />
                    <button
                      className="icon-button attach-button"
                      aria-label="添加附件"
                      title="添加附件"
                      disabled={
                        controller.uploadBusy || connection !== "open" || controller.readOnly
                      }
                      onClick={() => fileInput.current?.click()}
                    >
                      <WorkbenchIcon name="plus" />
                    </button>
                    {controller.cameraAttachments ? (
                      <>
                        <input
                          hidden
                          type="file"
                          accept="image/*"
                          capture="environment"
                          ref={cameraInput}
                          onChange={(event) => {
                            const input = event.currentTarget;
                            void Promise.resolve(controller.addFiles(input.files)).finally(() => {
                              input.value = "";
                            });
                          }}
                        />
                        <button
                          className="icon-button attach-button"
                          aria-label="拍照"
                          title="拍照"
                          disabled={
                            controller.uploadBusy || connection !== "open" || controller.readOnly
                          }
                          onClick={() => cameraInput.current?.click()}
                        >
                          <WorkbenchIcon name="camera" />
                        </button>
                      </>
                    ) : null}
                    <button
                      className="model-button"
                      title="打开模型设置"
                      onClick={() => openSettings("models")}
                    >
                      <span>{defaultConnection?.model || "配置模型"}</span>
                      <WorkbenchIcon name="chevron" />
                    </button>
                  </>
                ) : null}
                <span className="composer-run-status" role="status">
                  {controller.uncertain
                    ? "正在核对消息…"
                    : uploading
                      ? controller.host === "desktop"
                        ? "正在发送…"
                        : "正在上传附件…"
                      : approvals.length
                        ? "等待你的确认"
                        : running
                          ? "正在处理…"
                          : ""}
                </span>
                {running ? (
                  <button
                    className="stop composer-submit"
                    aria-label="停止"
                    title="停止"
                    onClick={stop}
                    disabled={connection !== "open"}
                  >
                    <WorkbenchIcon name="stop" />
                  </button>
                ) : (
                  <button
                    className="send composer-submit"
                    aria-label="发送"
                    title="发送"
                    onClick={send}
                    disabled={
                      connection !== "open" ||
                      uploading ||
                      controller.uncertain ||
                      controller.readOnly ||
                      (!draft.trim() && !files.length)
                    }
                  >
                    <WorkbenchIcon name="send" />
                  </button>
                )}
              </div>
            </footer>
            <div className="composer-caption">
              <span>任务在{hostLabel}工作区执行</span>
              <span>Enter 发送 · Shift + Enter 换行</span>
            </div>
          </div>
        </section>
        {view === "settings" && hub ? (
          <HubSettings
            host={controller.host === "desktop" ? "desktop" : "hub"}
            key={`${controller.workspaceKey}:settings`}
            section={settingsSection}
            onSectionChange={openSettings}
            onAuthLost={onAuthLost}
            onConfigurationChange={() => void refreshConfiguration()}
            configurationVersion={configurationVersion}
            onDirtyChange={setNavigationDirty}
          />
        ) : null}
        {view === "files" && hub ? (
          <HubFiles
            key={`${controller.workspaceKey}:files`}
            initialPath={selectedFile}
            openVersion={fileOpenVersion}
            onAuthLost={onAuthLost}
          />
        ) : null}
        {view === "history" && hub ? (
          <HubSessions
            key={`${controller.workspaceKey}:history`}
            onAuthLost={onAuthLost}
            onOpen={(id) => void openSession(id)}
            onChanged={() => void refreshSessions()}
            version={sessionsVersion}
            onDirtyChange={setNavigationDirty}
          />
        ) : null}
        {view === "links" && hub ? (
          <HubLinks
            key={`${controller.workspaceKey}:links`}
            onAuthLost={onAuthLost}
            onDirtyChange={setNavigationDirty}
            hostLabel={hostLabel}
            configurationVersion={configurationVersion}
          />
        ) : null}
        {view === "panels" && hub ? (
          <HubPanels
            key={`${controller.workspaceKey}:panels`}
            onAuthLost={onAuthLost}
            onDirtyChange={setNavigationDirty}
            onChanged={() => void refreshConfiguration()}
            hostLabel={hostLabel}
            configurationVersion={configurationVersion}
            onOpen={(panel) =>
              requestNavigation(() => {
                setOpenedPanel({ panel, workspaceKey: controller.workspaceKey });
                setView("panel");
                closeMobileSidebar();
              })
            }
          />
        ) : null}
        {view === "panel" && hub && openedPanel?.workspaceKey === controller.workspaceKey ? (
          <PanelHost
            key={`${controller.workspaceKey}:panel:${openedPanel.panel.id}:${activeId}`}
            panel={openedPanel.panel}
            sessionId={activeId}
            busy={running || uploading || controller.uncertain}
            onAuthLost={onAuthLost}
            onDirtyChange={setNavigationDirty}
            onClose={() => requestNavigation(() => setView("panels"))}
            onSubmitPrompt={async (request) =>
              submitWorkbenchPanelPrompt(controller, {
                ...request,
                workspaceKey: openedPanel.workspaceKey,
              })
            }
          />
        ) : null}
      </main>
      {pendingNavigation ? (
        <NavigationPrompt
          onStay={() => setPendingNavigation(null)}
          onLeave={() => {
            const action = pendingNavigation;
            setPendingNavigation(null);
            setNavigationDirty(false);
            action();
          }}
        />
      ) : null}
      {devicesOpen && controller.host === "hub" ? (
        <Devices session={session} onClose={() => setDevicesOpen(false)} onAuthLost={onAuthLost} />
      ) : null}
    </div>
  );
}

function NavigationPrompt({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className="navigation-prompt"
      ref={dialog}
      aria-labelledby="navigation-prompt-title"
      onCancel={(event) => {
        event.preventDefault();
        onStay();
      }}
    >
      <h2 id="navigation-prompt-title">还有未保存的修改</h2>
      <p>
        离开会丢弃未提交的修改；切换项目还会清除未发送的草稿和附件。已经提交的操作可能仍会完成，请等待结果后再离开。
      </p>
      <div className="library-actions">
        <button className="library-button primary" onClick={onStay} autoFocus>
          留在此页
        </button>
        <button className="library-button" onClick={onLeave}>
          放弃修改并离开
        </button>
      </div>
    </dialog>
  );
}

function sessionStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "进行中";
    case "waiting":
    case "waiting_approval":
      return "等待确认";
    case "completed":
      return "已完成";
    case "cancelled":
    case "canceled":
      return "已停止";
    case "failed":
    case "error":
      return "发生错误";
    case "idle":
      return "可继续";
    default:
      return "对话";
  }
}

type WorkbenchIconName =
  | "camera"
  | "panels"
  | "links"
  | "brand"
  | "sidebar"
  | "plus"
  | "chat"
  | "history"
  | "skills"
  | "settings"
  | "folder"
  | "chevron"
  | "attachment"
  | "send"
  | "stop";

function WorkbenchIcon({ name }: { name: WorkbenchIconName }) {
  const paths: Record<WorkbenchIconName, React.ReactNode> = {
    panels: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M15 3v18M15 10h6" />
      </>
    ),
    camera: (
      <>
        <path d="M3 7h4l2-3h6l2 3h4v13H3Z" />
        <circle cx="12" cy="13" r="4" />
      </>
    ),
    links: (
      <>
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2" />
        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
      </>
    ),
    brand: (
      <>
        <path d="m5 7 5 5-5 5M13 17h6" />
      </>
    ),
    sidebar: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    chat: (
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
    ),
    history: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5M12 7v5l3 2" />
      </>
    ),
    skills: (
      <>
        <path d="m12 3 2.7 5.5L21 9.4l-4.5 4.4 1.1 6.2L12 17.1 6.4 20l1.1-6.2L3 9.4l6.3-.9L12 3Z" />
      </>
    ),
    settings: (
      <>
        <path d="m9 3-.7 3-2.6 1-2.6 2 1.4 3-1.4 3 2.6 2 2.6 1 .7 3h6l.7-3 2.6-1 2.6-2-1.4-3 1.4-3-2.6-2-2.6-1L15 3H9Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    folder: (
      <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    attachment: (
      <path d="m21 11-8 8a6 6 0 0 1-8.5-8.5l9-9A4 4 0 0 1 19 7l-9 9a2 2 0 0 1-2.8-2.8l8-8" />
    ),
    send: <path d="M12 19V5m-6 6 6-6 6 6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
