import React from "react";
import type {
  MobileRemotePermissionMode,
  ApprovalScope,
  ApprovalPathScope,
} from "@cjhyy/code-shell-core";
import type { RemoteApp, PendingApproval } from "../src/hooks/useRemoteApp.js";
import type { WorkbenchNavigation } from "./workbench-types.js";
import { autoResolveText, useNow } from "./deadline.js";
import { relativeTime } from "../src/lib/format.js";
import { cliSessionControlBlock } from "./cliSessionControls.js";
import { ModelChoicePicker } from "./ModelChoicePicker.js";

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
    description: "自动批准工具操作；Codex 会同时关闭沙箱。电脑可能要求再次批准。",
  },
];

function permissionsFor(kind?: string): typeof permissionModes {
  if (kind !== "codex") return permissionModes;
  return [
    {
      value: "default",
      label: "只读",
      description: "可以读取文件；文件写入和修改命令受沙箱限制。",
    },
    {
      value: "acceptEdits",
      label: "工作区读写",
      description: "允许在当前工作区内修改文件，工作区外写入受沙箱限制。",
    },
    {
      value: "bypassPermissions",
      label: "完全访问",
      description: "关闭沙箱，可执行命令并修改文件，不再逐次确认。电脑可能要求再次批准。",
    },
  ];
}

const permissionLabel = (mode: MobileRemotePermissionMode, kind?: string): string =>
  permissionsFor(kind).find((entry) => entry.value === mode)?.label ?? mode;

/** Explain the user-visible effect before elevated permission is requested. */
export function cliModeSwitchNotice(
  kind: "claude-code" | "codex",
  mode: MobileRemotePermissionMode,
): string {
  const base = `切换为「${permissionLabel(mode, kind)}」，从下一条消息开始生效。`;
  if (mode !== "bypassPermissions") return base;
  return kind === "codex"
    ? `${base}\nCodex 会关闭沙箱，命令执行和文件修改不再逐次确认。电脑可能要求再次批准。`
    : `${base}\nClaude Code 会跳过工具操作确认。电脑可能要求再次批准。`;
}

const NO_PROJECT = "__no_project__";

/** A conversation with no turns yet can still move to another project. */
function DesktopProjectPicker({ app, projectId }: { app: RemoteApp; projectId: string | null }) {
  const choices = [
    { value: NO_PROJECT, label: "无项目", description: "不绑定仓库的对话" },
    ...app.projects.map((project) => ({
      value: project.id ?? project.path,
      label: project.name,
      description: project.path,
    })),
  ];
  const value =
    projectId === null
      ? NO_PROJECT
      : (app.projects.find((project) => project.id === projectId || project.path === projectId)
          ?.id ?? projectId);
  return (
    <ModelChoicePicker
      label="项目"
      className="model-button desktop-new-chat-project"
      closeLabel="关闭项目选择"
      placeholder="选择项目"
      choices={choices}
      value={value}
      disabled={app.status !== "online"}
      onChange={(next) => {
        if (next === value) return;
        if (next === NO_PROJECT) {
          app.newSession({ projectId: null });
          return;
        }
        const project = app.projects.find((item) => (item.id ?? item.path) === next);
        app.newSession(project?.id ? { projectId: project.id } : (project?.path ?? next));
      }}
    />
  );
}

export function DesktopChatControls({
  app,
  busy = false,
  projectId,
}: {
  app: RemoteApp;
  busy?: boolean;
  /** Current workspace project (id or path); null = no project. Enables the picker on a new conversation. */
  projectId?: string | null;
}) {
  const hintId = React.useId();
  const inRoom = Boolean(app.activeRoomId || app.activeRoom);
  const room = app.activeRoom;
  const blocked = inRoom
    ? busy
      ? "正在发送消息，完成后可调整。"
      : cliSessionControlBlock(app)
    : undefined;
  const roomSwitchable = !!room && !!app.setCcRoomPermissionMode && !blocked;
  const activeSession = app.sessions.find((session) => session.id === app.activeSessionId);
  const externalRuntime =
    activeSession?.provider === "codex" || activeSession?.provider === "claude-code";
  const nativeBlocked =
    !!app.outputHistoryFailed || (externalRuntime && app.chat.run === "running");
  const hint = inRoom
    ? blocked ||
      (!app.setCcRoomPermissionMode ? "更新电脑端后可调整权限。" : "切换后从下一条消息开始生效。")
    : externalRuntime
      ? "下次发送生效；运行中变更需先停止。"
      : "下次发送生效。";
  const freshConversation =
    !inRoom &&
    projectId !== undefined &&
    app.chat.items.length === 0 &&
    !app.loading.sessionHistory &&
    app.chat.run !== "running" &&
    !busy;
  return (
    <div className="desktop-chat-controls">
      {freshConversation ? <DesktopProjectPicker app={app} projectId={projectId} /> : null}
      <ModelChoicePicker
        label="权限模式"
        className="model-button desktop-permission-picker"
        searchable={false}
        closeLabel="关闭权限选择"
        placeholder="读取中…"
        choices={permissionsFor(inRoom ? room?.kind : activeSession?.provider)}
        descriptionId={hintId}
        status={hint}
        title={hint}
        value={inRoom ? (room?.permissionMode ?? "") : app.permissionMode}
        disabled={inRoom ? !roomSwitchable : nativeBlocked}
        onChange={(value) => {
          const mode = value as MobileRemotePermissionMode;
          if (inRoom) {
            if (!room || !roomSwitchable || mode === room.permissionMode) return;
            if (
              mode === "bypassPermissions" &&
              !window.confirm(cliModeSwitchNotice(room.kind, mode))
            )
              return;
            app.setCcRoomPermissionMode?.(mode);
            return;
          }
          if (nativeBlocked) return;
          if (
            mode === "bypassPermissions" &&
            app.permissionMode !== mode &&
            !window.confirm("切换后将自动批准工具操作。确定跳过权限确认吗？")
          )
            return;
          app.setPermissionMode(mode);
        }}
      />
      <span
        id={hintId}
        className="desktop-permission-hint"
        role="note"
        aria-live="polite"
        data-blocking={inRoom && !roomSwitchable ? "" : undefined}
      >
        {hint}
      </span>
    </div>
  );
}

