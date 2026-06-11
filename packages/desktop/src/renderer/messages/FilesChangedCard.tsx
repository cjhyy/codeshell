import React, { memo, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, RotateCcw, RotateCw, Eye, X } from "lucide-react";
import type { FilesChangedSummaryMessage } from "../types";
import type { TurnUndoResult } from "../../preload/types";
import { basename } from "../tool-cards/utils";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";
import { openFileTarget } from "../chat/openWith";

interface Props {
  message: FilesChangedSummaryMessage;
  /** Working directory of the owning chat. Required for review. */
  cwd: string | null;
  /** Engine session id — keys the turn-level undo/redo (FileHistory snapshots). */
  sessionId: string | null;
  /**
   * Whether this is the most recent turn's card. Only the latest turn is
   * interactive: snapshot undo peels newest-first, so an older card can't be
   * undone without first undoing the newer ones. Older cards show a disabled
   * undo with a tooltip explaining why.
   */
  isLatest: boolean;
}

const INITIAL_VISIBLE = 3;

/**
 * Codex-style per-turn summary: "已编辑 N 个文件 +X -Y" folded by
 * default; expanding shows each file path with its +/- counts.
 *
 * Header actions:
 *   - 审核 (Review) → opens a modal showing the working-tree diff scoped to
 *     this card's files.
 *   - 撤销 / 重新应用 (Undo / Redo) → turn-level, via core FileHistory snapshots
 *     (NOT git): undo reverts this turn's edits to their pre-turn state (and
 *     deletes files the turn created); redo re-applies them. Only the LATEST
 *     turn's card is interactive (snapshots peel newest-first). After undo the
 *     button flips to 重新应用; redo stays available until a new user turn.
 */
