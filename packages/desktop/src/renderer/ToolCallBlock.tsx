import React from "react";
import type { Message } from "./types";

export function ToolCallBlock({ message }: { message: Extract<Message, { kind: "tool" }> }) {
  return (
    <div className="msg msg-tool">
      <div className="msg-tool-head">
        <span className="msg-tool-name">⚙ {message.toolName}</span>
        {message.result === undefined && !message.error && <span className="msg-tool-spin">running…</span>}
      </div>
      <pre className="msg-tool-args">{message.args}</pre>
      {(message.result !== undefined || message.error !== undefined) && (
        <pre className={message.error ? "msg-tool-err" : "msg-tool-out"}>
          {message.error ?? message.result}
        </pre>
      )}
    </div>
  );
}
