import React, { useState } from "react";
import { PanelRight, Copy } from "./ui/icons";
import { IconButton } from "./ui/IconButton";
import { StatusDot } from "./ui/StatusDot";
import type { ToolMessage } from "./types";
import { prettyJson, formatDuration } from "./tool-cards/utils";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  selectedTool?: ToolMessage | null;
}

export function InspectorPanel({ collapsed, onToggle, selectedTool }: Props) {
  if (collapsed) return null;
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span className="inspector-title">详情</span>
        <IconButton label="折叠详情" onClick={onToggle}>
          <PanelRight size={14} />
        </IconButton>
      </div>
      <div className="inspector-body">
        {selectedTool ? (
          <ToolInspector tool={selectedTool} />
        ) : (
          <div className="inspector-empty">
            <div className="inspector-empty-title">未选中</div>
            <div className="inspector-empty-hint">
              在左侧点击一条工具卡片来查看完整详情
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function ToolInspector({ tool }: { tool: ToolMessage }) {
  const status = tool.status;
  const dot =
    status === "running"
      ? "running"
      : status === "failed" || status === "denied"
        ? "err"
        : status === "succeeded"
          ? "ok"
          : status === "cancelled"
            ? "warn"
            : "idle";
  const duration = formatDuration(tool.durationMs);

  return (
    <div className="inspector-tool">
      <div className="inspector-tool-head">
        <StatusDot status={dot} title={status} />
        <span className="inspector-tool-name">{tool.toolName}</span>
        <span className="inspector-tool-status">{status}</span>
        {duration && <span className="inspector-tool-duration">{duration}</span>}
      </div>
      {tool.summary && (
        <div className="inspector-section">
          <div className="inspector-section-label">summary</div>
          <div className="inspector-section-body">{tool.summary}</div>
        </div>
      )}
      <Section label="args" body={prettyJson(tool.args)} />
      {tool.argsLive && (
        <Section
          label="args (live)"
          body={JSON.stringify(tool.argsLive, null, 2)}
        />
      )}
      {tool.result !== undefined && <Section label="result" body={tool.result} />}
      {tool.error && <Section label="error" body={tool.error} error />}
    </div>
  );
}

function Section({ label, body, error }: { label: string; body: string; error?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const LIMIT = 4000;
  const tooLong = body.length > LIMIT;
  const visible = showAll || !tooLong ? body : body.slice(0, LIMIT) + "…";

  return (
    <div className="inspector-section">
      <div className="inspector-section-head">
        <span className="inspector-section-label">{label}</span>
        <IconButton
          label="copy"
          className="inspector-copy"
          onClick={() => {
            void navigator.clipboard.writeText(body);
          }}
        >
          <Copy size={12} />
        </IconButton>
      </div>
      <pre className={`inspector-section-body${error ? " err" : ""}`}>{visible}</pre>
      {tooLong && (
        <button className="inspector-section-more" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "show less" : `show all (${body.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}
