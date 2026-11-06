import React from "react";
import type {
  MobileRemotePermissionMode,
  ApprovalScope,
  ApprovalPathScope,
} from "@cjhyy/code-shell-core";
import type { RemoteApp, PendingApproval } from "../src/hooks/useRemoteApp.js";
import type { WorkbenchNavigation } from "./workbench-types.js";
import { autoResolveText, useNow } from "./deadline.js";

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
    description:
      "自动批准所有工具操作。不在 Host 可信目录时需在 Host 审批卡中再次批准；Codex 会同时关闭沙箱。",
  },
];

const permissionLabel = (mode: MobileRemotePermissionMode): string =>
  permissionModes.find((entry) => entry.value === mode)?.label ?? mode;

/** What restarting a CLI room under `mode` means, in words a phone user sees. */
export function cliModeSwitchNotice(
  kind: "claude-code" | "codex",
  mode: MobileRemotePermissionMode,
): string {
  const applies =
    kind === "codex"
      ? "Codex 每条消息启动一个新进程，切换后从下一条消息开始生效"
      : "会重启 Claude Code 进程，重启后生效";
  const base = `CLI 的权限模式在进程启动时确定。切换为「${permissionLabel(mode)}」${applies}；有任务运行、排队或审批待处理时 Host 会拒绝切换。`;
  if (mode !== "bypassPermissions") return base;
  return kind === "codex"
    ? `${base}\nCodex 全放行会关闭沙箱，命令和文件写入不再经过确认。不在 Host 可信目录时还需在 Host 审批卡中批准。`
    : `${base}\nClaude Code 全放行会跳过所有工具确认。不在 Host 可信目录时还需在 Host 审批卡中批准。`;
}

