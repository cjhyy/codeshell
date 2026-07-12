import React, { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { MessageStream } from "../MessageStream";
import type { Message } from "../types";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import type { ApproveChoice, ApprovePathScope } from "../approvals/approvalDecision";
import { ApprovalCard } from "../approvals/ApprovalCard";
import { useT } from "../i18n/I18nProvider";
import { MessageSquare, Send, Square } from "../ui/icons";
import type { QuickChatContextMode, QuickChatCreationStatus } from "../quickChatSession";
import { PermissionPill, type PermissionMode } from "../chat/PermissionPill";

interface Props {
  sessionId: string;
  messages: Message[];
  turnEpoch?: number;
  liveTurnActive?: boolean;
  cwd?: string | null;
  busy: boolean;
  creationStatus: QuickChatCreationStatus;
  creationError?: string;
  contextMode: QuickChatContextMode;
  sourceTitle?: string;
  draft: string;
  permissionMode: PermissionMode;
  onPermissionChange: (mode: PermissionMode) => void;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onUseBlank: () => void;
  onAskUserAnswer?: (requestId: string, answer: string) => void;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ) => void;
}

export function QuickChatPanel({
  sessionId,
  messages,
  turnEpoch,
  liveTurnActive,
  cwd,
  busy,
  creationStatus,
  creationError,
  contextMode,
  sourceTitle,
  draft,
  permissionMode,
  onPermissionChange,
  onDraftChange,
  onSend,
  onStop,
  onRetry,
  onUseBlank,
  onAskUserAnswer,
  pendingApproval,
  onApprovalDecide,
}: Props) {
  const { t } = useT();
  const [sendEpoch, setSendEpoch] = useState(0);
  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && !busy && creationStatus === "ready";

  const submit = (): void => {
    if (!canSend) return;
    onSend(trimmed);
    onDraftChange("");
    setSendEpoch((n) => n + 1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {t("panels.quickChat.title")}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {contextMode === "full" && sourceTitle
              ? t("panels.quickChat.fromSource", { title: sourceTitle })
              : sessionId}
            {contextMode === "full" ? ` · ${t("panels.quickChat.sharedWorkspace")}` : ""}
          </div>
        </div>
        {(busy || creationStatus === "creating") && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
        )}
      </div>

      {creationStatus === "error" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
          <div className="space-y-3 text-sm">
            <p className="text-status-err">{creationError ?? t("panels.quickChat.forkFailed")}</p>
            <div className="flex justify-center gap-2">
              <button type="button" className="rounded-md border px-3 py-1.5" onClick={onRetry}>
                {t("panels.quickChat.retryFork")}
              </button>
              <button type="button" className="rounded-md border px-3 py-1.5" onClick={onUseBlank}>
                {t("panels.quickChat.useBlank")}
              </button>
            </div>
          </div>
        </div>
      ) : creationStatus === "creating" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>{t("panels.quickChat.forking")}</p>
            {contextMode === "full" && (
              <button type="button" className="rounded-md border px-3 py-1.5" onClick={onUseBlank}>
                {t("panels.quickChat.useBlank")}
              </button>
            )}
          </div>
        </div>
      ) : messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center">
          <div className="text-sm text-muted-foreground">{t("panels.quickChat.empty")}</div>
        </div>
      ) : (
        <MessageStream
          messages={messages}
          turnEpoch={turnEpoch}
          engineSessionId={sessionId}
          liveTurnActive={liveTurnActive}
          onAskUserAnswer={onAskUserAnswer}
          trailing={
            pendingApproval && onApprovalDecide ? (
              <ApprovalCard envelope={pendingApproval} onDecide={onApprovalDecide} />
            ) : null
          }
          trailingKey={pendingApproval?.requestId ?? null}
          cwd={cwd}
          sendEpoch={sendEpoch}
        />
      )}

      <div className="shrink-0 border-t border-border p-3">
        <div className="rounded-xl border bg-card p-2 shadow-sm">
          <Textarea
            value={draft}
            disabled={creationStatus !== "ready"}
            placeholder={t("panels.quickChat.placeholder")}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
              e.preventDefault();
              submit();
            }}
            className="max-h-36 min-h-20 resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <PermissionPill
              value={permissionMode}
              onChange={onPermissionChange}
              disabled={creationStatus !== "ready" || busy}
              labelKeyOverrides={{ plan: "panels.quickChat.restrictedAccess" }}
            />
            {busy ? (
              <button
                type="button"
                aria-label={t("panels.quickChat.stop")}
                title={t("panels.quickChat.stop")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/80 bg-transparent text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15"
                onClick={onStop}
              >
                <Square className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                aria-label={t("panels.quickChat.send")}
                title={t("panels.quickChat.send")}
                disabled={!canSend}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-primary/40 bg-transparent text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15 disabled:pointer-events-none disabled:opacity-50"
                onClick={submit}
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
