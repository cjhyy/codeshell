import React from "react";

import { PanelArea } from "../panels/PanelArea";
import { QuickChatPanelHost } from "../panels/QuickChatPanelHost";
import { anchorsIn, type AnchorsByBucket } from "../chat/anchorBuckets";
import type { ImageAttachment } from "../chat/attachments";
import type { ModelOption } from "../chat/ModelPill";
import type { PermissionMode } from "../chat/PermissionPill";
import { quickChatTabKey, type QuickChatSessionRef } from "../quickChatSession";
import type { TrackedProject } from "../projects";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import type { TranscriptsMap } from "../transcriptsReducer";
import { INITIAL_STATE } from "../types";
import type { ApproveChoice, ApprovePathScope } from "../approvals/approvalDecision";
import {
  emptyPanelBucketState,
  EMPTY_ATTACHMENTS,
  parsePanelBucket,
  type PanelBucketState,
} from "./appUtils";

interface SessionPanelDockProps {
  panelBuckets: string[];
  panelByBucket: Record<string, PanelBucketState>;
  activeBucket: string;
  isChatView: boolean;
  projects: TrackedProject[];
  updatePanelBucket: (
    bucket: string,
    updater: (state: PanelBucketState) => PanelBucketState,
  ) => void;
  onRevealConsumed: (bucket: string, nonce: number) => void;
  onOpenCliSessionConsumed: (bucket: string, nonce: number) => void;
  panelWidth: number;
  beginPanelResize: (startX: number, startWidth: number) => void;
  onAttachImage: (path: string) => void;
  anchorsByBucket: AnchorsByBucket;
  removeAnchor: (id: string) => void;
  updateAnchorComment: (id: string, comment: string) => void;
  resolveEngineSessionIdForBucket: (bucket: string) => string | undefined;
  quickChatSessions: Record<string, QuickChatSessionRef>;
  transcripts: TranscriptsMap;
  busyKeys: Set<string>;
  approvalForBucket: (bucket: string) => ApprovalRequestEnvelope | null;
  noRepoCwd: string | null;
  permissionOverrides: Record<string, PermissionMode>;
  defaultPermissionMode: PermissionMode | null;
  modelOverrides: Record<string, string>;
  defaultActiveModelKey: string | null;
  quickChatDrafts: Record<string, string>;
  quickChatAttachments: Record<string, ImageAttachment[]>;
  modelOptions: ModelOption[];
  imageDetail: "low" | "standard" | "high" | undefined;
  setQuickChatPermission: (bucket: string, mode: PermissionMode) => void;
  setQuickChatModel: (bucket: string, model: ModelOption) => void;
  ensureQuickChatSession: (ownerBucket: string, tabId: string, cwd: string | null) => void;
  restartQuickChatSession: (
    session: QuickChatSessionRef,
    mode: "full" | "blank",
  ) => void;
  setQuickChatDraft: React.ComponentProps<typeof QuickChatPanelHost>["onDraftChange"];
  setQuickChatAttachmentState: React.ComponentProps<
    typeof QuickChatPanelHost
  >["onAttachmentsChange"];
  sendQuickChat: React.ComponentProps<typeof QuickChatPanelHost>["onSend"];
  stop: React.ComponentProps<typeof QuickChatPanelHost>["onStop"];
  handleAskUserAnswer: (requestId: string, answer: string) => void;
  decideEnvelope: (
    env: ApprovalRequestEnvelope,
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ) => void;
}

