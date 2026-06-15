import React, { useState } from "react";
import { PanelRight, Copy } from "./ui/icons";
import { IconButton } from "./ui/IconButton";
import { StatusDot } from "./ui/StatusDot";
import type { ToolMessage } from "./types";
import { prettyJson, formatDuration } from "./tool-cards/utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  selectedTool?: ToolMessage | null;
}

export function InspectorPanel({ collapsed, onToggle, selectedTool }: Props) {
  if (collapsed) return null;
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l bg-card/40">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold">详情</span>
        <IconButton label="折叠详情" onClick={onToggle}>
          <PanelRight size={14} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selectedTool ? (
          <ToolInspector tool={selectedTool} />
        ) : (
          <div className="rounded-md border border-dashed p-4 text-sm">
            <div className="font-medium text-foreground">未选中</div>
            <div className="mt-1 text-xs text-muted-foreground">
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
    <div className="flex flex-col gap-3">
      <div className="mb-3 flex items-center gap-2">
        <StatusDot status={dot} title={status} />
        <span className="font-mono text-sm font-medium">{tool.toolName}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{status}</span>
        {duration && <span className="text-xs text-muted-foreground">{duration}</span>}
      </div>
      {tool.summary && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">summary</div>
          <div className="m-0 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs">{tool.summary}</div>
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
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <IconButton
          label="copy"
          className="h-6 w-6"
          onClick={() => {
            void navigator.clipboard.writeText(body);
          }}
        >
          <Copy size={12} />
        </IconButton>
      </div>
      <pre className={cn("m-0 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs", error && "text-status-err")}>{visible}</pre>
      {tooLong && (
        <Button variant="link" size="sm" className="mt-1 h-auto justify-start p-0 text-xs" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "show less" : `show all (${body.length.toLocaleString()} chars)`}
        </Button>
      )}
    </div>
  );
}
