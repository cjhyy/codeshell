import React from "react";

export function RunsView() {
  return (
    <div className="runs-view">
      <h2 className="approvals-section-title">运行</h2>
      <div className="approvals-empty">
        Runs dashboard 需要 core 端 RunManager 暴露 list/get/resume/cancel
        RPC。目前 desktop 只能从 chat 流里观察当前 run，待 IPC 通路接通后
        本视图会列出全部 runs、checkpoints 与 artifacts。
      </div>
    </div>
  );
}
