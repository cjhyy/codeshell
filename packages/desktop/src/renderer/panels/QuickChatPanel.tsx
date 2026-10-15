import React, { useState } from "react";
import type { Message } from "../types";
import type { ApprovalRequestEnvelope, InputAttachmentMeta } from "../../preload/types";
import type { ApproveChoice, ApprovePathScope } from "../approvals/approvalDecision";
import { useT } from "../i18n/I18nProvider";
import { MessageSquare } from "../ui/icons";
import { AlertCircle, ArrowUpRight, GitBranch, Loader2, MessageCircle } from "lucide-react";
import { Button } from "../components/ui/button";
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
  copiedEventCount?: number;
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
  onAskUserAnswer?: (requestId: string, answer: string) => void | Promise<void>;
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
  copiedEventCount,
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
  const [starter, setStarter] = useState({ text: "", nonce: 0 });
  const contextLabel =
    contextMode === "full" && copiedEventCount === 0
      ? t("panels.quickChat.noInheritedContext")
      : contextMode === "full" && sourceTitle
        ? t("panels.quickChat.fromSource", { title: sourceTitle })
        : t(
            contextMode === "full"
              ? "panels.quickChat.sourceContext"
              : "panels.quickChat.independentContext",
          );
  const starters = [
    { label: t("panels.quickChat.explain"), prompt: t("panels.quickChat.explainPrompt") },
    { label: t("panels.quickChat.compare"), prompt: t("panels.quickChat.comparePrompt") },
    { label: t("panels.quickChat.brainstorm"), prompt: t("panels.quickChat.brainstormPrompt") },
  ];

  return (
    <div className="cs-quick-chat flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex shrink-0 items-start gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/5 text-primary">
          <MessageSquare size={17} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {t("panels.quickChat.title")}
            </h2>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("panels.quickChat.temporary")}
            </span>
          </div>
          <div
            className="mt-1 truncate text-[11px] leading-4 text-muted-foreground"
            title={contextLabel}
          >
            {contextLabel}
          </div>
          {contextMode === "full" && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <GitBranch size={11} aria-hidden="true" />
              {t("panels.quickChat.sharedWorkspace")}
            </div>
          )}
        </div>
        {(busy || creationStatus === "creating") && (
          <span role="status" className="mt-1.5 shrink-0 text-muted-foreground">
            <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            <span className="sr-only">
              {t(
                creationStatus === "creating"
                  ? "panels.quickChat.loading"
                  : "panels.quickChat.responding",
              )}
            </span>
          </span>
        )}
      </div>

      {creationStatus === "error" ? (
        <div className="cs-quick-chat-state">
          <div className="cs-quick-chat-state-card">
            <AlertCircle size={24} className="mx-auto text-status-err" aria-hidden="true" />
            <h3 className="mt-4 text-sm font-medium text-foreground">
              {t("panels.quickChat.forkFailed")}
            </h3>
            <p role="alert" className="mt-2 break-words text-xs leading-5 text-muted-foreground">
              {creationError ?? t("panels.quickChat.forkFailedHint")}
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button type="button" size="sm" onClick={onRetry}>
                {t("panels.quickChat.retryFork")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={onUseBlank}>
                {t("panels.quickChat.useBlank")}
              </Button>
            </div>
          </div>
        </div>
      ) : creationStatus === "creating" ? (
        <div className="cs-quick-chat-state">
          <div className="cs-quick-chat-state-card">
            <Loader2 size={24} className="mx-auto animate-spin text-primary" aria-hidden="true" />
            <p role="status" className="mt-4 text-sm leading-6 text-muted-foreground">
              {t("panels.quickChat.forking")}
            </p>
            {contextMode === "full" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-5"
                onClick={onUseBlank}
              >
                {t("panels.quickChat.useBlank")}
              </Button>
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
            configurationTarget={{ sessionId }}
            configurationAvailable={Boolean(cwd)}
            conversationRoot={cwd ?? null}
            conversationRootId={null}
            welcomeNode={
              <div className="cs-quick-chat-intro">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-border/70 bg-card text-primary shadow-sm">
                  <MessageCircle size={23} strokeWidth={1.5} aria-hidden="true" />
                </div>
                <h3 className="text-base font-semibold tracking-tight text-foreground">
                  {t("panels.quickChat.empty")}
                </h3>
                <p className="mx-auto mt-2 max-w-64 text-xs leading-5 text-muted-foreground">
                  {t("panels.quickChat.emptyHint")}
                </p>
                <div
                  className="mt-5 flex flex-wrap justify-center gap-2"
                  role="group"
                  aria-label={t("panels.quickChat.starters")}
                >
                  {starters.map(({ label, prompt }) => (
                    <button
                      key={label}
                      type="button"
                      className="cs-quick-chat-starter"
                      disabled={busy}
                      onClick={() =>
                        setStarter((current) => ({ text: prompt, nonce: current.nonce + 1 }))
                      }
                    >
                      {label}
                      <ArrowUpRight size={12} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            }
            composerSeed={starter.text}
            composerSeedNonce={starter.nonce}
            onComposerSeedConsumed={(nonce) =>
              setStarter((current) =>
                current.nonce === nonce ? { ...current, text: "" } : current,
              )
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
