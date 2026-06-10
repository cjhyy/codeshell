import { useEffect, useRef, useState } from "react";
import { Bot, Brain, UserRound } from "lucide-react";
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
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground"
          >
            <Brain className="size-3" />
            {showReasoning ? "隐藏思考" : "显示思考"}
          </button>
          {showReasoning && (
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/35 p-2.5 font-mono text-[11px] text-muted-foreground">
              {item.reasoning}
            </pre>
          )}
        </div>
      )}
      {(item.text || !item.done) && (
        <div className="whitespace-pre-wrap break-words text-[15px] leading-6 text-foreground">
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
        <div className="flex justify-end gap-2">
          <div className="mobile-message-user max-w-[84%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-[15px] leading-6 text-white">
            {item.text}
          </div>
          <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/15 text-primary">
            <UserRound className="size-3.5" />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex justify-start gap-2">
          <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-full border border-status-ok/25 bg-status-ok/10 text-status-ok">
            <Bot className="size-3.5" />
          </div>
          <div className="mobile-message-assistant max-w-[92%] rounded-r-xl px-3 py-2">
            <AssistantBubble item={item} />
          </div>
        </div>
      );
    case "tool":
      return (
        <div className="ml-9 max-w-[92%]">
          <ToolCard tool={item} />
        </div>
      );
    case "subagent":
      return (
        <div className="ml-9 flex items-center gap-2 rounded-full border border-border/65 bg-muted/25 px-3 py-1.5 text-xs text-muted-foreground">
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
        <div className="ml-9 rounded-lg border border-status-err/40 bg-status-err/10 px-3 py-2 text-xs text-status-err">
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
        <div className="mobile-glass max-w-sm rounded-xl px-5 py-6">
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
            <Bot className="size-5" />
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            发个任务试试,或在「房间」里开常驻 Claude Code 会话。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {chat.items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
