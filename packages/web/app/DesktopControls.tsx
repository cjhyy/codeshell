import React from "react";
import type {
  MobileRemotePermissionMode,
  ApprovalScope,
  ApprovalPathScope,
} from "@cjhyy/code-shell-core";
import type { RemoteApp, PendingApproval } from "../src/hooks/useRemoteApp.js";
import type { WorkbenchNavigation } from "./workbench-types.js";

const permissionModes: Array<{
  value: MobileRemotePermissionMode;
  label: string;
  description: string;
}> = [
  {
    value: "default",
    label: "逐次确认",
    description: "需要权限时先询问，保留桌面的工作区权限设置。",
  },
  {
    value: "acceptEdits",
    label: "允许编辑",
    description: "自动批准文件编辑，其他操作仍按权限规则确认。",
  },
  {
    value: "bypassPermissions",
    label: "跳过确认",
    description: "在主机允许的范围内自动批准工具操作。",
  },
];

export function DesktopChatControls({ app }: { app: RemoteApp }) {
  return (
    <div className="desktop-chat-controls">
      <label>
        权限模式
        <select
          aria-label="权限模式"
          value={app.permissionMode}
          onChange={(event) => {
            const mode = event.target.value as MobileRemotePermissionMode;
            if (
              mode === "bypassPermissions" &&
              app.permissionMode !== mode &&
              !window.confirm("切换后将自动批准工具操作。确定跳过权限确认吗？")
            )
              return;
            app.setPermissionMode(mode);
          }}
        >
          {permissionModes.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      {app.activeRoom ? (
        <>
          <span className="desktop-room-label">{app.activeRoom.name}</span>
          <button className="library-button" onClick={app.leaveRoom}>
            离开 CLI 会话
          </button>
        </>
      ) : null}
    </div>
  );
}

export function DesktopSidebar({
  app,
  navigation,
  cliCwd,
}: {
  app: RemoteApp;
  navigation: WorkbenchNavigation;
  cliCwd?: string | null;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [picking, setPicking] = React.useState<{ id: string; cwd: string; label: string } | null>(
    null,
  );
  const cwd = cliCwd === undefined ? (app.activeProjectCwd ?? app.activeCwd ?? null) : cliCwd;
  return (
    <div className="desktop-sidebar-controls">
      <label className="desktop-project-picker">
        项目
        <select
          aria-label="选择项目"
          value={app.activeProjectId ?? app.activeProjectCwd ?? ""}
          onChange={(event) => {
            const selected = event.target.value;
            if (selected) navigation.guard(() => app.selectProject(selected));
          }}
        >
          <option value="" disabled>
            选择项目
          </option>
          {app.projects.map((project) => (
            <option key={project.id ?? project.path} value={project.id ?? project.path}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <div className="desktop-sidebar-actions">
        <button
          className="library-button"
          onClick={() => setCreateOpen((value) => !value)}
          aria-expanded={createOpen}
        >
          选择新会话目录
        </button>
        <button
          className="library-button"
          disabled={app.loading.sessions}
          onClick={app.refreshSessions}
        >
          刷新
        </button>
      </div>
      {createOpen ? (
        <div className="desktop-root-picker">
          <button
            className="session"
            onClick={() =>
              navigation.conversation(() => {
                app.newSession({ projectId: null });
                setCreateOpen(false);
              })
            }
          >
            <span className="session-title">无项目对话</span>
            <span className="session-meta">不绑定代码仓库</span>
          </button>
          {!app.projects.length && app.activeCwd ? (
            <button
              className="session"
              onClick={() =>
                navigation.conversation(() => {
                  app.newSession(app.activeCwd);
                  setCreateOpen(false);
                })
              }
            >
              {app.activeCwd}
            </button>
          ) : null}
          {app.projects.map((project) => (
            <details key={project.id ?? project.path} open={project.id === app.activeProjectId}>
              <summary>{project.name}</summary>
              {(project.roots?.length
                ? project.roots
                : [
                    {
                      id: project.primaryRootId ?? "",
                      name: project.name,
                      path: project.path,
                      role: "primary",
                    },
                  ]
              ).map((root) => (
                <button
                  className="session"
                  key={root.id || root.path}
                  title={root.path}
                  onClick={() =>
                    navigation.conversation(() => {
                      app.newSession(
                        project.id
                          ? { projectId: project.id, ...(root.id ? { rootId: root.id } : {}) }
                          : root.path,
                        project.name,
                      );
                      setCreateOpen(false);
                    })
                  }
                >
                  <span className="session-title">
                    {root.name} · {root.role === "primary" ? "主目录" : "附加目录"}
                  </span>
                  <span className="session-meta">{root.path}</span>
                </button>
              ))}
            </details>
          ))}
        </div>
      ) : null}
      <details className="desktop-cli-sessions">
        <summary>CLI 会话</summary>
        {cwd ? (
          <p className="desktop-cli-path" title={cwd}>
            发现目录：{cwd}
          </p>
        ) : null}
        <div className="desktop-sidebar-actions">
          {(["claude-code", "codex"] as const).map((kind) => (
            <button
              className="library-button"
              key={kind}
              aria-pressed={app.ccCliKind === kind}
              onClick={() => app.setCcCliKind(kind)}
            >
              {kind === "codex" ? "Codex" : "Claude Code"}
            </button>
          ))}
        </div>
        {!cwd ? (
          <p className="empty">先选择项目，再打开 CLI 会话。</p>
        ) : !app.ccProbe ? (
          <p className="empty">正在检测 CLI…</p>
        ) : !app.ccProbe.available ? (
          <p className="empty">{app.ccProbe.reason || "这台桌面主机尚未安装所选 CLI。"}</p>
        ) : app.loading.ccSessions && !app.ccSessions.length ? (
          <p className="empty">正在读取会话…</p>
        ) : !app.ccSessions.length ? (
          <p className="empty">当前项目没有可打开的 CLI 会话。</p>
        ) : (
          app.ccSessions.map((session) => (
            <button
              className="session"
              key={session.sessionId}
              onClick={() =>
                setPicking({
                  id: session.sessionId,
                  cwd: session.cwd || cwd,
                  label: session.firstMessage || session.sessionId,
                })
              }
            >
              <span className="session-title">{session.firstMessage || session.sessionId}</span>
              <span className="session-meta">{session.messageCount} 条消息</span>
            </button>
          ))
        )}
      </details>
      {picking ? (
        <CcModeDialog
          title={picking.label}
          onClose={() => setPicking(null)}
          onChoose={(mode) => {
            const selected = picking;
            setPicking(null);
            navigation.conversation(() => app.openCcSession(selected.id, selected.cwd, mode));
          }}
        />
      ) : null}
    </div>
  );
}

function CcModeDialog({
  title,
  onChoose,
  onClose,
}: {
  title: string;
  onChoose: (mode: MobileRemotePermissionMode) => void;
  onClose: () => void;
}) {
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
      className="navigation-prompt desktop-cli-mode"
      ref={dialog}
      aria-labelledby="desktop-cli-mode-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="desktop-cli-mode-title">选择 CLI 权限模式</h2>
      <p>{title}</p>
      <div className="desktop-mode-options">
        {permissionModes.map((mode) => (
          <button key={mode.value} className="library-button" onClick={() => onChoose(mode.value)}>
            <strong>{mode.label}</strong>
            <span>{mode.description}</span>
          </button>
        ))}
      </div>
      <button className="library-button" onClick={onClose} autoFocus>
        取消
      </button>
    </dialog>
  );
}

export function DesktopApproval({ approval, app }: { approval: PendingApproval; app: RemoteApp }) {
  const [scope, setScope] = React.useState<ApprovalScope>("once");
  const [pathScope, setPathScope] = React.useState<ApprovalPathScope>("tool");
  const [answer, setAnswer] = React.useState("");
  const isAsk =
    Boolean(approval.options?.length) ||
    approval.toolName === "__ask_user__" ||
    approval.toolName === "AskUserQuestion";
  const respond = (approved: boolean, selectedAnswer?: string) => {
    if (app.status !== "online") return;
    if (approval.roomId)
      app.respondCcApproval(
        approval.roomId,
        approval.requestId,
        approved
          ? {
              behavior: "allow",
              updatedInput: {},
              ...(selectedAnswer ? { answer: selectedAnswer } : {}),
            }
          : { behavior: "deny", message: "denied by user" },
      );
    else
      app.respondApproval(
        approval.requestId,
        approved ? "approve" : "reject",
        isAsk
          ? { answer: selectedAnswer }
          : { scope, pathScope: approval.pathScoped ? pathScope : undefined },
      );
  };
  return (
    <div className="approval">
      <div className="approval-title">
        {isAsk ? "Agent 提问" : `工具审批：${approval.toolName}`}
        <em> · {approval.risk}</em>
      </div>
      {approval.description ? <div className="approval-desc">{approval.description}</div> : null}
      <div className="approval-summary">{approval.summary}</div>
      {isAsk ? (
        <>
          <div className="desktop-ask-options">
            {approval.options?.map((option, index) => (
              <button
                className="library-button"
                key={`${option}:${index}`}
                disabled={app.status !== "online"}
                onClick={() => respond(true, option)}
              >
                {index + 1}. {option}
              </button>
            ))}
          </div>
          {!approval.optionsOnly ? (
            <>
              <textarea
                className="approval-answer"
                aria-label="自定义回答"
                placeholder="输入回答…"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
              <button
                className="send"
                disabled={!answer.trim() || app.status !== "online"}
                onClick={() => respond(true, answer.trim())}
              >
                回答
              </button>
            </>
          ) : null}
        </>
      ) : (
        <div className="desktop-approval-scope">
          <label>
            授权范围
            <select
              aria-label="授权范围"
              value={scope}
              onChange={(event) => setScope(event.target.value as ApprovalScope)}
            >
              <option value="once">仅本次</option>
              <option value="session">本会话</option>
              <option value="project">本项目</option>
            </select>
          </label>
          {approval.pathScoped && scope !== "once" ? (
            <label>
              文件范围
              <select
                aria-label="文件范围"
                value={pathScope}
                onChange={(event) => setPathScope(event.target.value as ApprovalPathScope)}
              >
                <option value="file">当前文件</option>
                <option value="dir">所在目录</option>
                <option value="tool">此工具</option>
              </select>
            </label>
          ) : null}
        </div>
      )}
      <div className="approval-actions">
        {!isAsk ? (
          <button className="send" disabled={app.status !== "online"} onClick={() => respond(true)}>
            允许
          </button>
        ) : null}
        <button className="stop" disabled={app.status !== "online"} onClick={() => respond(false)}>
          拒绝
        </button>
      </div>
    </div>
  );
}
