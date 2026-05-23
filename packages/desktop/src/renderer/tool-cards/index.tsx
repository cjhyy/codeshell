import React from "react";
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
}

/**
 * Dispatch a tool message to the right specialized card based on tool name.
 * Falls back to GenericToolCard for unknown tools.
 */
export function ToolCard({ message, onSelect, selectedId }: Props) {
  const selected = selectedId === message.id;
  const name = message.toolName.toLowerCase();

  if (name === "bash" || name === "shell" || name === "run") {
    return <BashToolCard message={message} onSelect={onSelect} selected={selected} />;
  }
  if (name === "read" || name === "view" || name === "fileread") {
    return <FileToolCard message={message} variant="read" onSelect={onSelect} selected={selected} />;
  }
  if (name === "write" || name === "filewrite") {
    return <FileToolCard message={message} variant="write" onSelect={onSelect} selected={selected} />;
  }
  if (name === "edit" || name === "multiedit" || name === "applypatch" || name === "apply_patch") {
    return <FileToolCard message={message} variant="edit" onSelect={onSelect} selected={selected} />;
  }
  if (name === "grep" || name === "glob" || name === "search") {
    return <SearchToolCard message={message} onSelect={onSelect} selected={selected} />;
  }
  if (name === "webfetch" || name === "websearch" || name === "fetch") {
    return <WebToolCard message={message} onSelect={onSelect} selected={selected} />;
  }
  if (name === "agent" || name === "task" || name.startsWith("agent")) {
    return <AgentToolCard message={message} onSelect={onSelect} selected={selected} />;
  }
  return <GenericToolCard message={message} onSelect={onSelect} selected={selected} />;
}
