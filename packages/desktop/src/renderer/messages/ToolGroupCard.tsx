import React, { memo, useState, useEffect } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { ThinkingMessageView } from "./ThinkingMessageView";
import {
  toolGroupActivityLabel,
  type ToolGroup,
} from "./streamGroups";
import { Button } from "@/components/ui/button";

interface Props {
  group: ToolGroup;
  turnEpoch?: number;
  defaultOpen?: boolean;
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
function ToolGroupCardImpl({ group, turnEpoch, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (turnEpoch !== undefined) setOpen(defaultOpen);
  }, [defaultOpen, turnEpoch]);
  const label = toolGroupActivityLabel(group);

  return (
    <div className="rounded-md border bg-card">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start gap-2 rounded-none px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      </Button>
      {open && (
        <div className="flex flex-col gap-2 border-t p-2">
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
