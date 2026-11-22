import { shell } from "electron";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { AgentBridge, resolveNoRepoCwd } from "../agent-bridge.js";
import { getSessionCwdIndex } from "../session-cwd-index.js";
import { type PetNoticeWiring } from "../pet/pet-notice-wiring.js";
import { withExternalDecisions } from "../pet/pet-notice-external-decisions.js";
import {
  PetImDecisions,
  collectCurrentImDecisions,
  imDecisionWorkerActions,
} from "../pet/pet-im-decisions.js";
import { createOwnerReplyHandling } from "../pet/pet-notice-action-controls.js";
import { createPetExternalReplyModel } from "../pet/pet-external-reply-model.js";
import { dlog } from "../desktop-logger.js";
import { getSessionEvents } from "../rawTranscript.js";
import type { MimiShellOptions, NativeMimiHost, MimiBoundTasks } from "./mimi-shell-types.js";
export function startMimiDecisions({
  options,
  bridge,
  notices,
  longTaskStore,
  aggregator,
  longTaskCoordinator,
  currentSession,
}: {
  options: Pick<
    MimiShellOptions,
    "pendingMobileApprovals" | "mobileOrchestrator" | "externalRuntime" | "revealSessionWindow"
  >;
  bridge: AgentBridge;
  notices: PetNoticeWiring;
  longTaskStore: NativeMimiHost["mimiTasks"];
  aggregator: NativeMimiHost["mimiProjection"];
  longTaskCoordinator: MimiBoundTasks;
  currentSession: () => string | undefined;
}) {
  const { pendingMobileApprovals, mobileOrchestrator, externalRuntime, revealSessionWindow } =
    options;
  const decisions = new PetImDecisions({
    // The worker's decisions and the desktop external runtimes' (Codex / Claude Code).
    ...withExternalDecisions(
      notices.externalDecisions,
      {
        read: async () => {
          const [lines, taskSnapshot] = await Promise.all([
            pendingMobileApprovals.replayForMimi(),
            longTaskStore.getSnapshot(),
          ]);
          return collectCurrentImDecisions(
            aggregator.getSnapshot(),
            taskSnapshot.tasks,
            lines,
            notices.decisions.deliveryFor,
          );
        },
        ...imDecisionWorkerActions(
          (method, params, timeoutMs, options) =>
            bridge.requestWorker(method, params, timeoutMs, options),
          (params) => mobileOrchestrator.broadcastApprovalResolved(params),
        ),
      },
      (source, error) =>
        dlog("main", "pet.im-decision.read_failed", { source, error: String(error) }),
    ),
    // The router decides whether a prompt goes to IM (presence, caps) and
    // where; its ledger records hold each prompt's lifecycle.
    router: notices.router,
    isOwnerConversation: notices.decisions.isOwnerConversation,
    ownerChannelIsDirect: notices.decisions.ownerChannelIsDirect,
    isAway: notices.decisions.isAway,
    decisionStatus: notices.decisions.decisionStatus,
    projectionLive: notices.decisions.projectionLive,
    workerGone: notices.decisions.workerGone,
    projection: aggregator,
    nudges: [notices.decisions.onBlocked],
    onAwayChange: notices.decisions.onAwayChange,
    onError: (error) => dlog("main", "pet.im-decision.failed", { error: String(error) }),
    // Owner replies are read by a model against the open items (no text patterns).
    ...createOwnerReplyHandling({
      router: notices.router,
      cwd: resolveNoRepoCwd(),
      accounting: {
        sessionsRootDir: sessionsRoot(),
        sessionId: currentSession,
        purpose: "pet_notice_reply",
      },
      externalReplyModel: createPetExternalReplyModel({
        service: () => externalRuntime.service,
        cwd: resolveNoRepoCwd(),
      }),
      worker: bridge,
      external: () => externalRuntime.service ?? undefined,
      sessions: () => aggregator.getSnapshot().sessions,
      longTasks: {
        get: (id) => longTaskStore.get(id),
        control: (r) => longTaskCoordinator.control(r),
      },
      readEvents: (sessionId) => getSessionEvents(sessionId),
      workspace: async (sessionId) => {
        const entry = await getSessionCwdIndex().refresh(sessionId);
        return entry?.status === "confirmed" ? (entry.workspaceRoot ?? entry.cwd) : undefined;
      },
      openPath: (path) => shell.openPath(path),
      revealPath: (path) => shell.showItemInFolder(path),
      openExternal: (url) => shell.openExternal(url),
      locateSession: (sessionId) => revealSessionWindow(sessionId),
      onError: (error) => dlog("main", "pet.notice.reply_failed", { error: String(error) }),
    }),
  });
  decisions.start();
  return decisions;
}
