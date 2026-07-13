import React, { useEffect } from "react";

import type { ApprovalRequestEnvelope, InputAttachmentMeta } from "../../preload/types";
import type { ApproveChoice, ApprovePathScope } from "../approvals/approvalDecision";
import type { ImageAttachment } from "../chat/attachments";
import type { ModelOption } from "../chat/ModelPill";
import type { PermissionMode } from "../chat/PermissionPill";
import { useT } from "../i18n/I18nProvider";
import type { QuickChatSessionRef } from "../quickChatSession";
import type { MessagesReducerState } from "../types";
import { quickChatLiveTurnActive } from "../app/appUtils";
import { QuickChatPanel } from "./QuickChatPanel";

interface QuickChatPanelHostProps {
  ownerBucket: string;
  tabId: string;
  cwd: string | null;
  session?: QuickChatSessionRef;
  state: MessagesReducerState;
  busy: boolean;
  draft: string;
  attachments: ImageAttachment[];
  permissionMode: PermissionMode;
  modelOptions: ModelOption[];
  activeModelKey: string | null;
  imageDetail?: "low" | "standard" | "high";
  onPermissionChange: (bucket: string, mode: PermissionMode) => void;
  onModelChange: (bucket: string, option: ModelOption) => void;
  onEnsureSession: (ownerBucket: string, tabId: string, cwd: string | null) => void;
  onRetry: (session: QuickChatSessionRef) => void;
  onUseBlank: (session: QuickChatSessionRef) => void;
  onDraftChange: (bucket: string, next: React.SetStateAction<string>) => void;
  onAttachmentsChange: (bucket: string, next: React.SetStateAction<ImageAttachment[]>) => void;
  onSend: (
    session: QuickChatSessionRef,
    text: string,
    opts?: { attachments?: InputAttachmentMeta[]; displayText?: string },
  ) => void;
  onStop: (bucket: string) => void;
  onAskUserAnswer: (requestId: string, answer: string) => void;
  pendingApproval?: ApprovalRequestEnvelope | null;
  onApprovalDecide?: (
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ) => void;
}

export function QuickChatPanelHost({
  ownerBucket,
  tabId,
  cwd,
  session,
  state,
  busy,
  draft,
  attachments,
  permissionMode,
  modelOptions,
  activeModelKey,
  imageDetail,
  onPermissionChange,
  onModelChange,
  onEnsureSession,
  onRetry,
  onUseBlank,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  onStop,
  onAskUserAnswer,
  pendingApproval,
  onApprovalDecide,
}: QuickChatPanelHostProps) {
  const { t } = useT();
  useEffect(() => {
    onEnsureSession(ownerBucket, tabId, cwd);
  }, [cwd, onEnsureSession, ownerBucket, tabId]);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("panels.quickChat.loading")}
      </div>
    );
  }

  const effectiveCwd = session.cwd ?? cwd;

  return (
    <QuickChatPanel
      sessionId={session.sessionId}
      creationNonce={session.creationNonce}
      messages={state.messages}
      turnEpoch={state.turnEpoch}
      liveTurnActive={quickChatLiveTurnActive(state, busy)}
      cwd={effectiveCwd}
      busy={busy}
      creationStatus={session.status}
      creationError={session.error?.message}
      contextMode={session.contextMode}
      sourceTitle={session.sourceTitle}
      draft={draft}
      attachments={attachments}
      permissionMode={permissionMode}
      modelOptions={modelOptions}
      activeModelKey={activeModelKey}
      imageDetail={imageDetail}
      onPermissionChange={(mode) => onPermissionChange(session.bucket, mode)}
      onModelChange={(option) => onModelChange(session.bucket, option)}
      onDraftChange={(next) => onDraftChange(session.bucket, next)}
      onAttachmentsChange={(next) => onAttachmentsChange(session.bucket, next)}
      onSend={(text, opts) => onSend(session, text, opts)}
      onStop={() => onStop(session.bucket)}
      onRetry={() => onRetry(session)}
      onUseBlank={() => onUseBlank(session)}
      onAskUserAnswer={onAskUserAnswer}
      pendingApproval={pendingApproval}
      onApprovalDecide={onApprovalDecide}
    />
  );
}
