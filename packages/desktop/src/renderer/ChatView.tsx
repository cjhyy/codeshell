import React, { useEffect, useRef, useState } from "react";
import { MessageStream } from "./MessageStream";
import type { Message } from "./types";
import { loadHistory, pushHistory } from "./promptHistory";

interface Props {
  messages: Message[];
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  activeRepoId: string | null;
}

const MAX_TEXTAREA_PX = 200;

export function ChatView({ messages, onSend, onStop, busy, activeRepoId }: Props) {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>(() => loadHistory(activeRepoId));
  /**
   * historyCursor: -1 means "user is typing fresh draft" (`draft` is the
   * live edit). 0..history.length-1 means "user is browsing entry N".
   * When cursor leaves -1 we stash the live draft into `liveDraftStash`
   * so ↓ all the way back can restore it.
   */
  const [historyCursor, setHistoryCursor] = useState(-1);
  const liveDraftStash = useRef<string>("");
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reload history when the active repo changes.
  useEffect(() => {
    setHistory(loadHistory(activeRepoId));
    setHistoryCursor(-1);
    liveDraftStash.current = "";
  }, [activeRepoId]);

  // Auto-grow textarea height.
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

  // Render-time diagnostic so we can see why the textarea is disabled
  // after a repo switch without asking the user to inspect state.
  useEffect(() => {
    window.codeshell.log("chatview.render", {
      busy,
      activeRepoId,
      disabled,
      draftLen: draft.length,
    });
  }, [busy, activeRepoId, disabled, draft.length]);

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
    // IME composing — don't intercept anything. Browser delivers Enter
    // events during composition to confirm the candidate; respecting
    // them is mandatory for Chinese/Japanese/Korean users.
    if (isComposing || e.nativeEvent.isComposing) return;

    // Submit on Enter (without Shift) or Cmd-Enter / Ctrl-Enter.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      submit();
      return;
    }

    // History navigation only when the textarea is empty OR the user is
    // already browsing history. Otherwise ↑/↓ should move the caret
    // inside multi-line text as usual.
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
      <MessageStream messages={messages} />
      <div className="input-row">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            // Editing while browsing history exits browse mode.
            if (historyCursor !== -1) setHistoryCursor(-1);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder={placeholder}
          disabled={activeRepoId === null}
          rows={1}
        />
        {busy ? (
          <button className="stop-btn" onClick={onStop}>Stop</button>
        ) : (
          <button
            className="send-btn primary"
            onClick={submit}
            disabled={disabled || !draft.trim()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
