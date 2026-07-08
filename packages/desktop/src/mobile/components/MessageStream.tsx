import { useEffect, useRef, useState } from "react";
import { Bot, Brain, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type { ChatItem, ChatState } from "@/lib/streamReducer";
import { ToolCard } from "./ToolCard";
import { Markdown } from "./Markdown";

export interface ScrollAnchor {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  stickToBottom: boolean;
}

interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function captureScrollAnchor(el: ScrollMetrics, threshold = 80): ScrollAnchor {
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    stickToBottom: el.scrollHeight - el.scrollTop - el.clientHeight < threshold,
  };
}

export function restoreScrollAnchor(el: ScrollMetrics, anchor: ScrollAnchor): number {
  if (anchor.stickToBottom) return Math.max(0, el.scrollHeight - el.clientHeight);
  const bottomOffset = Math.max(0, anchor.scrollHeight - anchor.scrollTop);
  return Math.max(0, el.scrollHeight - bottomOffset);
}

/** Assistant bubble with a collapsible reasoning section. */
function AssistantBubble({ item }: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  const { t } = useT();
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
            {showReasoning ? t("mobile.stream.hideReasoning") : t("mobile.stream.showReasoning")}
          </button>
          {showReasoning && (
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/35 p-2.5 font-mono text-[11px] text-muted-foreground">
              {item.reasoning}
            </pre>
          )}
        </div>
      )}
      {(item.text || !item.done) &&
        (item.done && item.text ? (
          // Completed prose → render Markdown (lists/code/headings/tables). While
          // still streaming we keep plain text to avoid re-parsing half-formed
          // markdown on every token (jitter), matching the desktop renderer.
          <div className="min-w-0 break-words">
            <Markdown text={item.text} />
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words text-[15px] leading-6 text-foreground">
            {item.text}
            {!item.done && <span className="ml-0.5 inline-block animate-pulse">▋</span>}
          </div>
        ))}
    </div>
  );
}

function Row({ item }: { item: ChatItem }) {
  const { t } = useT();
  switch (item.kind) {
    case "user":
      return (
        <div className="flex min-w-0 justify-end gap-2">
          <div className="mobile-message-user min-w-0 max-w-[84%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-[15px] leading-6 text-white">
            {item.text}
          </div>
          <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-full border border-primary/30 bg-primary/15 text-primary">
            <UserRound className="size-3.5" />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex min-w-0 justify-start gap-2">
          <div className="mt-1 grid size-7 shrink-0 place-items-center rounded-full border border-status-ok/25 bg-status-ok/10 text-status-ok">
            <Bot className="size-3.5" />
          </div>
          <div className="mobile-message-assistant min-w-0 max-w-[92%] rounded-r-xl px-3 py-2">
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
        <div className="ml-9 flex min-w-0 items-center gap-2 rounded-full border border-border/65 bg-muted/25 px-3 py-1.5 text-xs text-muted-foreground">
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
          <span className="shrink-0 font-medium">{t("mobile.stream.subagent")}</span>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
export function MessageStream({
  conversationKey = "default",
  chat,
  loading,
  loadingText,
}: {
  conversationKey?: string;
  chat: ChatState;
  loading?: boolean;
  loadingText?: string;
}) {
  const { t } = useT();
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const anchorsRef = useRef<Map<string, ScrollAnchor>>(new Map());

  const saveAnchor = () => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = captureScrollAnchor(el);
    anchorsRef.current.set(conversationKey, anchor);
    stickRef.current = anchor.stickToBottom;
  };

  useEffect(() => {
    const anchor = anchorsRef.current.get(conversationKey);
    stickRef.current = anchor?.stickToBottom ?? true;
  }, [conversationKey]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") saveAnchor();
    };
    const onPageHide = () => saveAnchor();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [conversationKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const anchor = anchorsRef.current.get(conversationKey);
    if (stickRef.current || anchor?.stickToBottom) {
      endRef.current?.scrollIntoView({ block: "end" });
      return;
    }
    if (!anchor) return;
    el.scrollTop = restoreScrollAnchor(el, anchor);
  }, [chat.items, conversationKey]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    saveAnchor();
  };

  if (chat.items.length === 0) {
    const effectiveLoadingText = loadingText ?? t("mobile.stream.loading");
    return (
      <div className="grid flex-1 place-items-center px-6 text-center">
        <div className="mobile-glass max-w-sm rounded-xl px-5 py-6">
          <div className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
            <Bot className="size-5" />
          </div>
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-sm leading-6 text-muted-foreground">
              <span className="size-2 rounded-full bg-status-running animate-pulse" />
              {effectiveLoadingText}
            </div>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              {t("mobile.stream.emptyHint")}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-4">
      <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-4">
        {chat.items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
