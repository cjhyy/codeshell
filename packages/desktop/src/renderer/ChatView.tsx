import React, { useEffect, useRef, useState } from "react";
import { Paperclip, Mic, ArrowUp, Square, Monitor } from "lucide-react";
import { MessageStream } from "./MessageStream";
import type { Message } from "./types";
import { loadHistory, pushHistory } from "./promptHistory";
import { PermissionPill, type PermissionMode } from "./chat/PermissionPill";
import { ModelPill, type ModelOption } from "./chat/ModelPill";
import { ContextRing } from "./chat/ContextRing";
import { ProjectPicker } from "./chat/ProjectPicker";
import { BranchPicker } from "./chat/BranchPicker";
import { TaskListMessageView } from "./messages/TaskListMessageView";
import { AskUserMessageView } from "./messages/AskUserMessageView";
import { ApprovalCard } from "./approvals/ApprovalCard";
import type { TaskListMessage, AskUserMessage } from "./types";
import type { Repo } from "./repos";
import type { ApprovalRequestEnvelope } from "../preload/types";

interface Props {
  messages: Message[];
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  activeRepoId: string | null;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (decision: "approve" | "deny", reason?: string) => void;

  // Composer controls
  permissionMode: PermissionMode | null;
  onPermissionChange: (m: PermissionMode) => void;
  modelOptions: ModelOption[];
  activeModelKey: string | null;
  onModelChange: (opt: ModelOption) => void;
  contextTokens: number;
  contextMax?: number;

  // Project picker (composer second row)
  repos: Repo[];
  onSelectRepo: (id: string | null) => void;
  onAddRepo: () => void;
  activeRepoPath: string | null;
  repoClean?: boolean | null;

  // Title shown above the composer in new-chat mode (empty stream)
  welcomeNode?: React.ReactNode;
}

const MAX_TEXTAREA_PX = 200;

