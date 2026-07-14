import React, { memo } from "react";
import type { ToolMessage } from "../types";
import { BashToolCard } from "./BashToolCard";
import { FileToolCard } from "./FileToolCard";
import { SearchToolCard } from "./SearchToolCard";
import { WebToolCard } from "./WebToolCard";
import { AgentToolCard } from "./AgentToolCard";
import { GenericToolCard } from "./GenericToolCard";

interface Props {
  message: ToolMessage;
  onSelect?: (m: ToolMessage) => void;
  selectedId?: string | null;
  turnEpoch?: number;
  /** Session cwd, used to resolve relative attachment paths. */
  cwd?: string | null;
}

/**
 * Dispatch a tool message to the right specialized card based on tool name.
 * Falls back to GenericToolCard for unknown tools.
 *
 * Wrapped in React.memo: in long sessions the parent <MessageStream>
 * re-renders on every text_delta (assistant text is in the same messages
 * array). Without memo each text_delta walks all sibling tool cards.
 * The `message` reference is stable across deltas — the reducer's
 * `messages.map` keeps untouched items by reference identity — so the
 * default shallow compare correctly short-circuits.
 */
function ToolCardImpl({ message, onSelect, selectedId, turnEpoch, cwd }: Props) {
  const selected = selectedId === message.id;
  const name = message.toolName.toLowerCase();

  const card = (() => {
    if (name === "bash" || name === "shell" || name === "run") {
      return (
        <BashToolCard
          message={message}
          onSelect={onSelect}
          selected={selected}
          turnEpoch={turnEpoch}
        />
      );
    }
    if (name === "read" || name === "view" || name === "fileread") {
      return (
        <FileToolCard
          message={message}
          variant="read"
          onSelect={onSelect}
          selected={selected}
          turnEpoch={turnEpoch}
          cwd={cwd}
        />
      );
    }
    if (name === "write" || name === "filewrite") {
      return (
        <FileToolCard
          message={message}
          variant="write"
          onSelect={onSelect}
          selected={selected}
          turnEpoch={turnEpoch}
          cwd={cwd}
        />
      );
    }
    if (
      name === "edit" ||
      name === "multiedit" ||
      name === "applypatch" ||
      name === "apply_patch"
    ) {
      return (
        <FileToolCard
          message={message}
          variant="edit"
          onSelect={onSelect}
          selected={selected}
          turnEpoch={turnEpoch}
          cwd={cwd}
        />
      );
    }
    if (name === "grep" || name === "glob" || name === "search") {
      return (
        <SearchToolCard
          message={message}
          onSelect={onSelect}
          selected={selected}
          turnEpoch={turnEpoch}
        />
      );
    }
    if (name === "webfetch" || name === "websearch" || name === "fetch") {
      return (
        <WebToolCard
          message={message}
          onSelect={onSelect}
          selected={selected}
          turnEpoch={turnEpoch}
        />
      );
    }
    if (name === "agent" || name === "task" || name.startsWith("agent")) {
      return (
        <AgentToolCard
          message={message}
          onSelect={onSelect}
          selected={selected}
          turnEpoch={turnEpoch}
        />
      );
    }
    return (
      <GenericToolCard
        message={message}
        onSelect={onSelect}
        selected={selected}
        turnEpoch={turnEpoch}
        cwd={cwd}
      />
    );
  })();

  return (
    <div className="contents" data-message-kind="tool" data-tool-name={message.toolName}>
      {card}
    </div>
  );
}

export const ToolCard = memo(ToolCardImpl);
