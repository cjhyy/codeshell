import { join } from "node:path";
import { PET_RULE_UPSERT_ACTION } from "@cjhyy/code-shell-pet/protocol";
import { dlog } from "../desktop-logger.js";
import { createPetDeliveryResolver } from "./pet-delivery-plan.js";
import { createNoticeActionSources } from "./pet-notice-action-sources.js";
import { createNoticeAttention, SessionViewTracker } from "./pet-notice-attention.js";
import { createDecisionHooks } from "./pet-notice-decision-hooks.js";
import { createExternalDecisions } from "./pet-notice-external-decisions.js";
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
import { createSessionReportNotices } from "./pet-notice-session-report.js";
import { createSessionWatchAction } from "./pet-notice-session-watch.js";
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
  let disposed = false;
  const isExternal = (sessionId: string) => deps.externalSessions?.has(sessionId) === true;
  // Read lazily: where a prompt goes needs the hooks and view built below.
  const externalDecisions = createExternalDecisions({
    ...(deps.externalApprovals ? { source: deps.externalApprovals } : {}),
    tasks: () => deps.longTasks.getSnapshot().tasks,
    deliveryFor: (sessionId, task) => decisions.hooks.deliveryFor(sessionId, task),
    title: (sessionId) => view.sessionTitle(sessionId),
    onChange: (event) => {
      // PetImDecisions looks now (a prompt to send, or one to end).
      decisions.nudge(event.sessionId);
      // Answered anywhere, timed out or dropped: never replayed later.
      if (event.type === "resolved")
        void ready.then(() =>
          disposed ? undefined : router.revokeDecision(event.sessionId, event.requestId),
        );
    },
    now,
  });
  const view = createNoticeProjectionView({ ...deps, externalDecisions });
  const outlets = createNoticeOutlets({
    gateway: deps.gateway,
    outbox: deps.outbox,
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
    // Every IM send goes through the outbox, which dedupes a resend by its key.
    supportsIdempotentSend: () => true,
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
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return work;
  };
  const submit = (notice: NoticeSubmission): Promise<unknown> =>
    track(
      router.submit(notice).catch((error) => {
        log("pet.notice.submit_failed", { kind: notice.kind, error: errorText(error) });
        return undefined;
      }),
    );
  // What each notice's reply code offers (继续 / 重试 / 打开 …).
  const actionSources = createNoticeActionSources({
    isExternal,
    activeTask: (sessionId) => deps.longTasks.activeForSession(sessionId),
    ...(deps.lastUserMessage ? { lastUserMessage: deps.lastUserMessage } : {}),
    log,
  });
  /** {@link submit} for callers that must know the outcome: failures reach them. */
  const submitNotice = (notice: NoticeSubmission) => {
    const routed = router.submit(notice);
    const tracked = routed.catch(() => undefined);
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
    return routed;
  };
  /** Hand every parked mid-run report to the router and wait until it took them. */
  const flushParked = async (): Promise<void> => {
    await watcher.flush();
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };

  const deliveries = createPetDeliveryResolver({
    rules: ruleStore,
    longTasks: deps.longTasks,
    // The bound-Session bridge forwards no desktop external runtime's turns
    // (its chat's messages still go to the worker): no chat is bound to one.
    replyRoutes: async (sessionId) =>
      isExternal(sessionId)
        ? []
        : ((await deps.sessionRoutes()?.notifyRoutesForSession(sessionId)) ?? []),
    delegatedFromDesktop: () => settings.settings().delegatedFromDesktop,
    log,
  });

  const decisions = createDecisionHooks({
    view,
    deliveries,
    external: externalDecisions,
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
      const { attention, channel, target, ruleIds, requiresAway, reply } = delivery;
      // The Session's own reply (or its failure text) in that conversation is
      // the delivery: the router keeps the desktop record and sends no IM.
      const served = delivery.composeBy === "session-reply";
      if (served)
        log("pet.notice.bound_reply_delivered", {
          sessionId: draft.sessionId,
          dedupeKey: draft.dedupeKey,
        });
      const { context: _context, ...facts } = rest;
      const notice = (actions: NoticeSubmission["actions"]): NoticeSubmission => ({
        ...facts,
        ruleIds,
        ...(requiresAway ? { requiresAway: true } : {}),
        attention,
        channel,
        target,
        // The owner asked for this over IM: it is answered there, never held back.
        ...(reply ? { reply: true } : {}),
        ...(served ? { boundReplyDelivered: true } : {}),
        ...(actions ? { actions } : {}),
      });
      const actions = actionSources.forDraft(draft);
      if (actions instanceof Promise) void track(actions.then((found) => submit(notice(found))));
      else void submit(notice(actions));
    },
    // PetImDecisions owns the prompt (with its reply code); nudge it now.
    onPendingDecision: (sessionId) => decisions.nudge(sessionId),
    // A cancelled Goal's pauses must never be replayed or digested later.
    onGoalCleared: (sessionId) => router.revokeSessionBlocked(sessionId),
    // Queued user messages (core queue depth). Background work parks the turn
    // with completionKind background_wait, which the watcher already skips.
    isSessionBusy: view.isSessionBusy,
    isEligibleSession: view.isEligibleSession,
    sessionTitle: view.sessionTitle,
    activeTask: (sessionId) => deps.longTasks.activeForSession(sessionId),
    now,
    log,
  });

  const upsertRule = createNoticeRuleAction({
    ruleStore,
    deliveries,
    ownerChannels: outlets.ownerChannels,
    lastOwnerInboundChannel: () => deps.gateway.lastOwnerInboundChannel(),
    isEligibleSession: view.isEligibleSession,
    settings: settings.settings,
    nudge: decisions.nudge,
    now,
  });
  const removeHostAction = deps.bridge.setHostActionHandler(PET_RULE_UPSERT_ACTION, upsertRule);

  const ready: Promise<void> = Promise.all([ruleStore.load(), ledger.load(), receipts.load()])
    .then(() => undefined)
    .catch((error) => log("pet.notice.load_failed", { error: errorText(error) }));
  // In the background: a slow resend (up to the IM timeout) must not hold up
  // startup. The router's own submit / replay / flush wait for it.
  void ready
    .then(() => router.recover())
    .catch((error) => log("pet.notice.recover_failed", { error: errorText(error) }));

  const replay = createNoticeReplay({
    router,
    ready,
    ...(deps.powerEvents ? { powerEvents: deps.powerEvents } : {}),
    log,
  });
  const workerGone = createWorkerLossDetector(view);
  const unsubscribeProjection = deps.projection.subscribe((event) => {
    void ready.then(() => (disposed ? undefined : watcher.observeProjection(event)));
    if (workerGone(event)) {
      try {
        deps.onWorkerLost?.(isExternal);
      } catch (error) {
        log("pet.notice.worker_lost_listener_failed", { error: errorText(error) });
      }
      // External runtimes do not run in the worker: their open runs still close.
      void ready.then(() => (disposed ? undefined : watcher.flush((id) => !isExternal(id))));
    }
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
    actionsFor: actionSources.forTask,
    nudge: decisions.nudge,
    sessionTitle: view.sessionTitle,
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
      actionSources.observe(sessionId, outcomes);
      // Chained on one promise, so per-Session order is preserved.
      void ready.then(() => (disposed ? undefined : watcher.observe(sessionId, outcomes)));
    },
    outboxResult(result) {
      return ready
        .then(() =>
          disposed
            ? undefined
            : router.applyOutboxResult(result.deliveryKey, result.outcome, result.error),
        )
        .catch((error) => log("pet.notice.outbox_result_failed", { error: errorText(error) }));
    },
    outboxReady() {
      return ready
        .then(() => (disposed ? undefined : router.recheckOutbox()))
        .catch((error) => log("pet.notice.outbox_recheck_failed", { error: errorText(error) }));
    },
    externalRuntimeEnded(sessionId) {
      void ready.then(() => (disposed ? undefined : watcher.flush(sessionId)));
    },
    submitNotice,
    notifySessionReport: createSessionReportNotices({
      deliveries,
      submit: submitNotice,
      sessionTitle: view.sessionTitle,
      isEligibleSession: view.isEligibleSession,
    }),
    sessionWatch: (host) =>
      createSessionWatchAction({
        ...host,
        rules: ruleStore,
        isEligibleSession: view.isEligibleSession,
        ...(deps.isMimiSession ? { isMimiSession: deps.isMimiSession } : {}),
        nudge: decisions.nudge,
        now,
        log,
      }),
    notifyTaskClosed: closure.notifyTaskClosed,
    armDelegationRule: closure.armDelegationRule,
    inboundReplay: replay.inboundReplay,
    decisions: decisions.hooks,
    externalDecisions,
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
    upsertRule: (callerSessionId, args) => {
      if (disposed) return Promise.reject(new Error("notice rules are shutting down"));
      return upsertRule(callerSessionId, args);
    },
    dispose() {
      if (disposed) return;
      settings.dispose();
      disposed = true;
      replay.dispose();
      removeHostAction();
      unsubscribeProjection();
      externalDecisions.dispose();
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
