import React from "react";
import type { ChatItem } from "../src/lib/streamReducer.js";
import type { HistoryDetailLoader } from "./workbench-types.js";
import { MessageContent, MessageCopyButton, type VisibleReplyText } from "./MessageContent.js";

type Assistant = Extract<ChatItem, { kind: "assistant" }>;

/** One final answer selected by the process projection; narration/tools never enter this list. */
export function AnswerContent({
  items,
  partial = false,
  pending = false,
  onOpenFile,
  loadHistoryDetail,
  reloadHistory,
  detailScope = "",
}: {
  items: readonly Assistant[];
  partial?: boolean;
  pending?: boolean;
  onOpenFile?: (path: string) => void;
  loadHistoryDetail?: HistoryDetailLoader;
  reloadHistory?: () => void;
  detailScope?: string;
}) {
  const scope = JSON.stringify([detailScope, items.map((item) => [item.id, item.textDetailRef])]);
  const activeScope = React.useRef(scope);
  activeScope.current = scope;
  const [visible, setVisible] = React.useState<{
    scope: string;
    bodies: Map<string, VisibleReplyText>;
  }>({ scope, bodies: new Map() });
  const callbacks = React.useMemo(
    () =>
      new Map(
        items
          .filter((item) => item.textDetailRef)
          .map(
            (item) =>
              [
                item.id,
                (body?: VisibleReplyText) => {
                  if (activeScope.current !== scope) return;
                  setVisible((previous) => {
                    const bodies = new Map(previous.scope === scope ? previous.bodies : []);
                    const before = bodies.get(item.id);
                    if (before?.text === body?.text && before?.complete === body?.complete)
                      return previous;
                    if (body) bodies.set(item.id, body);
                    else bodies.delete(item.id);
                    return { scope, bodies };
                  });
                },
              ] as const,
          ),
      ),
    [scope],
  );
  const bodies = items.map(
    (item) =>
      (visible.scope === scope ? visible.bodies.get(item.id) : undefined) ?? {
        text: item.text,
        complete: !item.textDetailRef,
      },
  );
  const text = bodies
    .map((body) => body.text)
    .filter((body) => body.trim())
    .join("\n\n");
  const incomplete = partial || bodies.some((body) => !body.complete);
  return (
    <>
      {items.map((item) => (
        <MessageContent
          key={`${detailScope}:${item.id}`}
          text={item.text}
          reasoning={item.reasoning}
          reasoningDetailRef={item.reasoningDetailRef}
          textDetailRef={item.textDetailRef}
          detailScope={detailScope}
          loadHistoryDetail={loadHistoryDetail}
          reloadHistory={reloadHistory}
          streaming={!item.done}
          onOpenFile={onOpenFile}
          showCopy={false}
          onVisibleTextChange={callbacks.get(item.id)}
        />
      ))}
      {!pending && items.every((item) => item.done) && text ? (
        <div className="message-actions">
          <MessageCopyButton
            key={scope}
            text={text}
            label={incomplete ? "复制已显示内容" : "复制回复"}
          />
        </div>
      ) : null}
    </>
  );
}
