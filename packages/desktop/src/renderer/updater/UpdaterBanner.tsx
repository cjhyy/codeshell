import React, { useEffect, useState } from "react";
import type { UpdaterStatus } from "../../preload/types";

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
      <div className="updater-banner updater-banner-ready">
        新版本 {status.version} 已下载完成。
        <button
          className="updater-banner-btn"
          onClick={() => void window.codeshell.installUpdate()}
        >
          重启并安装
        </button>
        <button
          className="updater-banner-close"
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
      <div className="updater-banner">
        正在下载新版本… {status.percent}%
      </div>
    );
  }

  if (status.kind === "available") {
    return (
      <div className="updater-banner">
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
    <section className="settings-section">
      <h3 className="settings-section-title">自动更新</h3>
      <div className="settings-section-current">
        <span className="settings-section-label">状态：</span>
        <span>{describeStatus(status)}</span>
      </div>
      <div className="settings-toolbar">
        <button
          className="approval-btn deny"
          onClick={() => void window.codeshell.checkForUpdate()}
        >
          检查更新
        </button>
        {status.kind === "downloaded" && (
          <button
            className="approval-btn approve"
            onClick={() => void window.codeshell.installUpdate()}
          >
            重启并安装
          </button>
        )}
      </div>
      <p className="settings-section-help">
        生产构建启动后 30 秒自动检查一次，之后每 6 小时再检查。
        update feed URL 通过环境变量 <code>CODESHELL_UPDATE_FEED</code>
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
