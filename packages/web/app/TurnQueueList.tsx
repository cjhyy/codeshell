import React from "react";
import type { MobileTurnQueueEntry } from "@cjhyy/code-shell-core";
import type { WorkbenchTurnQueue } from "./workbench-types.js";
import "./turn-queue.css";

const PERMISSION_LABELS: Record<string, string> = {
  default: "逐次确认",
  acceptEdits: "允许编辑",
  bypassPermissions: "跳过确认",
};
const COLLAPSED_LIMIT = 1;

function statusLabel(entry: MobileTurnQueueEntry, index: number, paused: boolean): string {
  switch (entry.status) {
    case "dispatching":
      return "正在提交…";
    case "waiting":
      return "等待中";
    case "failed":
      return "未执行";
    case "uncertain":
      return "无法确认是否已执行";
    default:
      return paused ? "已暂停" : index === 0 ? "下一条" : `第 ${index + 1} 条`;
  }
}

function pausedNote(paused: NonNullable<WorkbenchTurnQueue["state"]>["paused"]): string {
  switch (paused) {
    case "stopped":
      return "已停止当前任务，排队消息暂停，确认后再继续。";
    case "failed":
      return "有消息被拒绝、没有执行，其余消息已暂停。可重试或移除。";
    case "uncertain":
      return "有消息无法确认是否已执行，其余消息已暂停。请核对记录后移除它，不会自动重发。";
    default:
      return "当前任务结束后按顺序执行，不会打断正在运行的任务。";
  }
}

/**
 * Host-authoritative pending turns above the composer. Each row can be
 * withdrawn until the Host starts submitting it; stopping the current turn is
 * a separate control in the composer.
 */
export function TurnQueueList({ queue }: { queue: WorkbenchTurnQueue }) {
  const entries = queue.state?.entries ?? [];
  const paused = queue.state?.paused;
  // A confirmation belongs to one conversation in one Host lifetime: switching
  // conversations or a Host restart always needs a fresh confirmation.
  const scope = queue.state ? JSON.stringify([queue.state.target, queue.state.epoch]) : "";
  const [expandedScope, setExpandedScope] = React.useState<string>();
  const [confirmScope, setConfirmScope] = React.useState<string>();
  const expanded = expandedScope === scope && entries.length > COLLAPSED_LIMIT;
  const confirmClear = confirmScope === scope;
  React.useEffect(() => {
    if (!confirmScope) return;
    const timer = setTimeout(() => setConfirmScope(undefined), 4000);
    return () => clearTimeout(timer);
  }, [confirmScope]);
  if (!entries.length) return null;
  const visible = expanded ? entries : entries.slice(0, COLLAPSED_LIMIT);
  const hidden = entries.length - visible.length;
  const removable = entries.filter((entry) => entry.status !== "dispatching").length;
  const resumable = paused === "stopped" || paused === "failed";
  return (
    <section
      className={`turn-queue${paused ? " is-paused" : ""}`}
      aria-label={`待执行消息，共 ${entries.length} 条`}
    >
      <header className="turn-queue-head">
        <span className="turn-queue-title">
          待执行 <span className="turn-queue-count">{entries.length}</span>
        </span>
        <span className="turn-queue-note" role="status">
          {pausedNote(paused)}
        </span>
        <span className="turn-queue-actions">
          {resumable ? (
            <button
              type="button"
              className="turn-queue-action primary"
              disabled={!queue.online}
              onClick={queue.resume}
            >
              {paused === "failed" ? "重试并继续" : "继续执行"}
            </button>
          ) : null}
          {removable > 1 ? (
            <button
              type="button"
              className={`turn-queue-action${confirmClear ? " danger" : ""}`}
              disabled={!queue.online}
              onClick={() => {
                if (!confirmClear) {
                  setConfirmScope(scope);
                  return;
                }
                setConfirmScope(undefined);
                queue.clear();
              }}
            >
              {confirmClear ? `确认清空 ${removable} 条` : "全部取消"}
            </button>
          ) : null}
        </span>
      </header>
      <ol className="turn-queue-list">
        {visible.map((entry, index) => {
          const permission =
            entry.permissionMode &&
            queue.currentPermissionMode &&
            entry.permissionMode !== queue.currentPermissionMode
              ? PERMISSION_LABELS[entry.permissionMode]
              : undefined;
          const meta = [
            statusLabel(entry, index, Boolean(paused)),
            entry.attachments.length ? `${entry.attachments.length} 张图片` : "",
            entry.ownDevice ? "" : "来自其他设备",
            permission ? `按「${permission}」执行` : "",
          ].filter(Boolean);
          return (
            <li key={entry.id} className={`turn-queue-item status-${entry.status}`}>
              <span className="turn-queue-index" aria-hidden="true">
                {index + 1}
              </span>
              <div className="turn-queue-body">
                <p className="turn-queue-text" title={entry.text}>
                  {entry.text || "（仅图片）"}
                </p>
                <span className="turn-queue-meta">{meta.join(" · ")}</span>
                {entry.message ? (
                  <span
                    className="turn-queue-message"
                    role={
                      entry.status === "failed" || entry.status === "uncertain"
                        ? "alert"
                        : undefined
                    }
                  >
                    {entry.message}
                  </span>
                ) : null}
              </div>
              <span className="turn-queue-item-actions">
                {entry.status === "failed" ? (
                  <button
                    type="button"
                    className="turn-queue-action"
                    disabled={!queue.online}
                    onClick={() => queue.retry(entry.id)}
                  >
                    重试
                  </button>
                ) : null}
                <button
                  type="button"
                  className="turn-queue-remove"
                  aria-label={`取消第 ${index + 1} 条排队消息`}
                  title={entry.status === "dispatching" ? "正在提交，无法取消" : "取消这条消息"}
                  disabled={entry.status === "dispatching" || !queue.online}
                  onClick={() => queue.cancel(entry.id)}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path
                      d="M6 6l12 12M18 6 6 18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      {hidden > 0 || expanded ? (
        <button
          type="button"
          className="turn-queue-more"
          aria-expanded={expanded}
          onClick={() => setExpandedScope(expanded ? undefined : scope)}
        >
          {expanded ? "收起" : `展开其余 ${hidden} 条`}
        </button>
      ) : null}
    </section>
  );
}
