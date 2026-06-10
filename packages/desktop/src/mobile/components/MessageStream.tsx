import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ChatItem, ChatState } from "@mobile/lib/streamReducer";
import { ToolCard } from "./ToolCard";

/** Assistant bubble with a collapsible reasoning section. */
function AssistantBubble({ item }: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      {item.reasoning && (
        <div className="text-xs">
          <button
            type="button"
            onClick={() => setShowReasoning((s) => !s)}
            className="text-muted-foreground underline-offset-2 hover:underline"
          >
            {showReasoning ? "隐藏思考" : "显示思考"}
          </button>
          {showReasoning && (
            <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
              {item.reasoning}
            </pre>
          )}
        </div>
      )}
      {(item.text || !item.done) && (
        <div className="whitespace-pre-wrap break-words text-sm text-foreground">
          {item.text}
          {!item.done && <span className="ml-0.5 inline-block animate-pulse">▋</span>}
        </div>
      )}
    </div>
  );
}

function Row({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex justify-start">
          <div className="max-w-[92%]">
            <AssistantBubble item={item} />
          </div>
        </div>
      );
    case "tool":
      return (
        <div className="max-w-[92%]">
          <ToolCard tool={item} />
        </div>
      );
    case "subagent":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              item.status === "running"
                ? "animate-pulse bg-status-running"
                : item.status === "error"
                  ? "bg-status-err"
                  : "bg-status-ok",
            )}
          />
          <span className="font-medium">子代理</span>
          <span className="truncate">{item.label}</span>
        </div>
      );
    case "system_error":
      return (
        <div className="rounded-md border border-status-err/40 bg-status-err/10 px-3 py-2 text-xs text-status-err">
          {item.text}
        </div>
      );
  }
}

/** The scrollable message feed. Auto-scrolls to bottom on new content unless
 *  the user has scrolled up. */
export function MessageStream({ chat }: { chat: ChatState }) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (chat.items.length === 0) {
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <p className="text-sm text-muted-foreground">
          发个任务试试,或在「房间」里开常驻 Claude Code 会话。
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-3 py-3"
    >
      <div className="flex flex-col gap-3">
        {chat.items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
