import React from "react";
import "./SessionLoadingState.css";

/** Presentation only: the controller owns recovery, retry and send admission. */
export function SessionLoadingState({
  label = "正在恢复会话记录…",
  progress,
  retained = false,
  failed = false,
}: {
  label?: string;
  progress?: number;
  retained?: boolean;
  failed?: boolean;
}) {
  // Receiving the final page is not the same as verifying the complete history.
  const percent =
    progress !== undefined && Number.isFinite(progress)
      ? Math.min(99, Math.max(0, Math.floor(progress)))
      : undefined;
  return (
    <div
      className={`session-loading${retained ? " session-loading-retained" : ""}${failed ? " session-loading-failed" : ""}`}
    >
      <div className="session-loading-status" role={failed ? "alert" : "status"} aria-atomic="true">
        <span className="session-loading-indicator" aria-hidden="true">
          {failed ? "!" : null}
        </span>
        <div>
          {!retained && <strong>{failed ? "会话暂未就绪" : "正在加载会话"}</strong>}
          <p>{label}</p>
        </div>
      </div>
      {!failed && percent !== undefined && (
        <div
          className="session-loading-progress"
          role="progressbar"
          aria-label="会话记录恢复进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      {!retained && !failed && (
        <div className="session-loading-skeleton" aria-hidden="true">
          <div className="session-loading-question">
            <span />
            <span />
          </div>
          <div className="session-loading-answer">
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
    </div>
  );
}
