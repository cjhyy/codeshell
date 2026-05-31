import React, { useEffect, useState } from "react";
import type { UpdaterStatus } from "../../preload/types";
import { Button } from "@/components/ui/button";

export function UpdaterBanner() {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void window.codeshell.getUpdaterStatus().then(setStatus);
    return window.codeshell.onUpdaterStatus((s) => {
      setStatus(s as UpdaterStatus);
      setDismissed(false);
    });
  }, []);

  if (dismissed) return null;

  if (status.kind === "downloaded") {
    return (
      <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-4 py-2 text-sm">
        <span className="flex-1">新版本 {status.version} 已下载完成。</span>
        <Button size="sm" onClick={() => void window.codeshell.installUpdate()}>重启并安装</Button>
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissed(true)}
          aria-label="关闭"
        >
          ×
        </button>
      </div>
    );
  }

  if (status.kind === "downloading") {
    return (
      <div className="border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
        正在下载新版本… {status.percent}%
      </div>
    );
  }

  if (status.kind === "available") {
    return (
      <div className="border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
        发现新版本 {status.version}，正在下载…
      </div>
    );
  }

  return null;
}

/** Inline status row for the Settings view. */
export function UpdaterSettingsRow() {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });

  useEffect(() => {
    void window.codeshell.getUpdaterStatus().then(setStatus);
    return window.codeshell.onUpdaterStatus((s) => setStatus(s as UpdaterStatus));
  }, []);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">自动更新</h3>
      <div className="text-sm">
        <span className="text-muted-foreground">状态：</span>
        <span>{describeStatus(status)}</span>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void window.codeshell.checkForUpdate()}>
          检查更新
        </Button>
        {status.kind === "downloaded" && (
          <Button size="sm" onClick={() => void window.codeshell.installUpdate()}>重启并安装</Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        生产构建启动后 30 秒自动检查一次，之后每 6 小时再检查。
        update feed URL 通过环境变量 <code className="font-mono">CODESHELL_UPDATE_FEED</code>
        配置；若未设置，则使用 electron-builder 注入的 publish 配置。
      </p>
    </section>
  );
}

function describeStatus(s: UpdaterStatus): string {
  switch (s.kind) {
    case "idle": return "尚未检查";
    case "checking": return "正在检查…";
    case "available": return `发现新版本 ${s.version}`;
    case "not-available": return `已是最新 (${s.version})`;
    case "downloading": return `下载中 ${s.percent}%`;
    case "downloaded": return `新版本 ${s.version} 已下载`;
    case "error": return `失败：${s.message}`;
  }
}
