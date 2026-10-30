import React from "react";

export function DesktopPairingNotice() {
  return (
    <>
      <h1>此浏览器尚未配对</h1>
      <p>访问口令用于打开网页；首次连接此浏览器还需与电脑配对。</p>
      <ol>
        <li>在电脑 CodeShell 打开「设置 → 手机遥控」。</li>
        <li>刷新配对二维码，用此浏览器扫描或打开完整配对链接。</li>
        <li>配对完成后，可直接使用这台电脑的访问地址。</li>
      </ol>
      <p>配对链接 10 分钟内有效，使用后即失效。重新开启公网遥控会生成新地址，旧地址不再可用。</p>
    </>
  );
}
