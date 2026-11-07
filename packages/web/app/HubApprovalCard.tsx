import React from "react";
import type { ApprovalRequestPayload } from "./protocol.js";
import { summarizeApproval } from "../src/lib/riskClassify.js";
import { recommendedAskAnswer, recommendedAskLabels } from "../src/lib/messageMappers.js";
import { autoResolveText, formatRemaining, useNow } from "./deadline.js";

export function HubApprovalCard({
  payload,
  onDecide,
  busy,
  connected,
  hidden,
  onKeepWaiting,
}: {
  payload: ApprovalRequestPayload;
  busy: boolean;
  connected: boolean;
  hidden?: boolean;
  onDecide: (payload: ApprovalRequestPayload, approved: boolean, answer?: string) => void;
  /** Drop a model question's auto-resolve deadline (一直等); rejects on failure. */
  onKeepWaiting?: (payload: ApprovalRequestPayload) => Promise<void>;
}) {
  const [answer, setAnswer] = React.useState("");
  const [selected, setSelected] = React.useState<number[]>([]);
  const isAskUser = payload.request.toolName === "__ask_user__";
  // The host resolves an expired request itself; lock the card at the deadline
  // so a late click can't look like it still counts before that arrives.
  const deadline = typeof payload.expiresAt === "number" ? payload.expiresAt : undefined;
  const now = useNow(deadline);
  const expired = deadline !== undefined && now >= deadline;
  const locked = busy || !connected || expired;
  // Model questions: Skip instead of 拒绝, a recommended default, and 一直等.
  const skippable = isAskUser && payload.request.args.skippable === true;
  const recommended = skippable ? recommendedAskAnswer(payload.request.args) : undefined;
  const recommendedLabels = skippable ? recommendedAskLabels(payload.request.args) : [];
  const countdown =
    isAskUser && payload.request.args.keepWaitable === true && !expired && onKeepWaiting
      ? deadline
      : undefined;
  const keptWaiting = React.useRef(false);
  const keepWaiting = () => {
    if (countdown === undefined || keptWaiting.current || locked) return;
    keptWaiting.current = true;
    // A failed attempt must not disable 一直等 for good; the next try resends.
    void onKeepWaiting?.(payload).catch(() => {
      keptWaiting.current = false;
    });
  };
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
      {countdown !== undefined ? (
        <span className="muted approval-countdown">
          <span role="timer">{autoResolveText(countdown - now, recommended)}</span>
          <button className="library-button" disabled={locked} onClick={keepWaiting}>
            一直等
          </button>
        </span>
      ) : deadline !== undefined ? (
        <span className="muted">
          {expired
            ? `已超时，不能再${isAskUser ? "回答" : "处理"}`
            : `${formatRemaining(deadline - now)} 后${isAskUser ? "未回答将自动跳过" : "未处理将自动拒绝"}`}
        </span>
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
                      disabled={locked}
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
                      <span>
                        {choice.label}
                        {recommendedLabels.includes(choice.label) ? "（推荐）" : ""}
                      </span>
                      {choice.description ? (
                        <span className="approval-option-description">{choice.description}</span>
                      ) : null}
                    </span>
                  </label>
                ) : (
                  <button
                    className="approval-option"
                    key={`${choice.label}:${index}`}
                    disabled={locked}
                    onClick={() => onDecide(payload, true, choice.label)}
                  >
                    <span>
                      {choice.label}
                      {recommendedLabels.includes(choice.label) ? "（推荐）" : ""}
                    </span>
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
              onChange={(e) => {
                keepWaiting();
                setAnswer(e.target.value);
              }}
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
            disabled={locked || (isAskUser && !submittedAnswer)}
            onClick={() => onDecide(payload, true, isAskUser ? submittedAnswer : undefined)}
          >
            {isAskUser ? "回答" : "允许"}
          </button>
        ) : null}
        <button className="stop" disabled={locked} onClick={() => onDecide(payload, false)}>
          {skippable ? "跳过" : "拒绝"}
        </button>
      </div>
    </div>
  );
}
