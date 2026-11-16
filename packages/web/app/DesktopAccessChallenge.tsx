import React from "react";
import { EnvironmentMenu } from "./EnvironmentMenu.js";

export function DesktopAccessChallenge({
  draft,
  onVerify,
  account = false,
}: {
  draft?: string;
  onVerify: () => void;
  account?: boolean;
}) {
  return (
    <main className="desktop-connection">
      <div className="desktop-connection-card">
        <EnvironmentMenu discover={false} />
        <h1>{account ? "远程访问授权已失效，请重新验证" : "访问口令已更新，请重新验证"}</h1>
        <p>
          {account
            ? "请返回电脑列表，在当前手机或浏览器用 Passkey 重新验证，再连接这台电脑。电脑上的任务不会因此停止，重新连接后可查看已保存的消息。离开前请复制保存尚未发送的草稿。"
            : "设备配对已保留。重新验证将刷新此页，请先保留尚未发送的内容。"}
        </p>
        {draft ? (
          <label>
            未发送的草稿，可复制保存
            <textarea value={draft} readOnly rows={4} style={{ width: "100%" }} />
          </label>
        ) : null}
        <button className="library-button primary" onClick={onVerify}>
          {account ? "返回电脑列表并重新验证" : "重新验证"}
        </button>
      </div>
    </main>
  );
}
