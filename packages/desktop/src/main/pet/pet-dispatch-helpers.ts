import { createHash } from "node:crypto";
import {
  isPetHostActionRequest,
  isPetWorkExecutionBackend,
  type PetContextOriginRef,
  type PetGroundedTaskRef,
  type PetGatewayReplyCapability,
  type PetWorkDelegation,
} from "@cjhyy/code-shell-pet";
import { sessionSelectorId } from "@cjhyy/code-shell-pet/disclosure";
import type { PetPersonalization } from "../../shared/pet-settings.js";
import type { PetContextEventKind } from "./pet-context-links.js";
import type { PetDispatchOptions, PetHostActionExecution } from "./pet-dispatch-service.js";

/**
 * Pure helpers shared by the dispatch service and the manager turns moved
 * out of it (closure, report): the bounded runtime context, workspace and
 * reusable-Session ids, and readers for a manager run's Pet results.
 */

export interface PetWorldContextInput {
  message: string;
  clientMessageId: string;
  eventKind: PetContextEventKind;
  originRef: PetContextOriginRef;
  /** Related host-ledger references, not current instructions or continuation authority. */
  groundedTasks: PetGroundedTaskRef[];
  associationState: "available" | "unavailable" | "disabled";
}

export function contextAssociationFor(input: PetWorldContextInput): Record<string, unknown> {
  return {
    originRef: input.originRef,
    eventKind: input.eventKind,
    clientMessageId: input.clientMessageId,
    groundedTasks: input.groundedTasks,
    associationState: input.associationState,
  };
}

export const NO_WORKSPACE_ID = "no-workspace";
const MAX_PET_RUNTIME_CONTEXT_LENGTH = 32_768;
const OMIT_JSON_VALUE = Symbol("omit-json-value");

/**
 * Keep the final serialized runtime context inside the Pet protocol limit.
 * Values are retained in insertion order; arrays therefore keep only a valid
 * prefix (the memory store is newest-first), while oversized strings/objects
 * are recursively shortened instead of rejecting the whole manager turn.
 */
export function stringifyBoundedPetWorld(world: Readonly<Record<string, unknown>>): string {
  // Fast path: JSON.stringify already omits undefined-valued keys, so an
  // in-budget world serializes to exactly what the per-key trimming below
  // would produce — without the O(keys) full-size checks.
  try {
    const serialized = serializePetWorldJson(world);
    if (serialized !== undefined && serialized.length <= MAX_PET_RUNTIME_CONTEXT_LENGTH) {
      return serialized;
    }
  } catch {
    // Unserializable values fall through to the per-key trimming below.
  }
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(world)) {
    if (value === undefined) continue;
    const fitted = fitJsonValue(value, (candidate) =>
      jsonFits({ ...bounded, [key]: candidate }, MAX_PET_RUNTIME_CONTEXT_LENGTH),
    );
    if (fitted !== OMIT_JSON_VALUE) bounded[key] = fitted;
  }
  return serializePetWorldJson(bounded) ?? "{}";
}

function fitJsonValue(
  value: unknown,
  fits: (candidate: unknown) => boolean,
): unknown | typeof OMIT_JSON_VALUE {
  if (fits(value)) return value;
  if (typeof value === "string") {
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(value.slice(0, middle))) low = middle;
      else high = middle - 1;
    }
    return fits(value.slice(0, low)) ? value.slice(0, low) : OMIT_JSON_VALUE;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      if (!fits([...result, entry])) break;
      result.push(entry);
    }
    return fits(result) ? result : OMIT_JSON_VALUE;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    let entries: [string, unknown][];
    try {
      entries = Object.entries(value);
    } catch {
      return OMIT_JSON_VALUE;
    }
    for (const [key, entry] of entries) {
      if (entry === undefined) continue;
      const fitted = fitJsonValue(entry, (candidate) => fits({ ...result, [key]: candidate }));
      if (fitted !== OMIT_JSON_VALUE) result[key] = fitted;
    }
    return fits(result) ? result : OMIT_JSON_VALUE;
  }
  return OMIT_JSON_VALUE;
}

/**
 * The one serializer for the pet world. Untrusted strings must not be able to
 * close or spoof the <pet-world> wrapper, so every `<` is escaped; budgets are
 * measured on this escaped form because it is what the model run receives.
 */
function serializePetWorldJson(value: unknown): string | undefined {
  const serialized = JSON.stringify(value);
  return typeof serialized === "string" ? serialized.replace(/</g, "\\u003c") : undefined;
}

function jsonFits(value: unknown, maximum: number): boolean {
  try {
    const serialized = serializePetWorldJson(value);
    return serialized !== undefined && serialized.length <= maximum;
  } catch {
    return false;
  }
}

/**
 * Trailing separators must not split one workspace into two ids: the tracked
 * project list and a disk session's cwd can disagree only by a trailing slash
 * (e.g. "/work/site/" vs "/work/site"). Mirrors the normalization the former
 * renderer PetAutoDelegationHost applied before this moved into the host.
 */