export function ChatView({
  messages,
  onSend,
  onStop,
  busy,
  activeRepoId,
  onAskUserAnswer,
  pendingApproval,
  onApprovalDecide,
  permissionMode,
  onPermissionChange,
  modelOptions,
  activeModelKey,
  onModelChange,
  contextTokens,
  contextMax,
  repos,
  onSelectRepo,
  onAddRepo,
  activeRepoPath,
  repoClean,
  welcomeNode,
}: Props) {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>(() => loadHistory(activeRepoId));
  const [historyCursor, setHistoryCursor] = useState(-1);
  const liveDraftStash = useRef<string>("");
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setHistory(loadHistory(activeRepoId));
    setHistoryCursor(-1);
    liveDraftStash.current = "";
  }, [activeRepoId]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, MAX_TEXTAREA_PX);
    ta.style.height = next + "px";
  }, [draft]);

  // No-repo conversations are legitimate now (see ProjectPicker's
  // "不使用项目" option). Only `busy` truly blocks input.
  const disabled = busy;
  const placeholder = busy
    ? "agent is working… (Stop 中止)"
    : "可向 agent 询问任何事。输入 @ 使用插件或提及文件";

  const submit = (): void => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setHistory(pushHistory(activeRepoId, text));
    setDraft("");
    setHistoryCursor(-1);
    liveDraftStash.current = "";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isComposing || e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      submit();
      return;
    }

    const browsingHistory = historyCursor !== -1;
    const canEnterHistory =
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      (draft.length === 0 || browsingHistory);

    if (!canEnterHistory) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      if (!browsingHistory) liveDraftStash.current = draft;
      const next = Math.min(historyCursor + 1, history.length - 1);
      setHistoryCursor(next);
      setDraft(history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!browsingHistory) return;
      const next = historyCursor - 1;
      if (next < 0) {
        setHistoryCursor(-1);
        setDraft(liveDraftStash.current);
      } else {
        setHistoryCursor(next);
        setDraft(history[next]);
      }
    }
  };

  // Pin the latest TaskList and any unanswered AskUser above the
  // composer so they stay visible as new chat messages roll in.
  // We scan from the tail because the latest emission is the source
  // of truth (TaskList replaces in place; AskUser is one at a time).
  let latestTasks: TaskListMessage | null = null;
  let openAsk: AskUserMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!latestTasks && m.kind === "task_list") latestTasks = m;
    if (!openAsk && m.kind === "ask_user" && m.answer === undefined) openAsk = m;
    if (latestTasks && openAsk) break;
  }

  const isNewChat = messages.length === 0;

  // Codex-style inline approvals: when an approval is pending, drop
  // the full ApprovalCard at the tail of the chat stream so it scrolls
  // with the conversation. A compact sticky bar appears above the
  // composer only when the inline card scrolls out of the viewport.
  const inlineApprovalRef = useRef<HTMLDivElement>(null);
  const [inlineApprovalVisible, setInlineApprovalVisible] = useState(true);
  useEffect(() => {
    if (!pendingApproval) { setInlineApprovalVisible(true); return; }
    const el = inlineApprovalRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInlineApprovalVisible(entry.isIntersecting),
      { root: el.closest(".stream") ?? undefined, threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pendingApproval?.requestId]);

  const inlineApproval =
    pendingApproval && onApprovalDecide ? (
      <div
        ref={inlineApprovalRef}
        className="approval-card-inline-anchor"
        data-request-id={pendingApproval.requestId}
      >
        <ApprovalCard envelope={pendingApproval} onDecide={onApprovalDecide} />
      </div>
    ) : null;

  const showStickyApproval =
    !!pendingApproval && !!onApprovalDecide && !inlineApprovalVisible;

  return (
    <div className="chat" data-mode={isNewChat ? "new" : "active"}>
      <MessageStream
        messages={messages}
        onAskUserAnswer={onAskUserAnswer}
        trailing={inlineApproval}
        trailingKey={pendingApproval?.requestId ?? null}
      />

      {(latestTasks || openAsk || showStickyApproval) && (
        <div className="pinned-above-composer">
          {latestTasks && <TaskListMessageView message={latestTasks} />}
          {openAsk && (
            <AskUserMessageView
              message={openAsk}
              onAnswer={onAskUserAnswer ?? (() => undefined)}
            />
          )}
          {showStickyApproval && pendingApproval && onApprovalDecide && (
            <ApprovalCard envelope={pendingApproval} onDecide={onApprovalDecide} />
          )}
        </div>
      )}

      {isNewChat && welcomeNode}

      <div className="composer-shell">
        <div className="composer">
          <div className="composer-textarea-wrap">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (historyCursor !== -1) setHistoryCursor(-1);
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              placeholder={placeholder}
              disabled={busy}
              rows={1}
            />
          </div>

          <div className="composer-controls">
            <div className="composer-controls-left">
              <button
                type="button"
                className="composer-icon-btn"
                aria-label="添加附件"
                title="添加附件 (尚未实现)"
                disabled
              >
                <Paperclip size={14} />
              </button>
              <PermissionPill
                value={permissionMode}
                onChange={onPermissionChange}
                disabled={disabled}
              />
            </div>

            <div className="composer-controls-right">
              <ContextRing used={contextTokens} max={contextMax} busy={busy} />
              <ModelPill
                activeKey={activeModelKey}
                options={modelOptions}
                onSelect={onModelChange}
                disabled={busy}
              />
              <button
                type="button"
                className="composer-icon-btn"
                aria-label="语音输入"
                title="语音输入 (尚未实现)"
                disabled
              >
                <Mic size={14} />
              </button>
              {busy ? (
                <button
                  type="button"
                  className="composer-send composer-send-stop"
                  onClick={onStop}
                  aria-label="停止"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  className="composer-send"
                  onClick={submit}
                  disabled={disabled || !draft.trim()}
                  aria-label="发送"
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Project picker only appears for fresh conversations — once
            the session has any messages, switching project mid-chat
            would be confusing (cwd / context / engine sessionId are
            already tied to the existing repo). Use the sidebar to
            jump projects after a session has started. */}
        {isNewChat && (
          <div className="composer-context-dock">
            <ProjectPicker
              repos={repos}
              activeRepoId={activeRepoId}
              onSelect={onSelectRepo}
              onAddRepo={onAddRepo}
              disabled={busy}
            />
            <span className="composer-context-pill" title="在本机当前工作区运行">
              <Monitor size={12} />
              <span>本地模式</span>
            </span>
            <BranchPicker cwd={activeRepoPath} clean={repoClean} disabled={busy} />
          </div>
        )}
      </div>
    </div>
  );
}
