import { type PetReusableSessionOption, type PetWorkspaceOption } from "./delegation.js";
import {
  isPetHostActionKind,
  type PetGatewayReplyCapability,
  type PetHostActionKind,
} from "./host-actions.js";
import { parsePetGatewayCatalog, type PetGatewayCatalog } from "./gateway.js";

const MAX_RUNTIME_CONTEXT_LENGTH = 32_768;
const MAX_WORKSPACES = 64;
const MAX_REUSABLE_SESSIONS = 32;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4_096;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/u;

export interface PetRunOptions {
  workspaces: readonly PetWorkspaceOption[];
  reusableSessions: readonly PetReusableSessionOption[];
  /** Host-action kinds the host declared it can execute this turn. */
  hostActionKinds: readonly PetHostActionKind[];
  /** Exact outbound route contract backing GatewayReply for this turn. */
  gatewayReply?: PetGatewayReplyCapability;
  /** Adapter-owned first-level discovery catalog backing the Gateway tool. */
  gateway?: PetGatewayCatalog;
  /** Host-provided sessions directory backing the Sessions tool. */
  sessionsRootDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value === value.trim() &&
    !CONTROL_CHARACTER_RE.test(value)
  );
}

function normalizedName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_NAME_LENGTH) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function normalizedDescription(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_LENGTH) return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function parseWorkspaces(value: unknown): PetWorkspaceOption[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACES) return undefined;
  const ids = new Set<string>();
  const result: PetWorkspaceOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !validOpaqueId(entry.id) || ids.has(entry.id)) return undefined;
    const name = normalizedName(entry.name);
    const description = normalizedDescription(entry.description);
    if (!name || description === null) return undefined;
    ids.add(entry.id);
    result.push({
      id: entry.id,
      name,
      ...(description ? { description } : {}),
    });
  }
  return result;
}

function parseReusableSessions(value: unknown): PetReusableSessionOption[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_REUSABLE_SESSIONS) return undefined;
  const ids = new Set<string>();
  const result: PetReusableSessionOption[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !validOpaqueId(entry.id) ||
      !validOpaqueId(entry.workspaceId) ||
      ids.has(entry.id)
    ) {
      return undefined;
    }
    const name = normalizedName(entry.name);
    const description = normalizedDescription(entry.description);
    if (!name || description === null) return undefined;
    ids.add(entry.id);
    result.push({
      id: entry.id,
      workspaceId: entry.workspaceId,
      name,
      ...(description ? { description } : {}),
    });
  }
  return result;
}

function freezeOptions(options: {
  workspaces: PetWorkspaceOption[];
  reusableSessions: PetReusableSessionOption[];
  hostActionKinds: PetHostActionKind[];
  gatewayReply?: PetGatewayReplyCapability;
  gateway?: PetGatewayCatalog;
  sessionsRootDir?: string;
}): PetRunOptions {
  return Object.freeze({
    workspaces: Object.freeze(options.workspaces.map((entry) => Object.freeze(entry))),
    reusableSessions: Object.freeze(options.reusableSessions.map((entry) => Object.freeze(entry))),
    hostActionKinds: Object.freeze(options.hostActionKinds),
    ...(options.gatewayReply ? { gatewayReply: options.gatewayReply } : {}),
    ...(options.gateway ? { gateway: options.gateway } : {}),
    ...(options.sessionsRootDir ? { sessionsRootDir: options.sessionsRootDir } : {}),
  });
}

