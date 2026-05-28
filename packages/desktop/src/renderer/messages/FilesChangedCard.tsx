import React, { useState } from "react";
import { ChevronRight, ChevronDown, RotateCcw, Eye, X } from "lucide-react";
import type { FilesChangedSummaryMessage } from "../types";
import type { UndoFilesResult } from "../../preload/types";
import { truncate } from "../tool-cards/utils";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";

interface Props {
  message: FilesChangedSummaryMessage;
  /** Working directory of the owning chat. Required for review / undo. */
  cwd: string | null;
}

const INITIAL_VISIBLE = 3;

/**
 * Codex-style per-turn summary: "已编辑 N 个文件 +X -Y" folded by
 * default; expanding shows each file path with its +/- counts.
 *
 * Header actions (only when `cwd` is set — sessions without a repo
 * have nothing meaningful to review or undo against):
 *   - 审核 (Review) → opens a modal showing the working-tree diff
 *     scoped to this card's files.
 *   - 撤销 (Undo) → after a confirm, restores tracked files from
 *     HEAD and deletes untracked ones. Each path reports back
 *     individually so partial failures don't lose information.
 */
export function FilesChangedCard({ message, cwd }: Props) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoStatus, setUndoStatus] = useState<string | null>(null);

  const { files, totalAdded, totalRemoved } = message;
  const visible = showAll ? files : files.slice(0, INITIAL_VISIBLE);
  const remaining = files.length - visible.length;

  const canAct = !!cwd && files.length > 0;

  const onUndoConfirmed = async (): Promise<void> => {
    if (!cwd) return;
    setConfirmUndo(false);
    setUndoing(true);
    setUndoStatus(null);
    try {
      const results: UndoFilesResult[] = await window.codeshell.undoFiles(
        cwd,
        files.map((f) => f.path),
      );
      const failures = results.filter((r) => !r.ok);
      if (failures.length === 0) {
        setUndoStatus(`已撤销 ${results.length} 个文件`);
      } else {
        setUndoStatus(
          `部分失败:${failures.length}/${results.length}(${failures[0]!.error ?? "unknown"})`,
        );
      }
    } catch (e: unknown) {
      setUndoStatus(`撤销失败:${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setUndoing(false);
      // Auto-clear the status banner after a few seconds so the card
      // returns to its quiet state.
      window.setTimeout(() => setUndoStatus(null), 4000);
    }
  };

  return (
    <>
      <div className={`files-changed-card${open ? " open" : ""}`}>
        <div className="files-changed-head-row">
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
          {canAct && (
            <div className="files-changed-actions">
              <button
                type="button"
                className="files-changed-action"
                onClick={() => setReviewOpen(true)}
                aria-label="审核改动"
                title="审核(查看完整 diff)"
              >
                <Eye size={12} />
                <span>审核</span>
              </button>
              <button
                type="button"
                className="files-changed-action files-changed-action-danger"
                onClick={() => setConfirmUndo(true)}
                disabled={undoing}
                aria-label="撤销改动"
                title="撤销(把这些文件回滚到 HEAD)"
              >
                <RotateCcw size={12} />
                <span>{undoing ? "撤销中…" : "撤销"}</span>
              </button>
            </div>
          )}
        </div>
        {undoStatus && (
          <div className="files-changed-status">{undoStatus}</div>
        )}
        {open && (
          <div className="files-changed-body">
            {visible.map((f) => (
              <div key={f.path} className="files-changed-row">
                <a
                  href="#"
                  className="files-changed-path"
                  title={f.path}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.codeshell.openPath(f.path, cwd ?? undefined);
                  }}
                >
                  {truncate(f.path, 70)}
                </a>
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

      {confirmUndo && (
        <ConfirmUndoModal
          fileCount={files.length}
          onCancel={() => setConfirmUndo(false)}
          onConfirm={onUndoConfirmed}
        />
      )}
      {reviewOpen && cwd && (
        <ReviewModal
          cwd={cwd}
          files={files.map((f) => f.path)}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </>
  );
}

function ConfirmUndoModal({
  fileCount,
  onCancel,
  onConfirm,
}: {
  fileCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="files-changed-modal-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="files-changed-modal files-changed-modal-confirm">
        <div className="files-changed-modal-head">
          <strong>撤销 {fileCount} 个文件的改动?</strong>
        </div>
        <div className="files-changed-modal-body">
          已跟踪的文件会回滚到 HEAD,未跟踪的新文件会从磁盘删除。此操作不可撤销。
        </div>
        <div className="files-changed-modal-foot">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="files-changed-action-danger"
            onClick={onConfirm}
          >
            确认撤销
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewModal({
  cwd,
  files,
  onClose,
}: {
  cwd: string;
  files: string[];
  onClose: () => void;
}) {
  // UnifiedDiffViewer accepts a single file at a time. When the
  // summary has multiple files we render the full working-tree diff
  // and rely on the viewer's per-file blocks; otherwise scope to one.
  const scopedFile = files.length === 1 ? files[0]! : undefined;
  return (
    <div
      className="files-changed-modal-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="files-changed-modal files-changed-modal-review">
        <div className="files-changed-modal-head">
          <strong>审核改动 — {files.length} 个文件</strong>
          <button
            type="button"
            className="files-changed-modal-close"
            onClick={onClose}
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="files-changed-modal-body files-changed-modal-body-scroll">
          <UnifiedDiffViewer cwd={cwd} file={scopedFile} />
        </div>
      </div>
    </div>
  );
}
