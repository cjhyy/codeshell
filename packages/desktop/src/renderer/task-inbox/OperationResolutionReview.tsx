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
  const reconcile = async (operationId: string, revision: string) => {
    if (!review || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    let observed = false;
    try {
      const result = await window.codeshell.operationResolution.reconcile({
        reviewToken: review.reviewToken,
        operationId,
        revision,
      });
      observed = result.status === "observed";
      setReview(await window.codeshell.operationResolution.review(sessionId));
    } catch {
      setReview(null);
      setError(
        observed
          ? zh
            ? "只读观测已保存；刷新失败，请刷新记录查看。原结果仍未知。"
            : "The read observation was saved. Refresh records to view it; the original result remains unknown."
          : zh
            ? "只读核查未确认，请刷新后重试；原结果仍未知。"
            : "The read review could not be confirmed. Refresh and retry; the original result remains unknown.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const observationText = (result: string) => {
    const labels: Record<string, [string, string]> = {
      matches_current: [
        "当前状态匹配；不能证明原写入成功",
        "Current state matches; this does not prove the original write succeeded",
      ],
      differs_current: [
        "当前状态不同；原结果仍未知",
        "Current state differs; the original result remains unknown",
      ],
      identity_changed: [
        "原资源身份不匹配；无法核查",
        "Original resource identity does not match; cannot verify",
      ],
      unavailable: [
        "原始证据不足或读取不可用；仍需人工核查",
        "Original evidence is insufficient or the read is unavailable; manual review is still needed",
      ],
      permission_denied: ["只读核查被当前权限拒绝", "Current permissions denied the read review"],
      hooks_unavailable: [
        "配置的工具 Hook 暂不支持独立核查；未发送读取，请人工核查",
        "Configured tool hooks cannot run in an independent review yet. No read was sent; review manually.",
      ],
    };
    return (
      labels[result]?.[zh ? 0 : 1] ?? (zh ? "原结果仍未知" : "Original result remains unknown")
    );
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
              {record.observation && (
                <p className="text-muted-foreground" role="status">
                  {observationText(record.observation.result)} ·{" "}
                  {new Date(record.observation.at).toLocaleString(zh ? "zh-CN" : "en-US")}
                </p>
              )}
              {record.canResolve && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void reconcile(record.id, record.revision)}
                  >
                    {zh ? "只读核查…" : "Read-only review…"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void resolve(record.id, record.revision)}
                  >
                    {zh ? "人工核查后处理…" : "Accept after manual review…"}
                  </Button>
                </div>
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