function parseSessionsRootDir(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Fail closed: any non-array or unknown/duplicate kind hides every host-action tool. */
function parseHostActionKinds(value: unknown): PetHostActionKind[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const kinds: PetHostActionKind[] = [];
  for (const entry of value) {
    if (!isPetHostActionKind(entry) || kinds.includes(entry)) return undefined;
    kinds.push(entry);
  }
  return kinds;
}

function parseGatewayReplyCapability(value: unknown): PetGatewayReplyCapability | undefined {
  if (!isRecord(value)) return undefined;
  if (
    Object.keys(value).some(
      (key) =>
        key !== "button" &&
        key !== "attachments" &&
        key !== "maxTextLength" &&
        key !== "maxAttachments" &&
        key !== "maxAttachmentBytes",
    ) ||
    (value.button !== "native" && value.button !== "link") ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > 4 ||
    !value.attachments.every((kind) =>
      ["image", "file", "audio", "video"].includes(String(kind)),
    ) ||
    new Set(value.attachments).size !== value.attachments.length ||
    !Number.isSafeInteger(value.maxTextLength) ||
    Number(value.maxTextLength) < 1 ||
    Number(value.maxTextLength) > 8_000 ||
    !Number.isSafeInteger(value.maxAttachments) ||
    Number(value.maxAttachments) < 1 ||
    Number(value.maxAttachments) > 4 ||
    !Number.isSafeInteger(value.maxAttachmentBytes) ||
    Number(value.maxAttachmentBytes) < 1 ||
    Number(value.maxAttachmentBytes) > 10 * 1024 * 1024
  ) {
    return undefined;
  }
  return Object.freeze({
    button: value.button,
    attachments: Object.freeze([...value.attachments]) as readonly (
      | "image"
      | "file"
      | "audio"
      | "video"
    )[],
    maxTextLength: Number(value.maxTextLength),
    maxAttachments: Number(value.maxAttachments),
    maxAttachmentBytes: Number(value.maxAttachmentBytes),
  });
}

/**
 * Build an immutable, bounded per-turn snapshot for the Pet behavior profile.
 *
 * AgentServer validates the same shapes before dispatch. This second line of
 * defense matters for in-process Engine hosts, which can invoke the behavior
 * profile directly without crossing the protocol validator.
 */
export function petRunOptionsFrom(profileParams: Readonly<Record<string, unknown>>): PetRunOptions {
  const declaredHostActionKinds = parseHostActionKinds(profileParams.hostActions) ?? [];
  const gatewayReply =
    profileParams.gatewayReply === undefined
      ? undefined
      : parseGatewayReplyCapability(profileParams.gatewayReply);
  const gateway =
    profileParams.gateway === undefined ? undefined : parsePetGatewayCatalog(profileParams.gateway);
  const sessionsRootDir = parseSessionsRootDir(profileParams.sessionsRootDir);
  const hostActionKinds = declaredHostActionKinds.filter(
    (kind) => kind !== "gatewayReply" || gatewayReply !== undefined,
  );
  const empty = freezeOptions({
    workspaces: [],
    reusableSessions: [],
    hostActionKinds,
    ...(gatewayReply ? { gatewayReply } : {}),
    ...(gateway ? { gateway } : {}),
    ...(sessionsRootDir ? { sessionsRootDir } : {}),
  });
  const workspaces =
    profileParams.workspaces === undefined ? [] : parseWorkspaces(profileParams.workspaces);
  const reusableSessions =
    profileParams.reusableSessions === undefined
      ? []
      : parseReusableSessions(profileParams.reusableSessions);
  if (!workspaces || !reusableSessions) return empty;
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  if (reusableSessions.some((session) => !workspaceIds.has(session.workspaceId))) return empty;
  return freezeOptions({
    workspaces,
    reusableSessions,
    hostActionKinds,
    ...(gatewayReply ? { gatewayReply } : {}),
    ...(gateway ? { gateway } : {}),
    ...(sessionsRootDir ? { sessionsRootDir } : {}),
  });
}

function validateRuntimeContext(value: unknown, label: string): string | null {
  if (typeof value !== "string" || value.length > MAX_RUNTIME_CONTEXT_LENGTH) {
    return `${label} must be bounded JSON`;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return `${label} must be a JSON object`;
  } catch {
    return `${label} must be valid JSON`;
  }
  return null;
}

/**
 * Pet-specific agent/run params validation. Canonical profileParams keys win
 * over legacy pet aliases, matching Engine's merge precedence.
 */
export function validatePetRunParams(params: Record<string, unknown>): string | null {
  const hasLegacyRuntimeContext = params.petRuntimeContext !== undefined;
  const hasLegacyWorkspaces = params.petWorkspaces !== undefined;
  const isPetRequest =
    params.behaviorMode === "pet" ||
    params.kind === "pet" ||
    hasLegacyRuntimeContext ||
    hasLegacyWorkspaces;
  if (!isPetRequest) return null;

  if (hasLegacyRuntimeContext && (params.behaviorMode !== "pet" || params.kind !== "pet")) {
    return "petRuntimeContext requires behaviorMode=pet and kind=pet";
  }
  if (hasLegacyWorkspaces && (params.behaviorMode !== "pet" || params.kind !== "pet")) {
    return "petWorkspaces requires behaviorMode=pet and kind=pet";
  }
  if (params.behaviorMode === "pet" && params.kind !== "pet") {
    return "behaviorMode=pet requires kind=pet";
  }
  if (params.kind === "pet" && params.behaviorMode !== undefined && params.behaviorMode !== "pet") {
    return "kind=pet cannot use a non-pet behaviorMode";
  }

  if (
    params.profileParams !== undefined &&
    (!params.profileParams ||
      typeof params.profileParams !== "object" ||
      Array.isArray(params.profileParams))
  ) {
    return "profileParams must be an object";
  }
  const profileParams = params.profileParams as Record<string, unknown> | undefined;
  const hasCanonicalRuntimeContext =
    profileParams !== undefined &&
    Object.prototype.hasOwnProperty.call(profileParams, "runtimeContext");
  const hasCanonicalWorkspaces =
    profileParams !== undefined &&
    Object.prototype.hasOwnProperty.call(profileParams, "workspaces");
  const hasCanonicalReusableSessions =
    profileParams !== undefined &&
    Object.prototype.hasOwnProperty.call(profileParams, "reusableSessions");
  const hasCanonicalHostActions =
    profileParams !== undefined &&
    Object.prototype.hasOwnProperty.call(profileParams, "hostActions");
  const hasCanonicalGatewayReply =
    profileParams !== undefined &&
    Object.prototype.hasOwnProperty.call(profileParams, "gatewayReply");
  const hasCanonicalGateway =
    profileParams !== undefined && Object.prototype.hasOwnProperty.call(profileParams, "gateway");

  const runtimeContext = hasCanonicalRuntimeContext
    ? profileParams.runtimeContext
    : params.petRuntimeContext;
  if (runtimeContext !== undefined) {
    const error = validateRuntimeContext(
      runtimeContext,
      hasCanonicalRuntimeContext ? "profileParams.runtimeContext" : "petRuntimeContext",
    );
    if (error) return error;
  }

  const workspaces = hasCanonicalWorkspaces ? profileParams.workspaces : params.petWorkspaces;
  const parsedWorkspaces = workspaces === undefined ? [] : parseWorkspaces(workspaces);
  if (workspaces !== undefined && !parsedWorkspaces) {
    return `${hasCanonicalWorkspaces ? "profileParams.workspaces" : "petWorkspaces"} contains an invalid or duplicate Workspace`;
  }

  if (hasCanonicalReusableSessions) {
    const parsedReusableSessions = parseReusableSessions(profileParams.reusableSessions);
    if (!parsedReusableSessions) {
      return "profileParams.reusableSessions contains an invalid or duplicate reusable Session";
    }
    const workspaceIds = new Set((parsedWorkspaces ?? []).map((workspace) => workspace.id));
    if (parsedReusableSessions.some((session) => !workspaceIds.has(session.workspaceId))) {
      return "profileParams.reusableSessions contains a Session outside the closed Workspace set";
    }
  }

  if (hasCanonicalHostActions && !parseHostActionKinds(profileParams.hostActions)) {
    return "profileParams.hostActions contains an invalid or duplicate host-action kind";
  }
  const parsedHostActionKinds = parseHostActionKinds(profileParams?.hostActions) ?? [];
  if (parsedHostActionKinds.includes("gatewayReply") && !hasCanonicalGatewayReply) {
    return "the gatewayReply host action requires profileParams.gatewayReply";
  }
  if (hasCanonicalGatewayReply && !parseGatewayReplyCapability(profileParams.gatewayReply)) {
    return "profileParams.gatewayReply contains an invalid Gateway route capability";
  }
  if (hasCanonicalGatewayReply && !parsedHostActionKinds.includes("gatewayReply")) {
    return "profileParams.gatewayReply requires the gatewayReply host action";
  }
  if (hasCanonicalGateway && !parsePetGatewayCatalog(profileParams.gateway)) {
    return "profileParams.gateway contains an invalid Gateway capability catalog";
  }

  return null;
}
