import React, { memo, useState, useEffect } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
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
function ToolGroupCardImpl({ group, turnEpoch }: Props) {
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
            // thinking — the only non-tool item a tool_group can hold.
            return <ThinkingMessageView key={it.id} message={it} />;
          })}
        </div>
      )}
    </div>
  );
}

export const ToolGroupCard = memo(ToolGroupCardImpl);
