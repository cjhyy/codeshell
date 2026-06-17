import React, { memo, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown, RotateCcw, RotateCw, Eye, X } from "lucide-react";
import type { FilesChangedSummaryMessage } from "../types";
import type { TurnUndoResult } from "../../preload/types";
import { basename } from "../tool-cards/utils";
import { UnifiedDiffViewer } from "../diff/UnifiedDiffViewer";
import { openFileTarget } from "../chat/openWith";
import { Button } from "@/components/ui/button";
import { useT, type TFunction } from "../i18n/I18nProvider";

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
  const { t } = useT();
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

  const summarize = (kind: "undo" | "redo", results: TurnUndoResult[]): string => {
    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      return t("msg.files.partialFailure", {
        failed: failures.length,
        total: results.length,
        name: basename(failures[0]!.filePath),
      });
    }
    return kind === "undo"
      ? t("msg.files.undoneFiles", { count: results.length })
      : t("msg.files.redoneFiles", { count: results.length });
  };

  const onUndoConfirmed = async (): Promise<void> => {
    if (!sessionId) return;
    setConfirmUndo(false);
    setUndoing(true);
    setUndoStatus(null);
    try {
      const results = await window.codeshell.undoTurn(sessionId);
      setUndone(true);
      setUndoStatus(summarize("undo", results));
    } catch (e: unknown) {
      setUndoStatus(t("msg.files.undoFailed", { error: String(e instanceof Error ? e.message : e) }));
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
      setUndoStatus(summarize("redo", results));
    } catch (e: unknown) {
      setUndoStatus(t("msg.files.redoFailed", { error: String(e instanceof Error ? e.message : e) }));
    } finally {
      setUndoing(false);
      window.clearTimeout(clearStatusTimer.current);
      clearStatusTimer.current = window.setTimeout(() => setUndoStatus(null), 4000);
    }
  };

  return (
    <>
      <div className="px-3 py-2">
        <div className={`rounded-lg border bg-card p-3 shadow-sm${open ? " open" : ""}`}>
          <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-w-0 flex-1 justify-start gap-2 p-0 text-left hover:bg-transparent"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="font-medium text-foreground">{t("msg.files.editedCount", { count: files.length })}</span>
            <span className="shrink-0 text-xs tabular-nums">
              <span className="text-status-ok">+{totalAdded}</span>
              <span className="text-status-err">-{totalRemoved}</span>
            </span>
          </Button>
          {(canReview || canUndo || (!!sessionId && files.length > 0)) && (
            <div className="flex h-7 items-center gap-1">
              {canReview && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
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
                  aria-label={t("msg.files.reviewAria")}
                  title={t("msg.files.reviewTitle")}
                >
                  <Eye size={12} />
                  <span>{t("msg.files.review")}</span>
                </Button>
              )}
              {/* Undo / Redo toggle — only the latest turn is interactive.
                  An older card shows a disabled undo explaining it can only
                  peel from the newest turn. */}
              {!!sessionId && files.length > 0 && !isLatest && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled
                  aria-label={t("msg.files.undoDisabledAria")}
                  title={t("msg.files.undoDisabledTitle")}
                >
                  <RotateCcw size={12} />
                  <span>{t("msg.files.undo")}</span>
                </Button>
              )}
              {canUndo && !undone && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs text-status-err hover:text-status-err"
                  onClick={() => setConfirmUndo(true)}
                  disabled={undoing}
                  aria-label={t("msg.files.undoAria")}
                  title={t("msg.files.undoTitle")}
                >
                  <RotateCcw size={12} />
                  <span>{undoing ? t("msg.files.undoing") : t("msg.files.undo")}</span>
                </Button>
              )}
              {canUndo && undone && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => void onRedo()}
                  disabled={undoing}
                  aria-label={t("msg.files.redoAria")}
                  title={t("msg.files.redoTitle")}
                >
                  <RotateCw size={12} />
                  <span>{undoing ? t("msg.files.redoing") : t("msg.files.redo")}</span>
                </Button>
              )}
            </div>
          )}
        </div>
        {undoStatus && (
          <div className="mt-2 rounded bg-muted/40 p-2 text-xs text-muted-foreground">{undoStatus}</div>
        )}
        {open && (
          <div className="mt-2 flex flex-col gap-1">
            {visible.map((f) => (
              <div key={f.path} className="flex items-center gap-2 rounded px-2 py-1 text-xs">
                <a
                  href="#"
                  className="min-w-0 flex-1 truncate font-mono"
                  title={f.path}
                  onClick={(e) => openFileTarget(e, { path: f.path, cwd })}
                >
                  {basename(f.path)}
                </a>
                <span className="text-status-ok">+{f.added}</span>
                <span className="text-status-err">-{f.removed}</span>
              </div>
            ))}
            {remaining > 0 && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="mt-1 h-auto justify-start p-0 text-xs"
                onClick={() => setShowAll(true)}
              >
                {t("msg.files.showMore", { count: remaining })}
              </Button>
            )}
          </div>
        )}
        </div>
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
  const { t } = useT();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-2xl max-w-md">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <strong>{t("msg.files.confirmTitle", { count: fileCount })}</strong>
        </div>
        <div className="p-4">
          {t("msg.files.confirmBody")}
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t("msg.files.cancel")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-status-err hover:text-status-err"
            onClick={onConfirm}
          >
            {t("msg.files.confirmUndo")}
          </Button>
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
  const { t } = useT();
  // When the card carries session-scoped diffs, render those directly
  // instead of asking Git for the whole worktree. The scopedFile fallback
  // keeps older persisted messages working.
  const scopedFile = files.length === 1 ? files[0]! : undefined;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-2xl max-w-5xl">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <strong>{t("msg.files.reviewModalTitle", { count: files.length })}</strong>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label={t("msg.files.close")}
          >
            <X size={14} />
          </Button>
        </div>
        <div className="p-4 max-h-[70vh] overflow-y-auto">
          <UnifiedDiffViewer cwd={cwd} file={scopedFile} diffText={diffText} />
        </div>
      </div>
    </div>
  );
}