function FilesChangedCardImpl({ message, cwd, sessionId, isLatest }: Props) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoStatus, setUndoStatus] = useState<string | null>(null);
  // null = unknown / not yet queried. Reflects core's snapshot state: can this
  // turn be undone, or was it undone and can be redone?
  const [undone, setUndone] = useState(false);
  const clearStatusTimer = useRef<number | undefined>(undefined);
  // Clear the auto-dismiss timer on unmount so setUndoStatus doesn't fire on
  // an unmounted component.
  useEffect(() => () => window.clearTimeout(clearStatusTimer.current), []);

  // Seed undo/redo state from disk for the latest card (and re-seed if it
  // becomes latest). Only the latest card queries — older cards are inert.
  // This restores the correct button after a refresh/replay, where the disk
  // (FileHistory index) is the source of truth, not the ephemeral React state.
  useEffect(() => {
    if (!isLatest || !sessionId) return;
    let cancelled = false;
    void window.codeshell
      .turnUndoState(sessionId)
      .then((s) => {
        if (!cancelled) setUndone(s.redoable && !s.undoable);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLatest, sessionId]);

  const { files, totalAdded, totalRemoved } = message;
  const visible = showAll ? files : files.slice(0, INITIAL_VISIBLE);
  const remaining = files.length - visible.length;

  const sessionDiffText = message.sessionDiffs?.map((d) => d.diff).join("\n");
  const canReview = files.length > 0 && (!!cwd || !!sessionDiffText);
  // Undo/redo needs the session's FileHistory; only the latest turn is peelable.
  const canUndo = !!sessionId && files.length > 0 && isLatest;

  const summarize = (verb: string, results: TurnUndoResult[]): string => {
    const failures = results.filter((r) => !r.ok);
    return failures.length === 0
      ? `${verb} ${results.length} 个文件`
      : `部分失败:${failures.length}/${results.length}(${basename(failures[0]!.filePath)})`;
  };

  const onUndoConfirmed = async (): Promise<void> => {
    if (!sessionId) return;
    setConfirmUndo(false);
    setUndoing(true);
    setUndoStatus(null);
    try {
      const results = await window.codeshell.undoTurn(sessionId);
      setUndone(true);
      setUndoStatus(summarize("已撤销", results));
    } catch (e: unknown) {
      setUndoStatus(`撤销失败:${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setUndoing(false);
      window.clearTimeout(clearStatusTimer.current);
      clearStatusTimer.current = window.setTimeout(() => setUndoStatus(null), 4000);
    }
  };

  const onRedo = async (): Promise<void> => {
    if (!sessionId) return;
    setUndoing(true);
    setUndoStatus(null);
    try {
      const results = await window.codeshell.redoTurn(sessionId);
      setUndone(false);
      setUndoStatus(summarize("已重新应用", results));
    } catch (e: unknown) {
      setUndoStatus(`重新应用失败:${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setUndoing(false);
      window.clearTimeout(clearStatusTimer.current);
      clearStatusTimer.current = window.setTimeout(() => setUndoStatus(null), 4000);
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
          {(canReview || canUndo || (!!sessionId && files.length > 0)) && (
            <div className="files-changed-actions">
              {canReview && (
                <button
                  type="button"
                  className="files-changed-action"
                  onClick={() => {
                    // Open the docked review panel focused on this card's files
                    // (App listens for this). Fall back to the inline modal if
                    // there's no repo cwd (panel can't run git diff then).
                    if (cwd) {
                      window.dispatchEvent(
                        new CustomEvent("codeshell:review-files", {
                          // Carry the turn's own diff SNAPSHOT (sessionDiffText)
                          // so the panel can show what THIS turn changed even
                          // after the edits are later committed — git status
                          // alone would lose them (TODO 2.3a).
                          detail: { files: files.map((f) => f.path), diff: sessionDiffText },
                        }),
                      );
                    } else {
                      setReviewOpen(true);
                    }
                  }}
                  aria-label="审核改动"
                  title="审核(在面板中查看 diff)"
                >
                  <Eye size={12} />
                  <span>审核</span>
                </button>
              )}
              {/* Undo / Redo toggle — only the latest turn is interactive.
                  An older card shows a disabled undo explaining it can only
                  peel from the newest turn. */}
              {!!sessionId && files.length > 0 && !isLatest && (
                <button
                  type="button"
                  className="files-changed-action"
                  disabled
                  aria-label="撤销改动(不可用)"
                  title="只能从最新一轮开始撤销"
                >
                  <RotateCcw size={12} />
                  <span>撤销</span>
                </button>
              )}
              {canUndo && !undone && (
                <button
                  type="button"
                  className="files-changed-action files-changed-action-danger"
                  onClick={() => setConfirmUndo(true)}
                  disabled={undoing}
                  aria-label="撤销改动"
                  title="撤销这一轮的文件改动(回到该轮编辑前)"
                >
                  <RotateCcw size={12} />
                  <span>{undoing ? "撤销中…" : "撤销"}</span>
                </button>
              )}
              {canUndo && undone && (
                <button
                  type="button"
                  className="files-changed-action"
                  onClick={() => void onRedo()}
                  disabled={undoing}
                  aria-label="重新应用改动"
                  title="重新应用这一轮的文件改动"
                >
                  <RotateCw size={12} />
                  <span>{undoing ? "应用中…" : "重新应用"}</span>
                </button>
              )}
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
                  onClick={(e) => openFileTarget(e, { path: f.path, cwd })}
                >
                  {basename(f.path)}
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
      {reviewOpen && canReview && (
        <ReviewModal
          cwd={cwd ?? ""}
          files={files.map((f) => f.path)}
          diffText={sessionDiffText}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </>
  );
}

export const FilesChangedCard = memo(FilesChangedCardImpl);

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
          这些文件会还原到该轮编辑前的内容,本轮新建的文件会被删除。撤销后可「重新应用」。
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
  diffText,
  onClose,
}: {
  cwd: string;
  files: string[];
  diffText?: string;
  onClose: () => void;
}) {
  // When the card carries session-scoped diffs, render those directly
  // instead of asking Git for the whole worktree. The scopedFile fallback
  // keeps older persisted messages working.
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
          <UnifiedDiffViewer cwd={cwd} file={scopedFile} diffText={diffText} />
        </div>
      </div>
    </div>
  );
}