export function DesktopChatControls({ app }: { app: RemoteApp }) {
  // A CLI room runs in the mode its process was started with. Show that mode
  // (or none while its metadata loads), never the native session's mode.
  const inRoom = Boolean(app.activeRoomId || app.activeRoom);
  const room = app.activeRoom;
  const pending = app.ccModeRequest?.switching ? app.ccModeRequest : undefined;
  // Pending Host turns were submitted under the current mode; the Host refuses
  // a switch until they ran or were removed.
  const queuedTurns = inRoom ? (app.turnQueue?.entries.length ?? 0) : 0;
  const roomSwitchable =
    !!room &&
    !!app.setCcRoomPermissionMode &&
    !room.observing &&
    !pending &&
    queuedTurns === 0 &&
    app.status === "online";
  const activeSession = app.sessions.find((session) => session.id === app.activeSessionId);
  const externalRuntime =
    activeSession?.provider === "codex" || activeSession?.provider === "claude-code";
  const hint = inRoom
    ? pending
      ? `正在切换为「${permissionLabel(pending.mode)}」，等待 Host 确认…`
      : room?.observing
        ? "只读查看中，接管后才能切换权限模式。"
        : queuedTurns
          ? `有 ${queuedTurns} 条排队消息按当前模式提交，执行完或取消后才能切换权限模式。`
          : room?.kind === "codex"
            ? "切换后从下一条消息启动的 Codex 进程开始生效。"
            : "切换会重启 CLI 进程，重启后生效。"
    : externalRuntime
      ? "下次发送生效；运行中变更需先停止。"
      : "下次发送生效。";
  return (
    <div className="desktop-chat-controls">
      <label>
        <span className="desktop-permission-label">权限模式</span>
        <select
          aria-label="权限模式"
          value={inRoom ? (room?.permissionMode ?? "") : app.permissionMode}
          disabled={inRoom ? !roomSwitchable : app.outputHistoryFailed}
          onChange={(event) => {
            const mode = event.target.value as MobileRemotePermissionMode;
            if (inRoom) {
              if (!room || !roomSwitchable || mode === room.permissionMode) return;
              if (!window.confirm(cliModeSwitchNotice(room.kind, mode))) return;
              app.setCcRoomPermissionMode?.(mode);
              return;
            }
            if (app.outputHistoryFailed) return;
            if (
              mode === "bypassPermissions" &&
              app.permissionMode !== mode &&
              !window.confirm("切换后将自动批准工具操作。确定跳过权限确认吗？")
            )
              return;
            app.setPermissionMode(mode);
          }}
        >
          {inRoom && !room ? <option value="">读取中…</option> : null}
          {permissionModes.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      <span
        className="desktop-permission-hint"
        role="note"
        data-blocking={inRoom && room && !roomSwitchable ? "" : undefined}
      >
        {hint}
      </span>
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
  const [picking, setPicking] = React.useState<{
    id: string;
    cwd: string;
    label: string;
    returnFocus: HTMLButtonElement;
  } | null>(null);
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
            const project = app.projects.find((item) => (item.id ?? item.path) === selected);
            if (selected)
              navigation.guard(() => app.selectProject(selected), project?.path ?? selected);
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
          onClick={() => app.refreshSessions()}
        >
          刷新
        </button>
        {app.sessionsHasMore ? (
          <button
            className="library-button"
            disabled={app.loading.sessions}
            onClick={() => app.loadMoreSessions?.()}
          >
            {app.loading.sessions ? "正在加载…" : "加载更多会话"}
          </button>
        ) : null}
      </div>
      {createOpen ? (
        <div className="desktop-root-picker">
          <button
            className="session"
            onClick={() =>
              navigation.conversation(() => {
                app.newSession({ projectId: null });
                setCreateOpen(false);
              }, null)
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
                }, app.activeCwd)
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
                    }, root.path)
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
              onClick={(event) =>
                setPicking({
                  id: session.sessionId,
                  cwd: session.cwd || cwd,
                  label: session.firstMessage || session.sessionId,
                  returnFocus: event.currentTarget,
                })
              }
            >
              <span className="session-title">{session.firstMessage || session.sessionId}</span>
              <span className="session-meta">{session.messageCount} 条消息</span>
            </button>
          ))
        )}
        {(app.ccSessionsTotal ?? 0) > app.ccSessions.length ? (
          <button
            className="library-button"
            disabled={app.loading.ccSessions}
            onClick={() => app.loadAllCcSessions?.()}
          >
            {app.loading.ccSessions ? "正在读取…" : `查看全部 CLI 会话（${app.ccSessionsTotal}）`}
          </button>
        ) : null}
      </details>
      {picking ? (
        <CcModeDialog
          title={picking.label}
          returnFocus={picking.returnFocus}
          onClose={() => setPicking(null)}
          onChoose={(mode) => {
            const selected = picking;
            setPicking(null);
            navigation.conversation(
              () => app.openCcSession(selected.id, selected.cwd, mode),
              selected.cwd,
            );
          }}
        />
      ) : null}
    </div>
  );
}

function CcModeDialog({
  title,
  returnFocus,
  onChoose,
  onClose,
}: {
  title: string;
  returnFocus: HTMLButtonElement;
  onChoose: (mode: MobileRemotePermissionMode) => void;
  onClose: () => void;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (returnFocus.isConnected && !returnFocus.disabled) returnFocus.focus();
    };
  }, [returnFocus]);
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
  if (approval.roomId && approval.questions && approval.questions.length > 1)
    return <DesktopAskQuestions approval={approval} app={app} />;
  return <DesktopApprovalCard approval={approval} app={app} />;
}

/** A model question's live countdown with 一直等; other requests show a fixed deadline. */
function QuestionCountdown({ approval, app }: { approval: PendingApproval; app: RemoteApp }) {
  const deadline = approval.keepWaitable ? approval.expiresAt : undefined;
  const now = useNow(deadline);
  if (deadline === undefined || now >= deadline) return null;
  return (
    <div className="approval-deadline approval-countdown">
      <span role="timer">{autoResolveText(deadline - now, approval.recommended)}</span>
      <button
        className="library-button"
        disabled={app.status !== "online"}
        onClick={() => app.keepWaitingApproval(approval.requestId)}
      >
        一直等
      </button>
    </div>
  );
}

function ApprovalDeadline({ expiresAt }: { expiresAt?: number }) {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? (
    <p className="approval-deadline">
      请在 {new Date(expiresAt).toLocaleTimeString()} 前确认；超时后需要重新发起。
    </p>
  ) : null;
}

/** A CLI AskUserQuestion request with several questions accepts exactly one
 *  response, so every answer is collected before it is sent. */
