import React, { useLayoutEffect, useMemo, useRef } from "react";

import { PanelArea } from "../panels/PanelArea";
import { QuickChatPanelHost } from "../panels/QuickChatPanelHost";
import type { DesktopBuiltinPanelAppHost } from "../panels/DesktopBuiltinPanelApp";
import {
  QUICK_CHAT_PANEL_APP_ID,
  type QuickChatPanelAppService,
} from "../panels/apps/quickChatPanelApp";
import { anchorsIn, type AnchorsByBucket } from "../chat/anchorBuckets";
import type { ImageAttachment } from "../chat/attachments";
import type { QuickChatImageComposer } from "../chat/useQuickChatImages";
import type { ModelOption } from "../chat/ModelPill";
import {
  toCorePermissionMode,
  toExternalRuntimePermission,
  type PermissionMode,
} from "../chat/PermissionPill";
import { quickChatTabKey, type QuickChatSessionRef } from "../quickChatSession";
import type { TrackedProject } from "../projects";
import type { ApprovalRequestEnvelope } from "../../preload/types";
import type { TranscriptsMap } from "../transcriptsReducer";
import { INITIAL_STATE, type AskUserAnswerHandler } from "../types";
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
  /** Only a resolved local runtime may mount a previously unseen bucket. */
  localPanelsReady?: boolean;
  /** The shared app host owns the TopBar opener used after the focused last tab closes. */
  onRestorePanelFocus?: () => void;
  projects: TrackedProject[];
  updatePanelBucket: (
    bucket: string,
    updater: (state: PanelBucketState) => PanelBucketState,
  ) => void;
  onRevealConsumed: (bucket: string, nonce: number) => void;
  onOpenCliSessionConsumed: (bucket: string, nonce: number) => void;
  panelWidth: number;
  beginPanelResize: (startX: number, startWidth: number, target: HTMLElement) => void;
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
  /** Default model for the owning Session (separate from Quick Chat's default). */
  defaultSessionModelKey: string | null;
  defaultActiveModelKey: string | null;
  quickChatDrafts: Record<string, string>;
  quickChatAttachments: Record<string, ImageAttachment[]>;
  quickChatImageComposer: (session: QuickChatSessionRef) => QuickChatImageComposer;
  modelOptions: ModelOption[];
  imageDetail: "low" | "standard" | "high" | undefined;
  setQuickChatPermission: (bucket: string, mode: PermissionMode) => void;
  setQuickChatModel: (bucket: string, model: ModelOption) => void;
  ensureQuickChatSession: (ownerBucket: string, tabId: string, cwd: string | null) => void;
  cleanupQuickChatPanelSession: (session: QuickChatSessionRef) => void;
  restartQuickChatSession: (session: QuickChatSessionRef, mode: "full" | "blank") => void;
  setQuickChatDraft: React.ComponentProps<typeof QuickChatPanelHost>["onDraftChange"];
  setQuickChatAttachmentState: React.ComponentProps<
    typeof QuickChatPanelHost
  >["onAttachmentsChange"];
  sendQuickChat: React.ComponentProps<typeof QuickChatPanelHost>["onSend"];
  stop: React.ComponentProps<typeof QuickChatPanelHost>["onStop"];
  handleAskUserAnswer: AskUserAnswerHandler;
  decideEnvelope: (
    env: ApprovalRequestEnvelope,
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ) => void;
}

interface BucketCallbacks {
  onClose: () => void;
  onRevealConsumed: (nonce: number) => void;
  onOpenCliSessionConsumed: (nonce: number) => void;
  setTabs: React.ComponentProps<typeof PanelArea>["setTabs"];
  setActiveId: React.ComponentProps<typeof PanelArea>["setActiveId"];
}

/**
 * Keeps every session-owned panel body mounted while only one dock is visible.
 *
 * App re-renders on every stream batch and composer keystroke. PanelArea is
 * memoized, so everything handed to it must keep its identity unless its value
 * changed: callbacks are stable wrappers that call the latest props.
 */
