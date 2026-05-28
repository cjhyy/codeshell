import React, { useState, useEffect } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { ToolCard } from "../tool-cards";
import { toolGroupLabel, type ToolGroup } from "./streamGroups";

interface Props {
  group: ToolGroup;
  turnEpoch?: number;
}

/**
 * Codex-style collapsed run of adjacent tool calls (any kind mixed).
 * Default state is collapsed with a one-line summary like
 * "已处理 5 条命令 ▶". Clicking expands the row to render every
 * member ToolCard inline so the detail isn't lost.
 *
 * On turnEpoch change, the group force-collapses back to summary.
 */
export function ToolGroupCard({ group, turnEpoch }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (turnEpoch !== undefined) setOpen(false);
  }, [turnEpoch]);
  const label = toolGroupLabel(group.tools.length);

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
          {group.tools.map((t) => (
            <ToolCard key={t.id} message={t} turnEpoch={turnEpoch} />
          ))}
        </div>
      )}
    </div>
  );
}
