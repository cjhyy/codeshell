import type { MobileClientEvent, MobileImageAttachment } from "./types.js";
import { MAX_MOBILE_ATTACHMENTS, MAX_MOBILE_IMAGE_BYTES } from "./mobile-limits.js";

type JsonRecord = Record<string, unknown>;

const PERMISSION_MODES = new Set(["default", "acceptEdits", "bypassPermissions"]);
const KINDS = new Set(["claude-code", "codex"]);
const SCOPES = new Set(["once", "session", "project"]);
const PATH_SCOPES = new Set(["file", "dir", "tool"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 512;
const MAX_PATH_LENGTH = 32_768;
const MAX_MESSAGE_LENGTH = 512 * 1024;
const MAX_HISTORY_LIMIT = 500;

/** Runtime validation at the WebSocket boundary; TypeScript types do not validate JSON. */
export function parseMobileClientEvent(value: unknown): MobileClientEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const event = value;
  let valid: boolean;

  switch (event.type) {
    case "auth.device":
      valid = boundedString(event.deviceId, MAX_ID_LENGTH) && boundedString(event.secretHash, 4096);
      break;
    case "pair.complete":
      valid =
        boundedString(event.token, MAX_ID_LENGTH) &&
        boundedTrimmedString(event.name, MAX_NAME_LENGTH) &&
        boundedString(event.secretHash, 4096);
      break;
    case "chat.send":
      valid =
        boundedOptionalEmptyString(event.text, MAX_MESSAGE_LENGTH) &&
        optionalBoundedString(event.sessionId, MAX_ID_LENGTH) &&
        optionalBoundedString(event.clientMessageId, MAX_ID_LENGTH) &&
        optionalAttachments(event.attachments);
      break;
    case "attachment.upload.begin":
      valid =
        boundedString(event.clientId, MAX_ID_LENGTH) &&
        boundedString(event.name, MAX_NAME_LENGTH) &&
        member(event.mime, IMAGE_MIMES) &&
        isPositiveInteger(event.size) &&
        event.size <= MAX_MOBILE_IMAGE_BYTES;
      break;
    case "session.select":
    case "session.history":
      valid = boundedString(event.sessionId, MAX_ID_LENGTH);
      break;
    case "session.create":
      valid =
        (event.cwd === undefined ||
          event.cwd === null ||
          boundedPath(event.cwd)) &&
        optionalBoundedString(event.name, MAX_NAME_LENGTH);
      break;
    case "run.stop":
      valid = optionalBoundedString(event.sessionId, MAX_ID_LENGTH);
      break;
    case "approval.respond":
      valid =
        boundedString(event.approvalId, MAX_ID_LENGTH) &&
        (event.decision === "approve" || event.decision === "reject") &&
        optionalBoundedString(event.sessionId, MAX_ID_LENGTH) &&
        optionalBoundedString(event.reason, MAX_MESSAGE_LENGTH) &&
        optionalBoundedString(event.answer, MAX_MESSAGE_LENGTH) &&
        optionalMember(event.scope, SCOPES) &&
        optionalMember(event.pathScope, PATH_SCOPES);
      break;
    case "session.list":
    case "room.list":
    case "room.projects":
      valid = true;
      break;
    case "session.sync":
      valid =
        boundedString(event.sessionId, MAX_ID_LENGTH) &&
        optionalNonNegativeInteger(event.sinceSeq);
      break;
    case "permission.setMode":
      valid =
        optionalBoundedString(event.sessionId, MAX_ID_LENGTH) &&
        member(event.mode, PERMISSION_MODES);
      break;
    case "model.set":
      valid = boundedString(event.model, MAX_ID_LENGTH);
      break;
    case "goal.extend":
      valid =
        boundedString(event.sessionId, MAX_ID_LENGTH) &&
        optionalPositiveInteger(event.addTurns) &&
        optionalPositiveInteger(event.addTokenBudget) &&
        optionalPositiveInteger(event.addTimeBudgetMs) &&
        optionalPositiveInteger(event.addStopBlocks) &&
        [event.addTurns, event.addTokenBudget, event.addTimeBudgetMs, event.addStopBlocks].some(
          (amount) => amount !== undefined,
        );
      break;
    case "goal.clear":
      valid = boundedString(event.sessionId, MAX_ID_LENGTH);
      break;
    case "room.create":
      valid =
        boundedPath(event.cwd) &&
        optionalBoundedString(event.name, MAX_NAME_LENGTH) &&
        optionalMember(event.kind, KINDS) &&
        optionalMember(event.permissionMode, PERMISSION_MODES);
      break;
    case "room.open":
    case "room.close":
      valid = boundedString(event.roomId, MAX_ID_LENGTH);
      break;
    case "room.send":
      valid =
        boundedString(event.roomId, MAX_ID_LENGTH) &&
        boundedOptionalEmptyString(event.text, MAX_MESSAGE_LENGTH) &&
        optionalBoundedString(event.clientMessageId, MAX_ID_LENGTH) &&
        optionalAttachments(event.attachments);
      break;
    case "room.history":
      valid =
        boundedString(event.roomId, MAX_ID_LENGTH) &&
        optionalNonNegativeInteger(event.sinceSeq);
      break;
    case "ccRoom.probe":
      valid =
        (event.force === undefined || typeof event.force === "boolean") &&
        optionalMember(event.kind, KINDS);
      break;
    case "ccRoom.listSessions":
      valid = boundedPath(event.cwd) && optionalMember(event.kind, KINDS);
      break;
    case "ccRoom.openSession":
      valid =
        boundedString(event.sessionId, MAX_ID_LENGTH) &&
        boundedPath(event.cwd) &&
        member(event.mode, PERMISSION_MODES) &&
        optionalMember(event.kind, KINDS);
      break;
    case "ccRoom.subscribeTranscript":
      valid =
        boundedString(event.roomId, MAX_ID_LENGTH) &&
        boundedString(event.sessionId, MAX_ID_LENGTH) &&
        boundedPath(event.cwd) &&
        isBoundedHistoryLimit(event.limit) &&
        optionalMember(event.kind, KINDS);
      break;
    case "ccRoom.unsubscribeTranscript":
      valid = boundedString(event.roomId, MAX_ID_LENGTH);
      break;
    case "ccRoom.readHistory":
      valid =
        boundedPath(event.cwd) &&
        boundedString(event.sessionId, MAX_ID_LENGTH) &&
        isBoundedHistoryLimit(event.limit) &&
        optionalMember(event.kind, KINDS);
      break;
    case "ccRoom.respondApproval":
      valid =
        boundedString(event.roomId, MAX_ID_LENGTH) &&
        boundedString(event.requestId, MAX_ID_LENGTH) &&
        isApprovalDecision(event.decision);
      break;
    default:
      valid = false;
  }

  return valid ? (event as MobileClientEvent) : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function boundedOptionalEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function boundedTrimmedString(value: unknown, maxLength: number): value is string {
  return boundedString(value, maxLength) && value.trim().length > 0 && !value.includes("\0");
}

function boundedPath(value: unknown): value is string {
  return boundedString(value, MAX_PATH_LENGTH) && !value.includes("\0");
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || boundedString(value, maxLength);
}

function member(value: unknown, values: ReadonlySet<string>): boolean {
  return typeof value === "string" && values.has(value);
}

function optionalMember(value: unknown, values: ReadonlySet<string>): boolean {
  return value === undefined || member(value, values);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isBoundedHistoryLimit(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_HISTORY_LIMIT;
}

function optionalAttachments(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_MOBILE_ATTACHMENTS &&
      value.every(isAttachment))
  );
}

function isAttachment(value: unknown): value is MobileImageAttachment {
  if (
    !isRecord(value) ||
    !boundedString(value.clientId, MAX_ID_LENGTH) ||
    !boundedString(value.name, MAX_NAME_LENGTH) ||
    !member(value.mime, IMAGE_MIMES) ||
    !isPositiveInteger(value.size) ||
    value.size > MAX_MOBILE_IMAGE_BYTES
  ) {
    return false;
  }
  return value.transport === "inline"
    ? boundedString(value.dataUrl, MAX_MESSAGE_LENGTH)
    : value.transport === "upload" && boundedString(value.uploadId, MAX_ID_LENGTH);
}

function isApprovalDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.behavior === "allow") {
    return (
      (value.answer === undefined || boundedOptionalEmptyString(value.answer, MAX_MESSAGE_LENGTH)) &&
      (value.updatedInput === undefined || isRecord(value.updatedInput))
    );
  }
  return (
    value.behavior === "deny" && boundedOptionalEmptyString(value.message, MAX_MESSAGE_LENGTH)
  );
}
