import React, { useEffect, useRef } from "react";
import type { Message } from "./types";
import { ToolCallBlock } from "./ToolCallBlock";

export function MessageStream({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="stream">
      {messages.map((m) => {
        if (m.kind === "tool") return <ToolCallBlock key={m.id} message={m} />;
        if (m.kind === "user")
          return (
            <div key={m.id} className="msg msg-user">
              <pre>{m.text}</pre>
            </div>
          );
        if (m.kind === "assistant")
          return (
            <div key={m.id} className={`msg msg-assistant ${m.done ? "done" : "streaming"}`}>
              <pre>{m.text || (m.done ? "" : "…")}</pre>
            </div>
          );
        return (
          <div key={m.id} className="msg msg-system">
            <pre>{m.text}</pre>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
