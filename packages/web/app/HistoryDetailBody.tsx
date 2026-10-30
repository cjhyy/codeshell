import React from "react";
import type { HistoryDetail, HistoryDetailLoader } from "./workbench-types.js";

/** Mounted only while a detail is expanded; closing retires late results and releases its body. */
export function HistoryDetailBody({
  reference,
  load,
  reload,
  preview,
  children,
}: {
  reference?: string;
  load?: HistoryDetailLoader;
  reload?: () => void;
  preview?: React.ReactNode;
  children: (detail?: HistoryDetail) => React.ReactNode;
}) {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<
    | { status: "loading" }
    | { status: "ready"; detail: HistoryDetail }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const loader = React.useRef(load);
  loader.current = load;
  React.useEffect(() => {
    if (!reference) return;
    let current = true;
    setState({ status: "loading" });
    void Promise.resolve()
      .then(() => {
        if (!current) return;
        if (!loader.current) throw new Error("当前连接无法读取详情，请重新连接后重试。");
        return loader.current(reference);
      })
      .then(
        (detail) => {
          if (current && detail) setState({ status: "ready", detail });
        },
        (error) => {
          if (current)
            setState({
              status: "error",
              message:
                error instanceof Error ? error.message.slice(0, 500) : "读取详情失败，请重试。",
            });
        },
      );
    return () => {
      current = false;
    };
  }, [reference, attempt]);
  if (!reference) return <>{children()}</>;
  if (state.status === "ready") return <>{children(state.detail)}</>;
  if (state.status === "loading")
    return (
      <>
        {preview}
        <p className="message-detail-status" role="status">
          正在读取详情…
        </p>
      </>
    );
  return (
    <>
      {preview}
      <div className="message-detail-status message-detail-error" role="alert">
        <p>{state.message}</p>
        <button
          type="button"
          className="library-button"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重试读取详情
        </button>
        {reload && (
          <button type="button" className="library-button" onClick={reload}>
            重新载入会话
          </button>
        )}
      </div>
    </>
  );
}
