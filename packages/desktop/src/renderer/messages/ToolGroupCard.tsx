import React, { memo, useState, useEffect, useRef, useId } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { ThinkingMessageView } from "./ThinkingMessageView";
import { toolGroupActivityLabel, type ToolGroup } from "./streamGroups";
import { Button } from "@/components/ui/button";

interface Props {
  group: ToolGroup;
  turnEpoch?: number;
  defaultOpen?: boolean;
  /** Session cwd, forwarded to member tool cards for attachment resolution. */
  cwd?: string | null;
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
 * At the end of its own running epoch, the group returns to defaultOpen.
 * Later turns leave manually opened historical groups alone.
 */
function ToolGroupCardImpl({ group, turnEpoch, defaultOpen = false, cwd }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();
  const previousEpochRef = useRef(turnEpoch);
  const ranInEpochRef = useRef(false);
  const running = group.items.some((item) => item.kind === "tool" && item.status === "running");
  useEffect(() => {
    if (turnEpoch !== undefined && previousEpochRef.current !== turnEpoch) {
      if (ranInEpochRef.current) setOpen(defaultOpen);
      ranInEpochRef.current = false;
    }
    // Latch activity until the turn ends, including tools that finish before
    // the assistant's final answer and the subsequent epoch bump.
    if (running) ranInEpochRef.current = true;
    previousEpochRef.current = turnEpoch;
  }, [defaultOpen, running, turnEpoch]);
  const label = toolGroupActivityLabel(group);

  return (
    <div className="rounded-md border bg-card">
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-start gap-2 rounded-md px-3 py-2 text-left focus-visible:ring-inset"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={detailsId}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      </Button>
      <div
        id={detailsId}
        hidden={!open}
        className={open ? "flex flex-col gap-2 border-t p-2" : "hidden"}
      >
        {open &&
          group.items.map((it) => {
            if (it.kind === "tool") {
              return <ToolCard key={it.id} message={it} turnEpoch={turnEpoch} cwd={cwd} />;
            }
            // thinking — the only non-tool item a tool_group can hold.
            return <ThinkingMessageView key={it.id} message={it} />;
          })}
      </div>
    </div>
  );
}

export const ToolGroupCard = memo(ToolGroupCardImpl);