/** Keeps every session-owned panel body mounted while only one dock is visible. */
export function SessionPanelDock(props: SessionPanelDockProps) {
  return props.panelBuckets.map((panelBucket) => {
    const panelState = props.panelByBucket[panelBucket] ?? emptyPanelBucketState();
    const isActivePanelBucket = panelBucket === props.activeBucket;
    const { projectId } = parsePanelBucket(panelBucket);
    const panelProject = projectId
      ? (props.projects.find((project) => project.id === projectId) ?? null)
      : null;
    const panelEngineSessionId =
      props.resolveEngineSessionIdForBucket(panelBucket) ?? null;
    const hidden = !isActivePanelBucket || !props.isChatView || !panelState.open;
    const keepActiveBodyLive =
      panelState.open && (!isActivePanelBucket || !props.isChatView);

    return (
      <PanelArea
        key={panelBucket}
        hidden={hidden}
        keepActiveBodyLive={keepActiveBodyLive}
        projectPath={panelProject?.path ?? null}
        onClose={() =>
          props.updatePanelBucket(panelBucket, (state) => ({
            ...state,
            open: false,
            requestNonce: state.requestNonce + 1,
            requestKind: null,
            openUrl: undefined,
            openCliSession: undefined,
          }))
        }
        requestNonce={panelState.requestNonce}
        requestKind={panelState.requestKind}
        reviewFiles={panelState.reviewFiles}
        reviewDiff={panelState.reviewDiff}
        revealFile={panelState.revealFile}
        onRevealConsumed={(nonce) => props.onRevealConsumed(panelBucket, nonce)}
        openUrl={panelState.openUrl}
        openCliSession={panelState.openCliSession}
        onOpenCliSessionConsumed={(nonce) =>
          props.onOpenCliSessionConsumed(panelBucket, nonce)
        }
        width={props.panelWidth}
        onResizeStart={props.beginPanelResize}
        onAttachImage={props.onAttachImage}
        browserAnchors={anchorsIn(props.anchorsByBucket, panelBucket)}
        onRemoveBrowserAnchor={isActivePanelBucket ? props.removeAnchor : undefined}
        onUpdateBrowserAnchor={
          isActivePanelBucket ? props.updateAnchorComment : undefined
        }
        engineSessionId={panelEngineSessionId}
        tabs={panelState.tabs}
        setTabs={(next) =>
          props.updatePanelBucket(panelBucket, (state) => {
            const tabs = typeof next === "function" ? next(state.tabs) : next;
            const activeId =
              state.activeId && tabs.some((tab) => tab.id === state.activeId)
                ? state.activeId
                : (tabs[0]?.id ?? null);
            return { ...state, tabs, activeId };
          })
        }
        activeId={panelState.activeId}
        setActiveId={(next) =>
          props.updatePanelBucket(panelBucket, (state) => ({
            ...state,
            activeId: typeof next === "function" ? next(state.activeId) : next,
          }))
        }
        renderQuickChatPanel={({ ownerBucket, tabId, cwd }) => {
          const key = quickChatTabKey(ownerBucket, tabId);
          const session = props.quickChatSessions[key];
          const state = session
            ? (props.transcripts[session.bucket] ?? INITIAL_STATE)
            : INITIAL_STATE;
          const busy = session ? props.busyKeys.has(session.bucket) : false;
          const approval = session ? props.approvalForBucket(session.bucket) : null;
          const quickCwd = cwd ?? props.noRepoCwd;
          const permissionMode = session
            ? (props.permissionOverrides[session.bucket] ??
              props.permissionOverrides[session.ownerBucket] ??
              props.defaultPermissionMode ??
              "default")
            : (props.defaultPermissionMode ?? "default");
          const activeModelKey = session
            ? (props.modelOverrides[session.bucket] ?? props.defaultActiveModelKey)
            : props.defaultActiveModelKey;
          return (
            <QuickChatPanelHost
              ownerBucket={ownerBucket}
              tabId={tabId}
              cwd={quickCwd}
              session={session}
              state={state}
              busy={busy}
              draft={session ? (props.quickChatDrafts[session.bucket] ?? "") : ""}
              attachments={
                session
                  ? (props.quickChatAttachments[session.bucket] ?? EMPTY_ATTACHMENTS)
                  : EMPTY_ATTACHMENTS
              }
              permissionMode={permissionMode}
              modelOptions={props.modelOptions}
              activeModelKey={activeModelKey}
              imageDetail={props.imageDetail}
              onPermissionChange={props.setQuickChatPermission}
              onModelChange={props.setQuickChatModel}
              onEnsureSession={props.ensureQuickChatSession}
              onRetry={(item) => props.restartQuickChatSession(item, "full")}
              onUseBlank={(item) => props.restartQuickChatSession(item, "blank")}
              onDraftChange={props.setQuickChatDraft}
              onAttachmentsChange={props.setQuickChatAttachmentState}
              onSend={props.sendQuickChat}
              onStop={props.stop}
              onAskUserAnswer={props.handleAskUserAnswer}
              pendingApproval={approval}
              onApprovalDecide={
                approval
                  ? (decision, reason, scope, pathScope) =>
                      props.decideEnvelope(approval, decision, reason, scope, pathScope)
                  : undefined
              }
            />
          );
        }}
        bucket={panelBucket}
      />
    );
  });
}
