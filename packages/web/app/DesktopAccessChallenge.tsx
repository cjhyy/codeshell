import React from "react";
import { EnvironmentMenu } from "./EnvironmentMenu.js";

export function DesktopAccessChallenge({
  draft,
  onVerify,
}: {
  draft?: string;
  onVerify: () => void;
}) {
  return (
    <main className="desktop-connection">
      <div className="desktop-connection-card">
        <EnvironmentMenu discover={false} />
        <h1>访问口令已更新，请重新验证</h1>
        <p>设备配对已保留。重新验证将刷新此页，请先保留尚未发送的内容。</p>
        {draft ? (
          <label>
            未发送的草稿，可复制保存
            <textarea value={draft} readOnly rows={4} style={{ width: "100%" }} />
          </label>
        ) : null}
        <button className="library-button primary" onClick={onVerify}>
          重新验证
        </button>
      </div>
    </main>
  );
}
