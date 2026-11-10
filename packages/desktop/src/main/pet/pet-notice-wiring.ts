import { join } from "node:path";
import { PET_RULE_UPSERT_ACTION } from "@cjhyy/code-shell-pet/protocol";
import { dlog } from "../desktop-logger.js";
import { createPetDeliveryResolver } from "./pet-delivery-plan.js";
import { createNoticeAttention, SessionViewTracker } from "./pet-notice-attention.js";
import { createDecisionHooks } from "./pet-notice-decision-hooks.js";
import { createNoticeRuleAction, predictedIm } from "./pet-notice-host-action.js";
import { PetNoticeLedger } from "./pet-notice-ledger.js";
import { PetNoticeMediaStore } from "./pet-notice-media.js";
import { createNoticeOutlets } from "./pet-notice-outlets.js";
import {
  createNoticeProjectionView,
  createWorkerLossDetector,
  resolvedDecision,
} from "./pet-notice-projection.js";
import { createNoticeReplay } from "./pet-notice-replay.js";
import { PetNoticeRouter, type NoticeSubmission } from "./pet-notice-router.js";
import { createNoticeSettings } from "./pet-notice-settings.js";
import { createTaskClosureAdapter } from "./pet-notice-task-closure.js";
import { errorText } from "./pet-notice-types.js";
import type { PetNoticeWiring, PetNoticeWiringDeps } from "./pet-notice-wiring-types.js";
import { createPresenceDetector } from "./pet-presence.js";
import { PetReceiptStore } from "./pet-receipt-store.js";
import { PetRuleStore } from "./pet-rule-store.js";
import { PetSessionRuleWatcher, type NoticeDraft } from "./pet-session-rule-watcher.js";

// The public surface index.ts, pet IPC and the tests import from here.
export type { PetNoticeWiring, PetNoticeWiringDeps } from "./pet-notice-wiring-types.js";
export type {
  PetDecisionNoticeHooks,
  PetNoticeFocusEvents,
  PetNoticePowerEvents,
} from "./pet-notice-decision-hooks.js";
export type { PetNoticeWiringGateway } from "./pet-notice-outlets.js";
export type { PetInboundOrigin, PetInboundReplay, PetPendingNotice } from "./pet-notice-replay.js";
export {
  DEFAULT_QUIET_HOURS,
  parsePetNotificationSettings,
  petNotificationSettingsView,
  type PetNotificationSettings,
} from "./pet-notice-settings.js";
export type { PetTaskClosureNotice } from "./pet-notice-task-closure.js";

/**
 * Composition root for owner notices: rule store, notice ledger, presence,
 * the router (which also keeps the pet's pending-decision attention), the
 * rule watcher and the NotifyMe host action. Everything Electron-specific is
 * injected so the wiring is unit-tested without a window or a gateway.
 */