export function normalizeWorkspacePath(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

export function workspaceIdForPath(path: string): string {
  return `workspace-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

/**
 * Reusable-Session selectors are the shared disclosure convention, so the ids
 * Mimi reads from the Sessions tool and the ids this host injects/validates
 * can never drift apart.
 */
export const reusableSessionId = sessionSelectorId;

function parsePetWorkDelegation(value: unknown): PetWorkDelegation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.workspaceId !== "string" ||
    !record.workspaceId.trim() ||
    typeof record.objective !== "string" ||
    !record.objective.trim()
  ) {
    return null;
  }
  if (
    record.reusableSessionId !== undefined &&
    (typeof record.reusableSessionId !== "string" || !record.reusableSessionId.trim())
  ) {
    return null;
  }
  if (
    record.executionBackend !== undefined &&
    !isPetWorkExecutionBackend(record.executionBackend)
  ) {
    return null;
  }
  return {
    workspaceId: record.workspaceId.trim(),
    objective: record.objective.trim(),
    ...(record.executionBackend === "codex" ? { executionBackend: "codex" as const } : {}),
    ...(typeof record.reusableSessionId === "string"
      ? { reusableSessionId: record.reusableSessionId.trim() }
      : {}),
    // Retain even malformed evidence for the shared fail-closed reuse gate.
    // An old/invalid proof requests new work; it must never authorize reuse.
    ...(record.continuationEvidence !== undefined
      ? {
          continuationEvidence:
            record.continuationEvidence as PetWorkDelegation["continuationEvidence"],
        }
      : {}),
  };
}

export function readPetWorkDelegations(result: unknown): PetWorkDelegation[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  // New shape: RunResult.extensions.pet.workDelegation (generic result slot);
  // legacy petWorkDelegation mirror kept as fallback for older workers.
  const extensions = (result as { extensions?: unknown }).extensions;
  const petExtension =
    extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? (extensions as { pet?: unknown }).pet
      : undefined;
  const petResults =
    petExtension && typeof petExtension === "object" && !Array.isArray(petExtension)
      ? (petExtension as { workDelegation?: unknown; workDelegations?: unknown })
      : undefined;
  if (Array.isArray(petResults?.workDelegations)) {
    if (petResults.workDelegations.length > 8) return [];
    const parsed = petResults.workDelegations.map(parsePetWorkDelegation);
    return parsed.every((entry): entry is PetWorkDelegation => entry !== null) ? parsed : [];
  }
  const delegation =
    petResults?.workDelegation ?? (result as { petWorkDelegation?: unknown }).petWorkDelegation;
  const parsed = parsePetWorkDelegation(delegation);
  return parsed ? [parsed] : [];
}

export function readPetHostActionRequests(
  result: unknown,
  allowedKinds: ReadonlySet<string>,
): Array<{ kind: string; payload: Record<string, unknown> }> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const extensions = (result as { extensions?: unknown }).extensions;
  const petExtension =
    extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? (extensions as { pet?: unknown }).pet
      : undefined;
  const reported =
    petExtension && typeof petExtension === "object" && !Array.isArray(petExtension)
      ? (petExtension as { hostActions?: unknown }).hostActions
      : undefined;
  if (!Array.isArray(reported) || reported.length > 8) return [];
  const requests: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const seenKinds = new Set<string>();
  for (const entry of reported) {
    if (!isPetHostActionRequest(entry)) return [];
    const { kind, payload } = entry;
    if (!allowedKinds.has(kind) || seenKinds.has(kind)) {
      return [];
    }
    seenKinds.add(kind);
    requests.push({ kind, payload: payload as Record<string, unknown> });
  }
  return requests;
}

/**
 * What a manager turn moved out of PetDispatchService needs from it: its
 * options and the shared turn plumbing (admission, world context, host
 * actions). The service passes itself; nothing here is new behaviour.
 */
export interface PetManagerTurnHost {
  readonly options: PetDispatchOptions;
  getReplyAttachmentRoots(): Promise<string[]>;
  currentPersonalization(): Promise<PetPersonalization | undefined>;
  prepareWorldContextInput(
    input: Omit<PetWorldContextInput, "groundedTasks" | "associationState">,
    knownTasks?: PetGroundedTaskRef[],
  ): Promise<PetWorldContextInput>;
  recallWorld(input: PetWorldContextInput): Promise<Record<string, unknown>>;
  /** One background manager run on Mimi's Session, admitted like a chat turn. */
  requestManagerRun(
    params: Record<string, unknown>,
    producer: string,
  ): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }>;
  executeHostActions(
    requests: Array<{ kind: string; payload: Record<string, unknown> }>,
    gatewayReplyCapability?: PetGatewayReplyCapability,
    replayIdentity?: { petSessionId: string; clientMessageId?: string },
  ): Promise<PetHostActionExecution[]>;
}
