import React from "react";

export function McpView() {
  return (
    <div className="mcp-view">
      <h2 className="approvals-section-title">MCP 插件</h2>
      <div className="approvals-empty">
        在 settings 里配置 <code>mcpServers</code>，重启 desktop 后插件会被 worker 加载。
        独立的 connect/disconnect/工具列表 GUI 待 core 暴露 query API 后接入。
      </div>
    </div>
  );
}
