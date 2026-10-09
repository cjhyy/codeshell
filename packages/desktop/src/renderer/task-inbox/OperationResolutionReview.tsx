import React, { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import type { OperationResolutionReview as Review } from "../../shared/operation-resolution.js";

/** Existing activity Session detail, loaded only on an explicit user request. */
export function OperationResolutionReview({ sessionId }: { sessionId: string }) {
  const { lang } = useT();
  const zh = lang === "zh";
  const [review, setReview] = useState<Review | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const load = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setOpen(true);
    setError(null);
    try {
      setReview(await window.codeshell.operationResolution.review(sessionId));
    } catch {
      setError(
        zh
          ? "无法读取。请停止会话，确认项目仍受信任后重试。"
          : "Unavailable. Stop the Session and check project trust before retrying.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const resolve = async (operationId: string, revision: string) => {
    if (!review || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    let committed = false;
    try {
      const result = await window.codeshell.operationResolution.resolve({
        reviewToken: review.reviewToken,
        operationId,
        revision,
      });
      committed = result.status === "resolved";
      setReview(await window.codeshell.operationResolution.review(sessionId));
    } catch {
      // A consumed/stale native capability is never reused. Refresh explicitly.
      setReview(null);
      setError(
        committed
          ? zh
            ? "已人工接受未知结果；结果仍未知。刷新失败，请刷新记录查看。"
            : "Uncertainty was accepted; the result remains unknown. Refresh failed; refresh records to view the decision."
          : zh
            ? "无法确认处理结果，请刷新记录后核对。"
            : "The decision could not be confirmed. Refresh the record to check its status.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="space-y-2 border-t border-border/60 pt-2"
      aria-label={zh ? "外部写入人工处理" : "Uncertain external writes"}
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void load())}
      >
        {zh ? "外部写入人工处理" : "Review uncertain external writes"}
      </Button>
      {open && (
        <div className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            {zh
              ? "原操作结果仍未知。人工处理只允许后续全新操作，不会重发或把原任务标为成功。"
              : "The original result remains unknown. A manual decision allows new intents; it never resends or marks the original task successful."}
          </p>
          {busy && (
            <p role="status">
              {zh ? "正在读取或等待原生确认…" : "Loading or waiting for native confirmation…"}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {!busy && !review && (
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
              {zh ? "刷新记录" : "Refresh records"}
            </Button>
          )}
          {review?.records.length === 0 && (
            <p>{zh ? "没有需要人工处理的已发送写入。" : "No sent writes require manual review."}</p>
          )}
          {review?.records.map((record) => (
            <div key={record.id} className="space-y-1 rounded-lg border border-border p-2">
              <p>
                {record.service} / {record.action} ·{" "}
                {new Date(record.createdAt).toLocaleString(zh ? "zh-CN" : "en-US")}
              </p>
              <p>
                {record.resolvedAt
                  ? zh
                    ? "已人工接受未知结果；结果仍未知"
                    : "Uncertainty accepted manually; result remains unknown"
                  : zh
                    ? "结果仍未知"
                    : "Result remains unknown"}
              </p>
              {!record.hasReference && (
                <p className="text-muted-foreground">
                  {zh
                    ? "缺少原始引用，需自行在服务商处核查。"
                    : "No original reference. Review at the provider yourself."}
                </p>
              )}
              {record.canResolve && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void resolve(record.id, record.revision)}
                >
                  {zh ? "人工核查后处理…" : "Accept after manual review…"}
                </Button>
              )}
              {!record.canResolve && !record.resolvedAt && (
                <p>
                  {zh
                    ? "无法证明历史记录归属，或操作尚未结束；保留阻断。"
                    : "Ownership is unproven or the operation is still pending; the barrier remains."}
                </p>
              )}
            </div>
          ))}
          {review?.truncated && (
            <p>
              {zh
                ? "只显示前 50 项，处理后刷新可继续查看。"
                : "Showing 50 records. Resolve and refresh to continue."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