export function wirePetNotices(deps: PetNoticeWiringDeps): PetNoticeWiring {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((event, data) => dlog("main", event, data));
  const petDir = join(deps.userDataDir, "pet");
  // Desktop main is the only writer of rules.json / notices.json, so their
  // in-process serialisation is enough (no cross-process lock).
  const ruleStore = new PetRuleStore({ path: join(petDir, "rules.json"), now });
  const ledger = new PetNoticeLedger({ path: join(petDir, "notices.json"), now });
  // Each notice's files are copied here when it is recorded, so a resend sends the same bytes.
  const mediaStore = new PetNoticeMediaStore({ root: join(petDir, "notice-media"), log });
  const receipts = new PetReceiptStore(join(petDir, "attention-receipts.json"), now);
  const views = new SessionViewTracker();
  const settings = createNoticeSettings({ readSettings: () => deps.readSettings(), now, log });
  const view = createNoticeProjectionView(deps);
  const outlets = createNoticeOutlets({
    gateway: deps.gateway,
    publishRoute: (event) => deps.publishRoute(event),
    materializeAttachments: (files) => deps.materializeAttachments(files),
    notifyDesktop: (input) => deps.notifyDesktop(input),
    log,
  });

  const presence = {
    isPresent: () =>
      createPresenceDetector({
        getSystemIdleTimeSec: deps.presence.getSystemIdleTimeSec,
        hasFocusedWindow: deps.presence.hasFocusedWindow,
        idleSec: settings.settings().presenceIdleSec,
      }).isPresent(),
  };

  const router = new PetNoticeRouter({
    source: deps.projection,
    receipts,
    now,
    ledger,
    presence,
    settings: () => {
      const { quietHours, maxPerHour, maxP0PerHour, mergeWindowSec } = settings.settings();
      return { quietHours, maxPerHour, maxP0PerHour, mergeWindowSec };
    },
    imChannels: outlets.imChannels,
    lastInboundChannel: () => deps.gateway.lastOwnerInboundChannel(),
    supportsIdempotentSend: (channel) => deps.gateway.supportsIdempotentOwnerSend(channel),
    isDecisionStillPending: view.isDecisionStillPending,
    wasSessionViewedSince: (sessionId, ms) => {
      let focused: boolean;
      try {
        focused = deps.presence.hasFocusedWindow();
      } catch {
        focused = false;
      }
      return views.viewedSince(sessionId, ms, focused);
    },
    isGoalRuleCancelled: (ruleId) => {
      const rule = ruleStore.get(ruleId);
      return (
        rule?.when.kind === "session" && rule.when.scope === "goal" && rule.state === "cancelled"
      );
    },
    outlets,
    ...(deps.imTimeoutMs !== undefined ? { imTimeoutMs: deps.imTimeoutMs } : {}),
    ...(deps.timezoneOffsetMin ? { timezoneOffsetMin: deps.timezoneOffsetMin } : {}),
    media: mediaStore,
    log,
  });

  /** Notices still on their way into the router (shutdown waits for them). */
  const inFlight = new Set<Promise<unknown>>();
  const submit = (notice: NoticeSubmission): Promise<unknown> => {
    const sending = router.submit(notice).catch((error) => {
      log("pet.notice.submit_failed", { kind: notice.kind, error: errorText(error) });
      return undefined;
    });
    inFlight.add(sending);
    void sending.finally(() => inFlight.delete(sending));
    return sending;
  };
  /** Hand every parked mid-run report to the router and wait until it took them. */
  const flushParked = async (): Promise<void> => {
    await watcher.flush();
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };

  const deliveries = createPetDeliveryResolver({
    rules: ruleStore,
    longTasks: deps.longTasks,
    replyRoutes: async (sessionId) =>
      (await deps.sessionRoutes()?.notifyRoutesForSession(sessionId)) ?? [],
    delegatedFromDesktop: () => settings.settings().delegatedFromDesktop,
    log,
  });

  const decisions = createDecisionHooks({
    view,
    deliveries,
    isPresent: presence.isPresent,
    getSystemIdleTimeSec: () => deps.presence.getSystemIdleTimeSec(),
    presenceIdleSec: () => settings.settings().presenceIdleSec,
    ownerChannels: outlets.ownerChannels,
    isOwnerConversation: (channel, target) => deps.gateway.isOwnerConversation(channel, target),
    ...(deps.longTasks.subscribe
      ? { subscribeTasks: (listener: () => void) => deps.longTasks.subscribe!(listener) }
      : {}),
    ...(deps.powerEvents ? { powerEvents: deps.powerEvents } : {}),
    ...(deps.focusEvents ? { focusEvents: deps.focusEvents } : {}),
    ...(deps.presenceTimers ? { presenceTimers: deps.presenceTimers } : {}),
    log,
  });

  const watcher = new PetSessionRuleWatcher({
    rules: ruleStore,
    deliveries,
    onNotice: (draft: NoticeDraft) => {
      const { delivery, ...rest } = draft;
      const { attention, channel, target, ruleIds, requiresAway } = delivery;
      // The Session's own reply (or its failure text) in that conversation is
      // the delivery: the router keeps the desktop record and sends no IM.
      const served = delivery.composeBy === "session-reply";
      if (served)
        log("pet.notice.bound_reply_delivered", {
          sessionId: draft.sessionId,
          dedupeKey: draft.dedupeKey,
        });
      void submit({
        ...rest,
        ruleIds,
        ...(requiresAway ? { requiresAway: true } : {}),
        attention,
        channel,
        target,
        ...(served ? { boundReplyDelivered: true } : {}),
      });
    },
    // PetImDecisions owns the prompt (with its reply code); nudge it now.
    onPendingDecision: (sessionId) => decisions.nudge(sessionId),
    // A cancelled Goal's pauses must never be replayed or digested later.
    onGoalCleared: (sessionId) => router.revokeSessionBlocked(sessionId),
    // Queued user messages (core queue depth). Background work parks the turn
    // with completionKind background_wait, which the watcher already skips.
    isSessionBusy: (sessionId) => {
      const session = view.workSession(sessionId);
      return !!session && (session.queueDepth > 0 || session.runState === "queued");
    },
    isEligibleSession: view.isEligibleSession,
    sessionTitle: (sessionId) => view.workSession(sessionId)?.title,
    now,
    log,
  });

  const removeHostAction = deps.bridge.setHostActionHandler(
    PET_RULE_UPSERT_ACTION,
    createNoticeRuleAction({
      ruleStore,
      deliveries,
      ownerChannels: outlets.ownerChannels,
      lastOwnerInboundChannel: () => deps.gateway.lastOwnerInboundChannel(),
      isEligibleSession: view.isEligibleSession,
      settings: settings.settings,
      nudge: decisions.nudge,
      now,
    }),
  );

  const ready: Promise<void> = Promise.all([ruleStore.load(), ledger.load(), receipts.load()])
    .then(() => undefined)
    .catch((error) => log("pet.notice.load_failed", { error: errorText(error) }));
  // In the background: a slow resend (up to the IM timeout) must not hold up
  // startup. The router's own submit / replay / flush wait for it.
  void ready
    .then(() => router.recover())
    .catch((error) => log("pet.notice.recover_failed", { error: errorText(error) }));

  let disposed = false;
  const replay = createNoticeReplay({
    router,
    ready,
    ...(deps.powerEvents ? { powerEvents: deps.powerEvents } : {}),
    log,
  });
  const workerGone = createWorkerLossDetector(view);
  const unsubscribeProjection = deps.projection.subscribe((event) => {
    void ready.then(() => (disposed ? undefined : watcher.observeProjection(event)));
    if (workerGone(event)) void ready.then(() => (disposed ? undefined : watcher.flush()));
    // A decision answered anywhere (or timed out) must never be replayed later.
    const resolved = resolvedDecision(event);
    if (resolved)
      void ready.then(() =>
        disposed ? undefined : router.revokeDecision(resolved.sessionId, resolved.requestId),
      );
  });

  const closure = createTaskClosureAdapter({
    ruleStore,
    deliveries,
    ready,
    submit,
    nudge: decisions.nudge,
    sessionTitle: (sessionId) => view.workSession(sessionId)?.title,
    now,
    log,
  });

  return {
    router,
    ruleStore,
    watcher,
    ledger,
    receipts,
    attention: createNoticeAttention(router, views, now),
    ready,
    observeSessionOutcomes(sessionId, outcomes) {
      if (outcomes.length === 0) return;
      // Chained on one promise, so per-Session order is preserved.
      void ready.then(() => (disposed ? undefined : watcher.observe(sessionId, outcomes)));
    },
    notifyTaskClosed: closure.notifyTaskClosed,
    armDelegationRule: closure.armDelegationRule,
    inboundReplay: replay.inboundReplay,
    decisions: decisions.hooks,
    deliveries,
    flush: async () => {
      await flushParked();
      await Promise.all([ruleStore.flush(), ledger.flush()]);
    },
    settings: settings.settings,
    settingsView: settings.settingsView,
    settingsChanged: settings.settingsChanged,
    onSettingsChange: settings.onSettingsChange,
    predictIm: (channel, target) =>
      predictedIm(channel, target, outlets.ownerChannels(), () =>
        deps.gateway.lastOwnerInboundChannel(),
      ),
    isEligibleSession: view.isEligibleSession,
    dispose() {
      if (disposed) return;
      settings.dispose();
      disposed = true;
      replay.dispose();
      removeHostAction();
      unsubscribeProjection();
      decisions.dispose();
      // Reports parked on runs that will now never close still reach the
      // router before it stops taking notices.
      if (!watcher.hasPending() && inFlight.size === 0) router.dispose();
      else
        void flushParked()
          .catch((error) => log("pet.notice.flush_failed", { error: errorText(error) }))
          .finally(() => router.dispose());
    },
  };
}
