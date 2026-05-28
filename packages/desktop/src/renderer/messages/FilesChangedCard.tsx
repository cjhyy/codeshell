import React, { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { FilesChangedSummaryMessage } from "../types";
import { truncate } from "../tool-cards/utils";

interface Props {
  message: FilesChangedSummaryMessage;
}

const INITIAL_VISIBLE = 3;

/**
 * Codex-style per-turn summary: "已编辑 N 个文件 +X -Y" folded by
 * default; expanding shows each file path with its +/- counts.
 * Created on turn_complete (see types.ts), so initial state is always
 * collapsed — no turnEpoch wiring needed.
 */
export function FilesChangedCard({ message }: Props) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { files, totalAdded, totalRemoved } = message;
  const visible = showAll ? files : files.slice(0, INITIAL_VISIBLE);
  const remaining = files.length - visible.length;

  return (
    <div className={`files-changed-card${open ? " open" : ""}`}>
      <button
        type="button"
        className="files-changed-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="files-changed-label">已编辑 {files.length} 个文件</span>
        <span className="files-changed-totals">
          <span className="files-changed-added">+{totalAdded}</span>
          <span className="files-changed-removed">-{totalRemoved}</span>
        </span>
      </button>
      {open && (
        <div className="files-changed-body">
          {visible.map((f) => (
            <div key={f.path} className="files-changed-row">
              <span className="files-changed-path">{truncate(f.path, 70)}</span>
              <span className="files-changed-added">+{f.added}</span>
              <span className="files-changed-removed">-{f.removed}</span>
            </div>
          ))}
          {remaining > 0 && (
            <button
              type="button"
              className="files-changed-show-more"
              onClick={() => setShowAll(true)}
            >
              再显示 {remaining} 个文件 ▾
            </button>
          )}
        </div>
      )}
    </div>
  );
}
