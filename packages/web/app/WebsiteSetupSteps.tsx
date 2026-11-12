import React from "react";
import "./website-setup.css";

/** Progress follows server state, never a locally persisted wizard flag. */
export function WebsiteSetupSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="website-setup-steps" aria-label="开始使用 CodeShell">
      {["登录账号", "创建工作区", "连接模型"].map((label, index) => (
        <li
          key={label}
          className={index + 1 < current ? "complete" : undefined}
          aria-current={index + 1 === current ? "step" : undefined}
        >
          <span aria-hidden="true">{index + 1 < current ? "✓" : `0${index + 1}`}</span>
          <strong>{label}</strong>
          {index + 1 < current ? <span className="sr-only">已完成</span> : null}
        </li>
      ))}
    </ol>
  );
}
