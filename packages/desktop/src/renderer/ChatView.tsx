import React, { useEffect, useRef, useState } from "react";
import { Paperclip, Mic, ArrowUp, Square } from "lucide-react";
import { MessageStream } from "./MessageStream";
import type { Message, ToolMessage } from "./types";
import { loadHistory, pushHistory } from "./promptHistory";
import { PermissionPill, type PermissionMode } from "./chat/PermissionPill";
import { ModelPill, type ModelOption } from "./chat/ModelPill";
import { ContextRing } from "./chat/ContextRing";

interface Props {
  messages: Message[];
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  activeRepoId: string | null;
  selectedToolId?: string | null;
  onSelectTool?: (m: ToolMessage) => void;

  // Composer controls
  permissionMode: PermissionMode | null;
  onPermissionChange: (m: PermissionMode) => void;
  modelOptions: ModelOption[];
  activeModel: { provider: string; model: string } | null;
  onModelChange: (opt: ModelOption) => void;
  contextTokens: number;
}

const MAX_TEXTAREA_PX = 200;

export function ChatView({
  messages,
  onSend,
  onStop,
  busy,
  activeRepoId,
  selectedToolId,
  onSelectTool,
  permissionMode,
  onPermissionChange,
  modelOptions,
  activeModel,
  onModelChange,
  contextTokens,
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

  const disabled = busy || activeRepoId === null;
  const placeholder =
    activeRepoId === null
      ? "先在左侧添加一个项目"
      : busy
        ? "agent is working… (Stop 中止)"
        : "要求或描述变更…";

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

  return (
    <div className="chat">
      <MessageStream
        messages={messages}
        selectedToolId={selectedToolId ?? null}
        onSelectTool={onSelectTool}
      />

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
            disabled={activeRepoId === null}
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
            <ContextRing used={contextTokens} />
            <ModelPill
              active={activeModel}
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
    </div>
  );
}
