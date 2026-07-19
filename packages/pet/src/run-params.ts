import { type PetReusableSessionOption, type PetWorkspaceOption } from "./delegation.js";

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
}): PetRunOptions {
  return Object.freeze({
    workspaces: Object.freeze(options.workspaces.map((entry) => Object.freeze(entry))),
    reusableSessions: Object.freeze(options.reusableSessions.map((entry) => Object.freeze(entry))),
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
  const empty = freezeOptions({
    workspaces: [],
    reusableSessions: [],
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

  return null;
}
