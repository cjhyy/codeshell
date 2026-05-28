import React, { useState, useEffect } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { Markdown } from "../Markdown";
import { ThinkingMessageView } from "./ThinkingMessageView";
import {
  toolGroupLabel,
  toolGroupToolCount,
  type ToolGroup,
} from "./streamGroups";

interface Props {
  group: ToolGroup;
  turnEpoch?: number;
}

/**
 * Codex-style collapsed run of adjacent tool calls (any kind mixed).
 * Default state is collapsed with a one-line summary like
 * "已处理 5 条命令 ▶". Clicking expands the row to render every
 * member inline so the detail isn't lost.
 *
 * Groups may now contain transparent thinking/assistant items wedged
 * between tools (see streamGroups.ts foldAdjacentTools). The header
 * count still reflects tools-only; the expanded body renders each
 * inner item with its native component.
 *
 * On turnEpoch change, the group force-collapses back to summary.
 */
export function ToolGroupCard({ group, turnEpoch }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (turnEpoch !== undefined) setOpen(false);
  }, [turnEpoch]);
  const label = toolGroupLabel(toolGroupToolCount(group));

  return (
    <div className={`tool-group${open ? " open" : ""}`}>
      <button
        type="button"
        className="tool-group-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="tool-group-label">{label}</span>
      </button>
      {open && (
        <div className="tool-group-body">
          {group.items.map((it) => {
            if (it.kind === "tool") {
              return <ToolCard key={it.id} message={it} turnEpoch={turnEpoch} />;
            }
            if (it.kind === "thinking") {
              return <ThinkingMessageView key={it.id} message={it} />;
            }
            // assistant — same shell as MessageStream's inline render.
            if (!it.done && it.text === "") return null;
            return (
              <div
                key={it.id}
                className={`msg-row msg-row-assistant ${it.done ? "done" : "streaming"}`}
              >
                {it.done ? (
                  <Markdown text={it.text} />
                ) : (
                  <div className="md-body md-streaming">
                    <pre>{it.text}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
