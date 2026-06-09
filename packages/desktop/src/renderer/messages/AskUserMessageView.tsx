import React, { memo, useState } from "react";
import type { AskUserMessage } from "../types";
import { Check } from "lucide-react";

interface Props {
  message: AskUserMessage;
  /** Called with the user's chosen / typed answer string. */
  onAnswer: (requestId: string, answer: string) => void;
}

/**
 * AskUserQuestion rendered inline in the chat stream.
 *
 * Three layouts:
 *   - Resolved (m.answer is set): pill with the answer, no inputs
 *   - Multiple-choice (options given): list of selectable rows + "其它…"
 *     entry that reveals a free-text input
 *   - Free-text (no options): just a text input
 *
 * The answer is always wire-encoded as a single string. For
 * multiSelect we join selected labels with ", ".
 */
function AskUserMessageViewImpl({ message, onAnswer }: Props) {
  const [draft, setDraft] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherDraft, setOtherDraft] = useState("");
  const [picked, setPicked] = useState<Set<number>>(() => new Set());

  if (message.answer !== undefined) {
    return (
      <div className="ask-user ask-user-resolved">
        <div className="ask-user-q">
          {message.header && <span className="ask-user-header">{message.header}</span>}
          <span className="ask-user-question">{message.question}</span>
        </div>
        <div className="ask-user-answer">
          <Check size={12} /> {message.answer}
        </div>
      </div>
    );
  }

  const hasOptions = !!message.options && message.options.length > 0;
  const submit = (val: string): void => {
    const v = val.trim();
    if (!v) return;
    onAnswer(message.requestId, v);
  };

  const submitMulti = (): void => {
    if (picked.size === 0 && !otherDraft.trim()) return;
    const labels = Array.from(picked).map((i) => message.options![i].label);
    const all = otherDraft.trim() ? [...labels, otherDraft.trim()] : labels;
    submit(all.join(", "));
  };

  return (
    <div className="ask-user">
      <div className="ask-user-q">
        {message.header && <span className="ask-user-header">{message.header}</span>}
        <span className="ask-user-question">{message.question}</span>
      </div>

      {hasOptions ? (
        <>
          <ul className="ask-user-options">
            {message.options!.map((o, i) => {
              const isPicked = picked.has(i);
              return (
                <li
                  key={i}
                  className={`ask-user-option${isPicked ? " picked" : ""}`}
                  onClick={() => {
                    if (message.multiSelect) {
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      });
                    } else {
                      submit(o.label);
                    }
                  }}
                >
                  <div className="ask-user-option-row">
                    {message.multiSelect && (
                      <span className={`ask-user-check${isPicked ? " on" : ""}`}>
                        {isPicked ? <Check size={11} /> : null}
                      </span>
                    )}
                    <span className="ask-user-option-label">{o.label}</span>
                  </div>
                  <div className="ask-user-option-desc">{o.description}</div>
                </li>
              );
            })}
            {/* Closed-set prompts (optionsOnly) hide the free-text escape
                hatch: their answer is matched by exact label, so a typed
                answer like "允许" would never match and silently fail. */}
            {!message.optionsOnly && (
              <li
                className={`ask-user-option ask-user-other${otherOpen ? " picked" : ""}`}
                onClick={() => setOtherOpen((o) => !o)}
              >
                <div className="ask-user-option-row">
                  <span className="ask-user-option-label">其它…</span>
                </div>
                <div className="ask-user-option-desc">输入自定义回答</div>
              </li>
            )}
          </ul>
          {(otherOpen || message.multiSelect) && (
            <div className="ask-user-input-row">
              {otherOpen && (
                <input
                  className="ask-user-input"
                  autoFocus
                  placeholder="输入自定义回答…"
                  value={otherDraft}
                  onChange={(e) => setOtherDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !message.multiSelect) {
                      e.preventDefault();
                      submit(otherDraft);
                    }
                  }}
                />
              )}
              {message.multiSelect ? (
                <button
                  className="ask-user-submit"
                  disabled={picked.size === 0 && !otherDraft.trim()}
                  onClick={submitMulti}
                >
                  提交
                </button>
              ) : (
                otherOpen && (
                  <button
                    className="ask-user-submit"
                    disabled={!otherDraft.trim()}
                    onClick={() => submit(otherDraft)}
                  >
                    回答
                  </button>
                )
              )}
            </div>
          )}
        </>
      ) : (
        <div className="ask-user-input-row">
          <input
            className="ask-user-input"
            autoFocus
            placeholder="输入你的回答…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit(draft);
              }
            }}
          />
          <button
            className="ask-user-submit"
            disabled={!draft.trim()}
            onClick={() => submit(draft)}
          >
            回答
          </button>
        </div>
      )}
    </div>
  );
}

export const AskUserMessageView = memo(AskUserMessageViewImpl);