function DesktopAskQuestions({ approval, app }: { approval: PendingApproval; app: RemoteApp }) {
  const questions = approval.questions ?? [];
  const [picked, setPicked] = React.useState<string[][]>(() => questions.map(() => []));
  const [free, setFree] = React.useState<string[]>(() => questions.map(() => ""));
  const answers = questions.map((_q, index) => free[index]?.trim() || picked[index]!.join(", "));
  const online = app.status === "online";
  const pick = (index: number, option: string, multiSelect: boolean) =>
    setPicked((all) =>
      all.map((labels, i) =>
        i !== index
          ? labels
          : multiSelect
            ? labels.includes(option)
              ? labels.filter((label) => label !== option)
              : [...labels, option]
            : [option],
      ),
    );
  const respond = (decision: Parameters<RemoteApp["respondCcApproval"]>[2]) => {
    if (online && approval.roomId)
      app.respondCcApproval(approval.roomId, approval.requestId, decision);
  };
  return (
    <div className="approval">
      <div className="approval-title">
        Agent 提问<em> · {approval.risk}</em>
      </div>
      <ApprovalDeadline expiresAt={approval.expiresAt} />
      {questions.map((question, index) => (
        <div key={`${index}:${question.question}`} className="approval-question">
          <div className="approval-summary">
            {question.header ? `${question.header} · ` : ""}
            {question.question}
          </div>
          <div className="desktop-ask-options">
            {question.options.map((option, optionIndex) => (
              <button
                className="library-button"
                key={`${option}:${optionIndex}`}
                aria-pressed={picked[index]!.includes(option)}
                disabled={!online}
                onClick={() => pick(index, option, question.multiSelect)}
              >
                {optionIndex + 1}. {option}
              </button>
            ))}
          </div>
          <textarea
            className="approval-answer"
            aria-label={`自定义回答：${question.question}`}
            placeholder="输入回答…"
            value={free[index]}
            onChange={(event) =>
              setFree((all) => all.map((text, i) => (i === index ? event.target.value : text)))
            }
          />
        </div>
      ))}
      <div className="approval-actions">
        <button
          className="send"
          disabled={!online || !answers.every(Boolean)}
          onClick={() =>
            respond({
              behavior: "allow",
              answers: Object.fromEntries(
                questions.map((q, index) => [q.question, answers[index]!]),
              ),
            })
          }
        >
          提交回答
        </button>
        <button
          className="stop"
          disabled={!online}
          onClick={() => respond({ behavior: "deny", message: "denied by user" })}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

function DesktopApprovalCard({ approval, app }: { approval: PendingApproval; app: RemoteApp }) {
  const [scope, setScope] = React.useState<ApprovalScope>("once");
  const [pathScope, setPathScope] = React.useState<ApprovalPathScope>("tool");
  const [answer, setAnswer] = React.useState("");
  const isAsk =
    Boolean(approval.options?.length) ||
    approval.toolName === "__ask_user__" ||
    approval.toolName === "AskUserQuestion";
  // A Host card for one CLI room mode change: no scope, no reuse.
  const hostModeCard = approval.purpose === "room-permission-mode";
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
      {approval.keepWaitable && !approval.roomId ? (
        <QuestionCountdown approval={approval} app={app} />
      ) : (
        <ApprovalDeadline expiresAt={approval.expiresAt} />
      )}
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
                {approval.recommended === option ? "（推荐）" : ""}
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
                onChange={(event) => {
                  // Codex-style: starting to type keeps the question open.
                  if (!answer && approval.keepWaitable && !approval.roomId)
                    app.keepWaitingApproval(approval.requestId);
                  setAnswer(event.target.value);
                }}
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
      ) : hostModeCard ? (
        <div className="approval-desc">只对这一次切换有效；拒绝或超时会保持当前模式。</div>
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
            {hostModeCard ? "批准全放行" : "允许"}
          </button>
        ) : null}
        <button className="stop" disabled={app.status !== "online"} onClick={() => respond(false)}>
          {hostModeCard ? "保持当前模式" : approval.skippable ? "跳过" : "拒绝"}
        </button>
      </div>
    </div>
  );
}