export function DesktopCliSessionActions({ app }: { app: RemoteApp }) {
  if (!app.activeRoomId && !app.activeRoom) return null;
  return (
    <div className="desktop-cli-session-actions">
      <button className="library-button" onClick={app.leaveRoom}>
        离开 CLI 会话
      </button>
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
      <div className="desktop-sidebar-actions">
        <button
          className="library-button"
          onClick={() => navigation.conversation(() => app.newSession({ projectId: null }), null)}
        >
          无项目对话
        </button>
        <button
          className="library-button"
          onClick={() => setCreateOpen((value) => !value)}
          aria-expanded={createOpen}
        >
          在项目中新建
        </button>
        <button
          className="library-button"
          disabled={app.loading.sessions}
          onClick={() => app.refreshSessions()}
        >
          刷新
        </button>
      </div>
      {createOpen ? (
        <div className="desktop-root-picker">
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
              className={`session${app.activeRoom?.sessionId === session.sessionId && app.activeRoom.kind === app.ccCliKind ? " active" : ""}`}
              key={session.sessionId}
              aria-current={
                app.activeRoom?.sessionId === session.sessionId &&
                app.activeRoom.kind === app.ccCliKind
                  ? "page"
                  : undefined
              }
              title={session.firstMessage || session.sessionId}
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
              <span className="session-meta desktop-cli-session-meta">
                {session.messageCount !== undefined ? (
                  <span>{session.messageCount} 条消息</span>
                ) : null}
                {Number.isFinite(session.lastModified) ? (
                  <span>{relativeTime(session.lastModified)}</span>
                ) : null}
              </span>
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
          kind={app.ccCliKind}
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
  kind,
  returnFocus,
  onChoose,
  onClose,
}: {
  title: string;
  kind: "codex" | "claude-code";
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
        {permissionsFor(kind).map((mode) => (
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
function QuestionCountdown({
  approval,
  app,
  onKeepWaiting,
  failed,
}: {
  approval: PendingApproval;
  app: RemoteApp;
  onKeepWaiting: () => void;
  failed: boolean;
}) {
  const deadline = approval.keepWaitable ? approval.expiresAt : undefined;
  const now = useNow(deadline);
  if (deadline === undefined || now >= deadline) return null;
  return (
    <div className="approval-deadline approval-countdown">
      <span role="timer">{autoResolveText(deadline - now, approval.recommended)}</span>
      <button className="library-button" disabled={app.status !== "online"} onClick={onKeepWaiting}>
        一直等
      </button>
      {failed ? <span role="alert">没能改为一直等，请重试。</span> : null}
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
  const keptWaiting = React.useRef(false);
  const [keepWaitingFailed, setKeepWaitingFailed] = React.useState(false);
  const keepWaiting = () => {
    if (!approval.keepWaitable || approval.roomId || keptWaiting.current) return;
    keptWaiting.current = true;
    setKeepWaitingFailed(false);
    // A failed attempt must not disable 一直等 for good; the next try resends.
    void app.keepWaitingApproval(approval.requestId).catch(() => {
      keptWaiting.current = false;
      setKeepWaitingFailed(true);
    });
  };
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
        <QuestionCountdown
          approval={approval}
          app={app}
          onKeepWaiting={keepWaiting}
          failed={keepWaitingFailed}
        />
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
                {approval.recommendedOptions?.includes(option) ? "（推荐）" : ""}
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
                  // Codex-style: typing keeps the question open.
                  keepWaiting();
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
