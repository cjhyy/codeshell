// Wire-protocol DTOs live in core (protocol contract); server re-exports them
// so internal `./types.js` imports keep working unchanged.
export type {
  TrustedDevice,
  TrustedDevicePublic,
  PairingToken,
  ApprovalScope,
  ApprovalPathScope,
  MobileRemotePermissionMode as PermissionMode,
  CcDiscoveredSession,
  CcHistoryMessage,
  CcApprovalDecision,
  MobilePermissionModeSnapshotEntry,
  MobileProjectMeta,
  MobileImageMime,
  MobileImageBase,
  MobileImageAttachment,
  MobileAttachmentSummary,
  MobileClientEvent,
  MobileServerEvent,
  RoomPublic,
  MobileSessionMeta,
} from "@cjhyy/code-shell-core";
