import React from "react";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import { ApprovalCard } from "./ApprovalCard";

interface Props {
  queue: ApprovalRequestEnvelope[];
  history: { decision: "approve" | "deny"; envelope: ApprovalRequestEnvelope; reason?: string; at: number }[];
  onDecide: (env: ApprovalRequestEnvelope, decision: "approve" | "deny", reason?: string) => void;
}

export function ApprovalsView({ queue, history, onDecide }: Props) {
  return (
    <div className="approvals-view">
      <section>
        <h2 className="approvals-section-title">
          待批准 <span className="approvals-count">{queue.length}</span>
        </h2>
        {queue.length === 0 ? (
          <div className="approvals-empty">没有待处理的工具调用</div>
        ) : (
          <div className="approvals-queue">
            {queue.map((env) => (
              <ApprovalCard
                key={env.requestId}
                envelope={env}
                onDecide={(d, r) => onDecide(env, d, r)}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="approvals-section-title">
          历史 <span className="approvals-count">{history.length}</span>
        </h2>
        {history.length === 0 ? (
          <div className="approvals-empty">暂无记录</div>
        ) : (
          <ul className="approvals-history">
            {history.slice().reverse().slice(0, 50).map((h, i) => (
              <li key={i} className={`approval-history-row decision-${h.decision}`}>
                <span className="approval-history-decision">{h.decision}</span>
                <span className="approval-history-tool">{h.envelope.request.toolName}</span>
                <span className="approval-history-summary">
                  {summarize(h.envelope)}
                </span>
                {h.reason && <span className="approval-history-reason">— {h.reason}</span>}
                <span className="approval-history-when">{formatTime(h.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function summarize(env: ApprovalRequestEnvelope): string {
  const args = (env.request.args ?? {}) as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "url", "pattern", "query"] as const) {
    const v = args[k];
    if (typeof v === "string") return v.length > 80 ? v.slice(0, 79) + "…" : v;
  }
  return env.request.toolName;
}

function formatTime(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString();
}
