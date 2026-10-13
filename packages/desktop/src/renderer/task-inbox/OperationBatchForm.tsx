import React, { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import type { OperationBatchItem, OperationBatchOptions } from "../../shared/operation-batch.js";
const emptyItem = (): OperationBatchItem => ({ owner: "", repo: "", title: "", body: "" });

/** Explicit user-authored proposal. Only the following Native dialog can approve it. */
export function OperationBatchForm({ sessionId }: { sessionId: string }) {
  const { lang } = useT();
  const zh = lang === "zh";
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<OperationBatchOptions>({ connections: [] });
  const [connectionId, setConnectionId] = useState("");
  const [items, setItems] = useState<OperationBatchItem[]>([emptyItem()]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const load = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setOpen(true);
    setNotice("");
    try {
      const result = await window.codeshell.operationBatch.options(sessionId);
      setOptions(result);
      setConnectionId("");
      if (!result.connections.length)
        setNotice(
          zh
            ? "没有可用连接。需要已配置的 GitHub 创建与回读权限；不会自动连接账号。"
            : "No eligible saved connection. GitHub creation and verification scopes are required.",
        );
    } catch {
      setNotice(
        zh
          ? "请先停止会话，并确认项目仍受信任。"
          : "Stop this Session and check project trust first.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const result = await window.codeshell.operationBatch.start({
        sessionId,
        connectionId,
        items,
      });
      setNotice(
        result.status === "cancelled"
          ? zh
            ? "已取消，没有开始批量操作。"
            : "Cancelled. No batch started."
          : zh
            ? `已提交 ${result.count} 项固定清单。每项仍需写入审批；请在会话及活动记录查看结果。`
            : `${result.count} fixed items submitted. Each still requires write approval; follow the Session and activity records.`,
      );
    } catch {
      setNotice(
        zh
          ? "清单或授权已改变，未确认开始。请检查活动记录后再发起新的清单。"
          : "The proposal or authority changed. Check activity records before starting a new proposal.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const update = (index: number, key: keyof OperationBatchItem, value: string) =>
    setItems((prior) => prior.map((item, i) => (i === index ? { ...item, [key]: value } : item)));
  return (
    <section className="space-y-2" aria-label={zh ? "批量创建 Issue" : "Create Issue batch"}>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
        {zh ? "批量创建 Issue" : "Create Issue batch"}
      </Button>
      {open && (
        <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded border p-3">
          <p className="text-xs text-muted-foreground">
            {zh
              ? "手动填写 1–8 项固定清单。原生确认后按顺序执行；失败、取消或结果未知时停止，关闭后不会自动继续。"
              : "Enter 1–8 fixed items. Native confirmation starts sequential execution; failure, cancellation or unknown results stop it. Restart never resumes writes."}
          </p>
          <label className="block text-xs">
            {zh ? "已保存的 GitHub 连接" : "Saved GitHub connection"}
            <select
              required
              disabled={busy}
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
              className="ml-2 rounded border bg-background p-1"
            >
              <option value="">{zh ? "明确选择连接" : "Select a connection"}</option>
              {options.connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label}
                </option>
              ))}
            </select>
          </label>
          {items.map((item, index) => (
            <fieldset key={index} disabled={busy} className="space-y-1 rounded border p-2">
              <legend>{index + 1}</legend>
              {(["owner", "repo", "title"] as const).map((key) => (
                <label key={key} className="block text-xs">
                  {key}
                  <input
                    required
                    maxLength={key === "title" ? 256 : 100}
                    aria-label={`${index + 1} ${key}`}
                    value={item[key]}
                    onChange={(event) => update(index, key, event.target.value)}
                    className="ml-2 rounded border bg-background px-2"
                  />
                </label>
              ))}
              <label className="block text-xs">
                body
                <textarea
                  maxLength={20000}
                  aria-label={`${index + 1} body`}
                  value={item.body ?? ""}
                  onChange={(event) => update(index, "body", event.target.value)}
                  className="block w-full rounded border bg-background p-2"
                />
              </label>
              {items.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setItems((prior) => prior.filter((_, i) => i !== index))}
                >
                  {zh ? "删除此项" : "Remove item"}
                </Button>
              )}
            </fieldset>
          ))}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || items.length >= 8}
              onClick={() => setItems((prior) => [...prior, emptyItem()])}
            >
              {zh ? "添加一项" : "Add item"}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !connectionId}>
              {zh ? "核对清单并原生确认" : "Review with Native confirmation"}
            </Button>
          </div>
        </form>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
    </section>
  );
}
