import React from "react";
import type { ApprovalRequestPayload } from "./protocol.js";
import { summarizeApproval } from "../src/lib/riskClassify.js";
export function HubApprovalCard({
  payload,
  onDecide,
  busy,
  connected,
}: {
  payload: ApprovalRequestPayload;
  busy: boolean;
  connected: boolean;
  onDecide: (payload: ApprovalRequestPayload, approved: boolean, answer?: string) => void;
}) {
  const [answer, setAnswer] = React.useState("");
  const isAskUser = payload.request.toolName === "__ask_user__";
  const { summary, risk } = summarizeApproval(
    payload.request.args,
    payload.request.riskLevel,
    payload.request.toolName,
  );
  return (
    <div className="approval">
      <div className="approval-title">
        {isAskUser ? "Agent 提问" : `工具审批：${payload.request.toolName}`}
        {!isAskUser ? <em> · {risk}</em> : null}
      </div>
      {payload.request.description ? (
        <div className="approval-desc">{payload.request.description}</div>
      ) : null}
      {!isAskUser ? (
        <>
          <div className="approval-summary">{summary}</div>
          <details className="approval-raw">
            <summary>原始参数</summary>
            <pre className="approval-args">{JSON.stringify(payload.request.args, null, 2)}</pre>
          </details>
        </>
      ) : null}
      {isAskUser ? (
        <textarea
          className="approval-answer"
          value={answer}
          placeholder="输入回答…"
          onChange={(e) => setAnswer(e.target.value)}
        />
      ) : null}
      {busy ? (
        <span className="muted" role="status">
          设备正在处理此审批…
        </span>
      ) : null}
      <div className="approval-actions">
        <button
          className="send"
          disabled={busy || !connected || (isAskUser && !answer.trim())}
          onClick={() => onDecide(payload, true, isAskUser ? answer : undefined)}
        >
          {isAskUser ? "回答" : "允许"}
        </button>
        <button
          className="stop"
          disabled={busy || !connected}
          onClick={() => onDecide(payload, false)}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
