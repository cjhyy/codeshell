import type { SessionManager } from "@cjhyy/code-shell-core";
import { petRemoteMemoryContext } from "../pet/pet-memory-host.js";
import { taskInboxEnabled } from "../task-inbox/task-host-reads.js";
import { AgentBridge, resolveNoRepoCwd } from "../agent-bridge.js";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import { type PetNoticeWiring } from "../pet/pet-notice-wiring.js";
import { wireMimiNoticeTools } from "../pet/pet-mimi-notice-tools.js";
import { archivePetSessionsBySelector } from "../pet/pet-session-archive.js";
import { materializeOutgoingAttachments } from "@cjhyy/code-shell-chat";
import { type SessionBridgeWiring } from "../pet/session-bridge-wiring.js";
import { createPetExternalRuntime } from "../pet/pet-external-runtime.js";
import { taskInboxPetView } from "../task-inbox/task-inbox-pet-view.js";
import type {
  MimiShellOptions,
  NativeMimiHost,
  MimiBoundTasks,
  MimiFollowUps,
  MimiSegments,
} from "./mimi-shell-types.js";
export function connectMimiDispatch({
  desktopHost,
  bridge,
  options,
  sessionStore,
  segments,
  followUpRuntime,
  mimiNoticeTools,
  notices,
  aggregator,
  longTaskStore,
  longTaskCoordinator,
  sessionBridge,
}: {
  desktopHost: Pick<NativeMimiHost, "mimiDispatch">;
  bridge: AgentBridge;
  options: MimiShellOptions;
  sessionStore: SessionManager;
  segments: MimiSegments;
  followUpRuntime: MimiFollowUps;
  mimiNoticeTools: ReturnType<typeof wireMimiNoticeTools>;
  notices: PetNoticeWiring;
  aggregator: NativeMimiHost["mimiProjection"];
  longTaskStore: NativeMimiHost["mimiTasks"];
  longTaskCoordinator: MimiBoundTasks;
  sessionBridge: SessionBridgeWiring;
}) {
  const { petFollowUps, followUpHost } = followUpRuntime;
  const {
    externalRuntime,
    taskInboxService,
    stopMobileRemote,
    startMobileRemote,
    listAllDiskSessions,
    archiveDiskSession,
    inspectKnownReplyAttachments,
    imGatewayService,
    getMobileRemoteGatewayStatus,
    mobileOrchestrator,
    knownReplyAttachmentCwds,
  } = options;
  return desktopHost.mimiDispatch.configure({
    worker: bridge,
    hostCwd: resolveNoRepoCwd(),
    externalRuntime: createPetExternalRuntime({
      service: () => externalRuntime.service,
      cwd: resolveNoRepoCwd(),
    }),
    segmentController: {
      requestContextClear: async () => {
        if (!segments.controller) throw new Error("Pet work-memory sink is not ready");
        await segments.controller.requestContextClear();
      },
      beginTurn: async (clientMessageId) => segments.controller?.beginTurn(clientMessageId),
      completeSegmentClosure: (closed) =>
        segments.controller?.completeSegmentClosure(closed) ?? Promise.resolve(),
      onDelegationClosed: (closure) =>
        segments.controller?.onDelegationClosed(closure) ?? Promise.resolve(),
    },
    validateFollowUpContinuation: followUpRuntime.validateContinuation,
    taskInbox: async () => {
      if (!taskInboxService || !taskInboxEnabled()) throw new Error("Task inbox is unavailable");
      return taskInboxPetView(await taskInboxService.reconcile());
    },
    // Atomic CodeShell capabilities Mimi may request via her host-action
    // tools; each runs only after her turn, and the real outcome is folded
    // into the reply. The key set gates which tools the worker exposes.
    recentProactive: mimiNoticeTools.recentProactive,
    noticeTurns: mimiNoticeTools.turnGate,
    hostActions: {
      ...mimiNoticeTools.hostActions,
      mobileRemote: async (payload) => {
        if (payload.action === "close") {
          await stopMobileRemote();
          return { action: "close" };
        }
        if (payload.action !== "open") throw new Error("invalid mobile-remote request");
        const opened = await startMobileRemote({ mode: "tunnel" });
        return {
          action: "open",
          url: opened.url,
          pairingUrl: opened.pairingUrl,
          expiresAt: opened.expiresAt,
        };
      },
      // A notice rule for the asking conversation (an active long task keeps reporting).
      sessionWatch: notices.sessionWatch({
        refreshCatalog: () => aggregator.refreshCatalog(false),
        sessions: () => aggregator.getSnapshot().sessions,
        longTasks: {
          activeForSession: (sessionId) => longTaskStore.activeForSession(sessionId),
          watchSession: (input) => longTaskCoordinator.watchSession(input),
          reconcileNow: () => longTaskCoordinator.reconcileNow(),
        },
        goals: sessionStore,
      }),
      followUpMutation: followUpHost,
      sessionBind: async (payload, context) =>
        sessionBridge
          ? sessionBridge.sessionBindExecutor(payload, context)
          : Promise.reject(new Error("session bridge is unavailable")),
      sessionArchive: async (payload) => {
        if (payload.action !== "archive" || !Array.isArray(payload.sessionIds)) {
          throw new Error("invalid session archive request");
        }
        const selectors = payload.sessionIds.filter(
          (value): value is string => typeof value === "string",
        );
        if (selectors.length !== payload.sessionIds.length) {
          throw new Error("invalid session archive request");
        }
        return archivePetSessionsBySelector({
          selectors,
          // By-id archive must not be limited to a page of recent sessions.
          listSessions: listAllDiskSessions,
          archiveSession: archiveDiskSession,
          refreshCatalog: () => aggregator.refreshCatalog(true, { full: true }),
        });
      },
      outboundMessage: async (payload) => {
        const targetId = typeof payload.targetId === "string" ? payload.targetId : "";
        const text = typeof payload.text === "string" ? payload.text : "";
        const paths = Array.isArray(payload.attachmentPaths) ? payload.attachmentPaths : [];
        if (
          !targetId ||
          !text.trim() ||
          paths.length > 4 ||
          !paths.every((path) => typeof path === "string")
        ) {
          throw new Error("invalid outbound message request");
        }
        const attachmentMetadata = await inspectKnownReplyAttachments(paths as string[]);
        const attachments = await materializeOutgoingAttachments(attachmentMetadata);
        const target = await imGatewayService.sendOwnerMessage(targetId, text, attachments);
        return {
          targetId: target.id,
          channel: target.channel,
          label: target.label,
          accepted: true,
          // Carry the delivered body back so the Mimi bubble can show what was
          // actually sent instead of a bare receipt. Only reached once
          // sendOwnerMessage resolved, so this text is what the platform took.
          text: text.trim(),
          ...(attachments.length > 0 ? { attachmentCount: attachments.length } : {}),
        };
      },
      gatewayReply: async (payload) => {
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        const button = payload.button;
        const paths = Array.isArray(payload.attachmentPaths) ? payload.attachmentPaths : [];
        if (
          paths.length > 4 ||
          !paths.every((path) => typeof path === "string") ||
          !text ||
          (button !== undefined &&
            (!button ||
              typeof button !== "object" ||
              Array.isArray(button) ||
              typeof (button as Record<string, unknown>).text !== "string" ||
              typeof (button as Record<string, unknown>).url !== "string"))
        ) {
          throw new Error("invalid Gateway reply request");
        }
        const attachments = await inspectKnownReplyAttachments(paths as string[]);
        return {
          text,
          ...(button ? { button } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        };
      },
    },
    remoteContext: () => petRemoteMemoryContext(getMobileRemoteGatewayStatus()),
    listWorkspaces: () => mobileOrchestrator.projectList(),
    listFollowUps: (model) =>
      petFollowUps.listOpen({ allowGenerate: !parseExternalRuntimeModelKey(model) }),
    listOutboundTargets: async () =>
      imGatewayService.listOwnerMessageTargets().map((target) => ({
        id: target.id,
        channel: target.channel,
        label: target.label,
        maxTextLength: target.maxTextLength,
        attachments: target.attachments,
        maxAttachments: target.maxAttachments,
        maxAttachmentBytes: target.maxAttachmentBytes,
        // Mimi labels an unproven WeChat context instead of the host hiding it.
        proactiveReady: target.proactiveReady,
      })),
    replyAttachmentRoots: knownReplyAttachmentCwds,
  });
}
