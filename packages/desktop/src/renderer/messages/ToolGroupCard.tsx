import React, { memo, useState, useEffect, useRef, useId } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { ThinkingMessageView } from "./ThinkingMessageView";
import { toolGroupActivityLabel, type ToolGroup } from "./streamGroups";
import { Button } from "@/components/ui/button";
import type { AttachmentContext } from "../tool-cards/attachments";
import { useAnchoredLayoutChange } from "../chat/TranscriptScrollContext";

interface Props extends AttachmentContext {
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
 * At the end of its own running epoch, an untouched group returns to defaultOpen.
 * Once the reader chooses a state, completion and later turns preserve it.
 */
function ToolGroupCardImpl({ group, turnEpoch, defaultOpen = false, ...attachmentContext }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const anchoredChange = useAnchoredLayoutChange();
  const manuallyToggled = useRef(false);
  const detailsId = useId();
  const previousEpochRef = useRef(turnEpoch);
  const ranInEpochRef = useRef(false);
  const running = group.items.some((item) => item.kind === "tool" && item.status === "running");
  useEffect(() => {
    if (turnEpoch !== undefined && previousEpochRef.current !== turnEpoch) {
      if (ranInEpochRef.current && !manuallyToggled.current) setOpen(defaultOpen);
      ranInEpochRef.current = false;
    }
    // Latch activity until the turn ends, including tools that finish before
    // the assistant's final answer and the subsequent epoch bump.
    if (running) ranInEpochRef.current = true;
    previousEpochRef.current = turnEpoch;
  }, [defaultOpen, running, turnEpoch]);
  const label = toolGroupActivityLabel(group);

  return (
    <div data-tool-group="" className="min-w-0 rounded-md border border-border/40 bg-card">
      <Button
        data-tool-group-heading=""
        type="button"
        variant="ghost"
        className="h-auto min-h-8 w-full justify-start gap-1.5 rounded-md px-2 py-1.5 text-left leading-5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/60 [&>svg]:size-3"
        onClick={(event) => {
          manuallyToggled.current = true;
          anchoredChange(event.currentTarget, () => setOpen((v) => !v));
        }}
        aria-expanded={open}
        aria-controls={detailsId}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {label}
        </span>
      </Button>
      <div
        data-tool-group-content=""
        id={detailsId}
        hidden={!open}
        className={open ? "flex min-w-0 flex-col gap-0.5 px-1 pb-1" : "hidden"}
      >
        {open &&
          group.items.map((it) => {
            if (it.kind === "tool") {
              return (
                <ToolCard key={it.id} message={it} turnEpoch={turnEpoch} {...attachmentContext} />
              );
            }
            // thinking — the only non-tool item a tool_group can hold.
            return <ThinkingMessageView key={it.id} message={it} />;
          })}
      </div>
    </div>
  );
}

export const ToolGroupCard = memo(ToolGroupCardImpl);
