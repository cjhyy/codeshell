import React, { useState } from "react";
import { MessageStream } from "./MessageStream";
import type { Message } from "./types";

interface Props {
  messages: Message[];
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
}

export function ChatView({ messages, onSend, onStop, busy }: Props) {
  const [draft, setDraft] = useState("");

  const submit = (): void => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="chat">
      <MessageStream messages={messages} />
      <div className="input-row">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={busy ? "agent is working…" : "ask anything (Enter to send, Shift+Enter for newline)"}
          rows={3}
          disabled={busy}
        />
        {busy ? (
          <button onClick={onStop}>Stop</button>
        ) : (
          <button onClick={submit} disabled={!draft.trim()}>Send</button>
        )}
      </div>
    </div>
  );
}
