import React from "react";
import type { Message } from "../types";
import type { ApprovalRequestEnvelope, InputAttachmentMeta } from "../../preload/types";
import type { ApproveChoice, ApprovePathScope } from "../approvals/approvalDecision";
import { useT } from "../i18n/I18nProvider";
import { MessageSquare } from "../ui/icons";
import type { QuickChatContextMode, QuickChatCreationStatus } from "../quickChatSession";
import type { PermissionMode } from "../chat/PermissionPill";
import type { ModelOption } from "../chat/ModelPill";
import type { ImageAttachment } from "../chat/attachments";
import type { ImageDetail } from "../chat/compress";
import { ChatView } from "../ChatView";

interface Props {
  /** Test seam for rendering the real child despite Bun's process-wide module mocks. */
  chatComponent?: React.ComponentType<React.ComponentProps<typeof ChatView>>;
  sessionId: string;
  creationNonce: string;
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
  attachments: ImageAttachment[];
  permissionMode: PermissionMode;
  modelOptions: ModelOption[];
  activeModelKey: string | null;
  imageDetail?: ImageDetail;
  onPermissionChange: (mode: PermissionMode) => void;
  onModelChange: (option: ModelOption) => void;
  onDraftChange: React.Dispatch<React.SetStateAction<string>>;
  onAttachmentsChange: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  onSend: (
    text: string,
    opts?: { attachments?: InputAttachmentMeta[]; displayText?: string },
  ) => void;
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
  chatComponent: ChatComponent = ChatView,
  sessionId,
  creationNonce,
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
  attachments,
  permissionMode,
  modelOptions,
  activeModelKey,
  imageDetail,
  onPermissionChange,
  onModelChange,
  onDraftChange,
  onAttachmentsChange,
  onSend,
  onStop,
  onRetry,
  onUseBlank,
  onAskUserAnswer,
  pendingApproval,
  onApprovalDecide,
}: Props) {
  const { t } = useT();

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
      ) : (
        <div className="min-h-0 flex-1">
          <ChatComponent
            variant="quickChat"
            messages={messages}
            turnEpoch={turnEpoch}
            engineSessionId={sessionId}
            liveTurnActive={liveTurnActive}
            onSend={onSend}
            onStop={onStop}
            busy={busy}
            activeProjectId={null}
            onAskUserAnswer={onAskUserAnswer}
            pendingApproval={pendingApproval}
            onApprovalDecide={onApprovalDecide}
            permissionMode={permissionMode}
            onPermissionChange={onPermissionChange}
            goalEnabled={false}
            onGoalToggle={() => undefined}
            modelOptions={modelOptions}
            activeModelKey={activeModelKey}
            onModelChange={onModelChange}
            contextTokens={0}
            projects={[]}
            onSelectProject={() => undefined}
            onAddProject={() => undefined}
            activeProjectPath={cwd ?? null}
            messageCwd={cwd}
            welcomeNode={
              <div className="text-sm text-muted-foreground">{t("panels.quickChat.empty")}</div>
            }
            draft={draft}
            onDraftChange={onDraftChange}
            attachments={attachments}
            onAttachmentsChange={onAttachmentsChange}
            onPrepareAttachmentSession={() =>
              cwd ? { cwd, sessionId, quickChatClaimId: creationNonce } : null
            }
            imageDetail={imageDetail}
          />
        </div>
      )}
    </div>
  );
}
