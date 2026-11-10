import type { ConversationSessionRoute, PetLongTask } from "@cjhyy/code-shell-pet";
import type { NoticeChannel, RuleEffect } from "@cjhyy/code-shell-pet/protocol";
import type { OutgoingAttachment } from "@cjhyy/code-shell-chat";
import type { DesktopNotificationInput } from "../desktop-notifier.js";
import type { HostActionHandler } from "../host-action-dispatch.js";
import type { GatewayControlEventInput } from "../im-gateway-control-server.js";
import type { PetNotificationSettingsView } from "../../shared/pet-notices.js";
import type { PetDeliveryResolver } from "./pet-delivery-plan.js";
import type { PetIpcAttention } from "./pet-ipc.js";
import type {
  PetDecisionNoticeHooks,
  PetNoticeFocusEvents,
  PetNoticePowerEvents,
  PetNoticePresenceTimers,
} from "./pet-notice-decision-hooks.js";
import type { PetNoticeLedger } from "./pet-notice-ledger.js";
import type { PetNoticeWiringGateway } from "./pet-notice-outlets.js";
import type { PetInboundOrigin, PetInboundReplay } from "./pet-notice-replay.js";
import type { PetNoticeRouter } from "./pet-notice-router.js";
import type { PetNotificationSettings } from "./pet-notice-settings.js";
import type { PetTaskClosureNotice } from "./pet-notice-task-closure.js";
import type { NoticeMediaAttachment, PetAttentionOptions } from "./pet-notice-types.js";
import type { PetReceiptStore } from "./pet-receipt-store.js";
import type { NoticeRule, PetRuleStore } from "./pet-rule-store.js";
import type { PetSessionRuleWatcher } from "./pet-session-rule-watcher.js";
import type { SessionOutcome } from "./session-outcome.js";

/** What `wirePetNotices` needs from main: stores' home, projection, gateway, Electron seams. */
export interface PetNoticeWiringDeps {
  /** Electron `app.getPath("userData")`; stores live under `<userData>/pet/`. */
  userDataDir: string;
  bridge: { setHostActionHandler(action: string, handler: HostActionHandler): () => void };
  /** The pet projection (PetStateAggregator): attention source and Session facts. */
  projection: PetAttentionOptions["source"];
  longTasks: {
    activeForSession(sessionId: string): PetLongTask | undefined;
    getSnapshot(): { tasks: readonly PetLongTask[] };
    /** Tasks changed (an IM-started task may now own where a prompt goes). */
    subscribe?(listener: () => void): () => void;
  };
  /**
   * The worker process is alive. A failed projection snapshot reads as
   * "disconnected" while it may still be running; only a worker that is
   * really gone (or a new one) ends the runs it was driving.
   */
  hasLiveWorker?: () => boolean;
  /**
   * IM conversations that receive a Session's turn replies; resolved lazily
   * (built after this wiring). A done / failed notice for a conversation the
   * reply already reaches is recorded on the desktop and never sent to IM.
   */
  sessionRoutes: () =>
    | { notifyRoutesForSession(sessionId: string): Promise<ConversationSessionRoute[]> }
    | undefined;
  gateway: PetNoticeWiringGateway;
  /** Durable gateway outbox publish (`publishGatewayControlEvent`), for replies to a route. */
  publishRoute(event: GatewayControlEventInput): Promise<void>;
  /** Reads validated attachment descriptors into sendable bytes (owner sends only). */
  materializeAttachments(
    attachments: readonly NoticeMediaAttachment[],
  ): Promise<OutgoingAttachment[]>;
  /** Native desktop notification (`DesktopNotifier.notify`); click opens `sessionId`. */
  notifyDesktop(input: DesktopNotificationInput): Promise<unknown>;
  /** The user settings object (raw); only `pet.notifications` is read. */
  readSettings(): unknown;
  presence: { getSystemIdleTimeSec(): number; hasFocusedWindow(): boolean };
  /** Mimi's own Sessions never fire notice rules. */
  isMimiSession?: (sessionId: string) => boolean;
  /**
   * Electron `powerMonitor`: a digest whose timer slept through its moment is
   * sent when the machine wakes or the screen unlocks.
   */
  powerEvents?: PetNoticePowerEvents;
  /** Electron `app`: losing window focus can make the owner away at once. */
  focusEvents?: PetNoticeFocusEvents;
  /** Test seam: the presence watch's timers (idle threshold, focus settling). */
  presenceTimers?: PetNoticePresenceTimers;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** Test seams: the router's IM timeout and the owner's UTC offset. */
  imTimeoutMs?: number;
  timezoneOffsetMin?: (ms: number) => number;
}

export interface PetNoticeWiring {
  router: PetNoticeRouter;
  ruleStore: PetRuleStore;
  watcher: PetSessionRuleWatcher;
  ledger: PetNoticeLedger;
  receipts: PetReceiptStore;
  /** The router as pet IPC sees it; also records which Session the owner is viewing. */
  attention: PetIpcAttention;
  /**
   * Stores loaded. Startup recovery then runs in the background; the
   * router's submit, replay and digest flush wait for it themselves.
   */
  ready: Promise<void>;
  /** Feed what one Session stream event meant (from `createSessionOutcomeTap`). */
  observeSessionOutcomes(sessionId: string, outcomes: readonly SessionOutcome[]): void;
  /** A long task reached a terminal state and was not continued: one notice, then spend rules. */
  notifyTaskClosed(task: PetLongTask, closure?: PetTaskClosureNotice): Promise<void>;
  /**
   * Mimi started (or re-drove) a delegated Session: arm its automatic notice
   * rule so blocked prompts and the bell follow it. Never throws.
   */
  armDelegationRule(task: PetLongTask): Promise<void>;
  /** Queued notices for an owner's IM message; undefined without an IM origin. */
  inboundReplay(origin: PetInboundOrigin | undefined): PetInboundReplay | undefined;
  /** Pending decisions: PetImDecisions asks here where a decision's prompt goes. */
  decisions: PetDecisionNoticeHooks;
  /**
   * Who must be told about a Session's outcome: the single source for the
   * rule watcher, the task closure, decision prompts and the bound-Session bridge.
   */
  deliveries: PetDeliveryResolver;
  /** Sends parked mid-run reports, then waits for pending rule and notice writes (shutdown). */
  flush(): Promise<void>;
  /** The settings this wiring currently routes with. */
  settings(): PetNotificationSettings;
  /** Fresh `pet.notifications` for the settings form (bypasses the routing cache). */
  settingsView(): PetNotificationSettingsView;
  /** `pet.notifications` was written: drop the routing cache and tell listeners. */
  settingsChanged(): void;
  onSettingsChange(listener: () => void): () => void;
  /** The IM a rule with this channel and target is predicted to use; undefined → desktop. */
  predictIm(channel: NoticeChannel, target: NoticeRule["target"]): RuleEffect["im"];
  /** A top-level work Session (not Mimi's, not external) that rules may watch. */
  isEligibleSession(sessionId: string): boolean;
  dispose(): void;
}
