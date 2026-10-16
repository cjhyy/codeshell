import React from "react";
import type { ApprovalRequestPayload } from "./protocol.js";
import { summarizeApproval } from "../src/lib/riskClassify.js";
export function HubApprovalCard({
  payload,
  onDecide,
  busy,
  connected,
  hidden,
}: {
  payload: ApprovalRequestPayload;
  busy: boolean;
  connected: boolean;
  hidden?: boolean;
  onDecide: (payload: ApprovalRequestPayload, approved: boolean, answer?: string) => void;
}) {
  const [answer, setAnswer] = React.useState("");
  const [selected, setSelected] = React.useState<number[]>([]);
  const isAskUser = payload.request.toolName === "__ask_user__";
  const choices = (
    Array.isArray(payload.request.args.options) ? payload.request.args.options : []
  ).flatMap((option): { label: string; description?: string }[] => {
    if (typeof option === "string" && option.trim()) return [{ label: option }];
    if (
      option &&
      typeof option === "object" &&
      typeof option.label === "string" &&
      option.label.trim()
    )
      return [
        {
          label: option.label,
          description: typeof option.description === "string" ? option.description : undefined,
        },
      ];
    return [];
  });
  const optionsOnly = choices.length > 0 && payload.request.args.optionsOnly === true;
  const multiSelect = choices.length > 0 && payload.request.args.multiSelect === true;
  const customAnswer = answer.trim() ? `${choices.length ? "Other: " : ""}${answer.trim()}` : "";
  const submittedAnswer = multiSelect
    ? [
        ...choices.filter((_, index) => selected.includes(index)).map((choice) => choice.label),
        ...(!optionsOnly && customAnswer ? [customAnswer] : []),
      ].join(", ")
    : customAnswer;
  const { summary, risk } = summarizeApproval(
    payload.request.args,
    payload.request.riskLevel,
    payload.request.toolName,
  );
  return (
    <div className="approval" hidden={hidden}>
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
        <>
          {payload.request.args.asynchronous === true ? (
            <span className="muted">可以稍后回答，任务会继续处理。</span>
          ) : null}
          {choices.length ? (
            <div className="approval-options" role="group" aria-label="回答选项">
              {choices.map((choice, index) =>
                multiSelect ? (
                  <label className="approval-option" key={`${choice.label}:${index}`}>
                    <input
                      type="checkbox"
                      checked={selected.includes(index)}
                      disabled={busy || !connected}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setSelected((current) =>
                          checked
                            ? [...current, index]
                            : current.filter((value) => value !== index),
                        );
                      }}
                    />
                    <span>
                      <span>{choice.label}</span>
                      {choice.description ? (
                        <span className="approval-option-description">{choice.description}</span>
                      ) : null}
                    </span>
                  </label>
                ) : (
                  <button
                    className="approval-option"
                    key={`${choice.label}:${index}`}
                    disabled={busy || !connected}
                    onClick={() => onDecide(payload, true, choice.label)}
                  >
                    <span>{choice.label}</span>
                    {choice.description ? (
                      <span className="approval-option-description">{choice.description}</span>
                    ) : null}
                  </button>
                ),
              )}
            </div>
          ) : null}
          {!optionsOnly ? (
            <textarea
              className="approval-answer"
              aria-label="自定义回答"
              value={answer}
              placeholder="输入回答…"
              onChange={(e) => setAnswer(e.target.value)}
            />
          ) : null}
        </>
      ) : null}
      {busy ? (
        <span className="muted" role="status">
          设备正在处理此审批…
        </span>
      ) : null}
      <div className="approval-actions">
        {!isAskUser || !optionsOnly || multiSelect ? (
          <button
            className="send"
            disabled={busy || !connected || (isAskUser && !submittedAnswer)}
            onClick={() => onDecide(payload, true, isAskUser ? submittedAnswer : undefined)}
          >
            {isAskUser ? "回答" : "允许"}
          </button>
        ) : null}
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
