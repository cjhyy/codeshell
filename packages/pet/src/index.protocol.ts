/**
 * Stable Pet projection wire contract for host bridges and UI clients.
 *
 * State-machine implementations remain package-private; this entry contains
 * only method/action names, the shapes crossing the host boundary, and the
 * host-side validators and limits for notice rules.
 */
export {
  GET_PET_PROJECTION_SNAPSHOT_METHOD,
  PET_PROJECTION_DELTA_METHOD,
  PET_REPORT_TO_MIMI_METHOD,
  type PetProjectionDelta,
  type PetProjectionSnapshotResult,
  type PetReportToMimiEvent,
} from "./protocol.js";
export {
  NOTICE_CHANNEL_MAX_LENGTH,
  NOTICE_EVENTS,
  NOTICE_NOTE_MAX_LENGTH,
  NOTICE_RULE_CREATORS,
  PET_RULE_UPSERT_ACTION,
  parseNoticeEvents,
  parseNoticeRuleUpsert,
  type BoundChannel,
  type NoticeAttention,
  type NoticeChannel,
  type NoticeChannelReadiness,
  type NoticeEvent,
  type NoticeRuleUpsert,
  type NoticeRuleUpsertReply,
  type RuleEffect,
} from "./notice-rule.js";
export {
  PET_NOTICE_KINDS,
  PET_NOTICE_TEXT_MAX,
  PET_NOTICES_QUERY_ACTION,
  PET_NOTIFICATION_SETTINGS_QUERY_ACTION,
  PET_SNOOZE_MAX_MINUTES,
  PET_TRIGGERS_QUERY_ACTION,
  isPetNotificationSettingsMutation,
  isPetTriggerMutation,
  isPetTriggerMutationRequest,
  PET_TRIGGER_CHANGES_MAX,
  petTriggerChanges,
  parsePetNoticesQuery,
  type PetNoticeKind,
  type PetNoticesQuery,
  type PetNotificationSettingsMutation,
  type PetNotificationSettingsPatch,
  type PetSnoozeRequest,
  type PetTriggerMutation,
  type PetTriggerMutationRequest,
} from "./notice-tools-protocol.js";
export {
  LOCAL_PET_OWNER,
  type PendingDecisionKind,
  type PendingDecisionProjection,
  type PendingDecisionStatus,
  type PetOwnerId,
  type PetProjectionCursor,
  type PetProjectionFreshness,
  type PetProjectionSnapshot,
  type PetSessionPhase,
  type PetSessionProjection,
  type PetSessionRunState,
  type PetTerminalStatus,
  type PetWorkerState,
} from "./types.js";
