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
    <div className="flex flex-col gap-6 p-6">
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          待批准 <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{queue.length}</span>
        </h2>
        {queue.length === 0 ? (
          <div className="text-sm text-muted-foreground">没有待处理的工具调用</div>
        ) : (
          <div className="flex flex-col gap-2">
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
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          历史 <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{history.length}</span>
        </h2>
        {history.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无记录</div>
        ) : (
          <ul className="space-y-1">
            {history.slice().reverse().slice(0, 50).map((h, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className={"font-semibold " + (h.decision === "approve" ? "text-status-ok" : "text-status-err")}>
                  {h.decision}
                </span>
                <span className="font-mono text-xs">{h.envelope.request.toolName}</span>
                <span className="flex-1 truncate text-muted-foreground">{summarize(h.envelope)}</span>
                {h.reason && <span className="text-muted-foreground">— {h.reason}</span>}
                <span className="text-xs text-muted-foreground">{formatTime(h.at)}</span>
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
