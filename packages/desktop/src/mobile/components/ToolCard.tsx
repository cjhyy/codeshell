import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ChatItem } from "@mobile/lib/streamReducer";

type Tool = Extract<ChatItem, { kind: "tool" }>;

/** A compact tool card: header (name + status), optional args/result body that
 *  expands on tap. Mirrors the desktop tool card's information, phone-sized. */
export function ToolCard({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const argStr = tool.args ? JSON.stringify(tool.args) : "";
  const hasBody = Boolean(argStr) || Boolean(tool.result) || Boolean(tool.summary);
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card/60 text-xs",
        tool.error && "border-status-err/40",
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            !tool.done ? "animate-pulse bg-status-running" : tool.error ? "bg-status-err" : "bg-status-ok",
          )}
        />
        <span className="font-mono font-medium text-foreground">{tool.name}</span>
        {tool.summary && (
          <span className="truncate text-muted-foreground">· {tool.summary}</span>
        )}
        {hasBody && (
          <span className="ml-auto text-muted-foreground">{open ? "−" : "+"}</span>
        )}
      </button>
      {open && hasBody && (
        <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
          {argStr && argStr !== "{}" && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
              {argStr}
            </pre>
          )}
          {tool.result && (
            <pre
              className={cn(
                "overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px]",
                tool.error ? "text-status-err" : "text-foreground/80",
              )}
            >
              {tool.result.length > 4000 ? tool.result.slice(0, 4000) + "\n… (truncated)" : tool.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
