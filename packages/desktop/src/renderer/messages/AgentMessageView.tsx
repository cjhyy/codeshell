import React from "react";
import type { AgentMessage } from "../types";
import { StatusDot } from "../ui/StatusDot";

export function AgentMessageView({ message }: { message: AgentMessage }) {
  const status = message.error ? "err" : message.done ? "ok" : "running";
  return (
    <div className="msg-row msg-agent">
      <div className="msg-agent-card">
        <div className="msg-agent-head">
          <StatusDot status={status} />
          <span className="msg-agent-name">{message.name ?? "agent"}</span>
          <span className="msg-agent-desc">{message.description}</span>
        </div>
        {message.text && <div className="msg-agent-text">{message.text}</div>}
        {message.error && <div className="msg-agent-err">{message.error}</div>}
      </div>
    </div>
  );
}