export function SessionPanelDock(props: SessionPanelDockProps) {
  // Assigned during render: the built-in app host renders Quick Chat content
  // from these props inside the same render pass.
  const latest = useRef(props);
  latest.current = props;
  const localPanelsReady = props.localPanelsReady ?? true;
  const admitted = useRef(new Map<string, string>());
  const bucketCallbacks = useRef(new Map<string, BucketCallbacks>());
  const targets = props.panelBuckets.flatMap((bucket) => {
    const { projectId } = parsePanelBucket(bucket);
    const project = projectId
      ? (props.projects.find((candidate) => candidate.id === projectId) ?? null)
      : null;
    const engineSessionId = props.resolveEngineSessionIdForBucket(bucket) ?? null;
    const identity = JSON.stringify([engineSessionId, project?.path ?? null]);
    if (projectId && !project) return [];
    const mayMount = localPanelsReady && bucket === props.activeBucket;
    if (!mayMount && admitted.current.get(bucket) !== identity) return [];
    return [{ bucket, project, engineSessionId, identity }];
  });
  // Remember only committed bodies. An abandoned ready render must not admit a
  // new bucket that a later pending/cloud render would otherwise mount.
  useLayoutEffect(() => {
    admitted.current = new Map(targets.map(({ bucket, identity }) => [bucket, identity]));
    for (const bucket of bucketCallbacks.current.keys())
      if (!admitted.current.has(bucket)) bucketCallbacks.current.delete(bucket);
  });

  const callbacksFor = (bucket: string): BucketCallbacks => {
    let callbacks = bucketCallbacks.current.get(bucket);
    if (!callbacks) {
      callbacks = {
        onClose: () =>
          latest.current.updatePanelBucket(bucket, (state) => ({
            ...state,
            open: false,
            requestNonce: state.requestNonce + 1,
            requestKind: null,
            openUrl: undefined,
            openCliSession: undefined,
          })),
        onRevealConsumed: (nonce) => latest.current.onRevealConsumed(bucket, nonce),
        onOpenCliSessionConsumed: (nonce) => latest.current.onOpenCliSessionConsumed(bucket, nonce),
        setTabs: (next) =>
          latest.current.updatePanelBucket(bucket, (state) => {
            const tabs = typeof next === "function" ? next(state.tabs) : next;
            const activeId =
              state.activeId && tabs.some((tab) => tab.id === state.activeId)
                ? state.activeId
                : (tabs[0]?.id ?? null);
            return { ...state, tabs, activeId };
          }),
        setActiveId: (next) =>
          latest.current.updatePanelBucket(bucket, (state) => ({
            ...state,
            activeId: typeof next === "function" ? next(state.activeId) : next,
          })),
      };
      bucketCallbacks.current.set(bucket, callbacks);
    }
    return callbacks;
  };

  const shared = useMemo(
    () => ({
      onRestoreFocus: () => latest.current.onRestorePanelFocus?.(),
      onResizeStart: (startX: number, startWidth: number, target: HTMLElement) =>
        latest.current.beginPanelResize(startX, startWidth, target),
      onAttachImage: (path: string) => latest.current.onAttachImage(path),
      removeAnchor: (id: string) => latest.current.removeAnchor(id),
      updateAnchorComment: (id: string, comment: string) =>
        latest.current.updateAnchorComment(id, comment),
    }),
    [],
  );

  const builtinPanelAppHost = useMemo<DesktopBuiltinPanelAppHost>(
    () => ({
      getService(appId) {
        if (appId !== QUICK_CHAT_PANEL_APP_ID) return undefined;
        const service: QuickChatPanelAppService = {
          ensure: ({ bucket: ownerBucket, tabId, cwd }) => {
            latest.current.ensureQuickChatSession(ownerBucket, tabId, cwd);
          },
          release: ({ bucket: ownerBucket, tabId }) => {
            const props = latest.current;
            const session = props.quickChatSessions[quickChatTabKey(ownerBucket, tabId)];
            if (session) props.cleanupQuickChatPanelSession(session);
          },
          render: (context) => {
            const props = latest.current;
            const ownerBucket = context.bucket;
            const { tabId, cwd } = context;
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
                imageComposer={session ? props.quickChatImageComposer(session) : undefined}
                permissionMode={permissionMode}
                modelOptions={props.modelOptions}
                activeModelKey={activeModelKey}
                imageDetail={props.imageDetail}
                onPermissionChange={props.setQuickChatPermission}
                onModelChange={props.setQuickChatModel}
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
          },
        };
        return service;
      },
    }),
    [],
  );

  // Quick Chat content depends on App state the host reads from `latest`.
  // A bucket that owns a Quick Chat session re-renders with every dock render,
  // as before; every other bucket re-renders only when its own props change.
  const quickChatOwners = new Set(
    Object.values(props.quickChatSessions).map((session) => session.ownerBucket),
  );
  const renderToken = {};

  return targets.map((target) => {
    const {
      bucket: panelBucket,
      project: panelProject,
      engineSessionId: panelEngineSessionId,
      identity,
    } = target;
    const panelState = props.panelByBucket[panelBucket] ?? emptyPanelBucketState();
    const isActivePanelBucket = panelBucket === props.activeBucket;
    const hidden =
      !localPanelsReady || !isActivePanelBucket || !props.isChatView || !panelState.open;
    const keepActiveBodyLive =
      panelState.open && (!localPanelsReady || !isActivePanelBucket || !props.isChatView);
    const uiPermissionMode =
      props.permissionOverrides[panelBucket] ?? props.defaultPermissionMode ?? "default";
    // Same derivation as the chat send in useRunController: main keys external
    // runtime reuse on these values, so a Panel submission that computed them
    // differently would restart the live Codex/Claude thread.
    const panelPermission = toExternalRuntimePermission(toCorePermissionMode(uiPermissionMode));
    const panelHasGoal = Boolean(props.transcripts[panelBucket]?.activeGoal);
    const callbacks = callbacksFor(panelBucket);

    return (
      <PanelArea
        key={JSON.stringify([panelBucket, identity])}
        hidden={hidden}
        keepActiveBodyLive={keepActiveBodyLive}
        onRestoreFocus={props.onRestorePanelFocus ? shared.onRestoreFocus : undefined}
        projectPath={panelProject?.path ?? null}
        project={panelProject}
        onClose={callbacks.onClose}
        requestNonce={panelState.requestNonce}
        requestKind={panelState.requestKind}
        reviewFiles={panelState.reviewFiles}
        reviewDiff={panelState.reviewDiff}
        revealFile={panelState.revealFile}
        onRevealConsumed={callbacks.onRevealConsumed}
        openUrl={panelState.openUrl}
        openCliSession={panelState.openCliSession}
        subagentSelection={panelState.subagentSelection}
        onOpenCliSessionConsumed={callbacks.onOpenCliSessionConsumed}
        width={props.panelWidth}
        onResizeStart={shared.onResizeStart}
        onAttachImage={shared.onAttachImage}
        browserAnchors={anchorsIn(props.anchorsByBucket, panelBucket)}
        onRemoveBrowserAnchor={isActivePanelBucket ? shared.removeAnchor : undefined}
        onUpdateBrowserAnchor={isActivePanelBucket ? shared.updateAnchorComment : undefined}
        engineSessionId={panelEngineSessionId}
        busy={props.busyKeys.has(panelBucket)}
        modelKey={props.modelOverrides[panelBucket] ?? props.defaultSessionModelKey}
        permissionMode={panelPermission.permissionMode}
        planMode={panelPermission.planMode}
        hasGoal={panelHasGoal}
        tabs={panelState.tabs}
        setTabs={callbacks.setTabs}
        activeId={panelState.activeId}
        setActiveId={callbacks.setActiveId}
        builtinPanelAppHost={builtinPanelAppHost}
        builtinContentToken={quickChatOwners.has(panelBucket) ? renderToken : undefined}
        bucket={panelBucket}
      />
    );
  });
}
