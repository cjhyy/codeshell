/**
 * Durable routing between one external IM conversation and one Work Session.
 *
 * Three relationships already pointed an IM conversation at a Work Session
 * before this module existed: a DelegateWork launch (PetLongTask
 * completionTarget), a WatchSession subscription, and — new — explicitly
 * entering a Session so the chat talks to it directly. All three need the same
 * things: existence checks, terminal reconciliation, restart recovery and
 * fail-closed revocation. They are therefore one record with a `mode`, not
 * three stores.
 *
 * `notify` means "send this conversation the Session's terminal outcome".
 * `bound` means "this conversation currently IS the Session's chat". Entering
 * upgrades notify → bound; leaving downgrades bound → notify rather than
 * deleting, so a user who exits still receives the completion they were
 * waiting for.
 *
 * This module is pure domain logic: no fs, no clock, no channel access. The
 * host owns persistence (desktop conversation-session-route-store.ts) and
 * every authorization decision.
 */

export const CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION = 1;

export type ConversationSessionRouteMode = "notify" | "bound";
export type ConversationSessionRouteOrigin = "delegate" | "watch" | "enter";
export type ConversationSessionRouteStatus = "active" | "suspended";

/**
 * Why a bound route stopped being usable. Every reason is terminal for the
 * `bound` mode: the next inbound message goes back to Mimi rather than being
 * delivered somewhere the user did not intend.
 */
export type ConversationSessionRouteSuspendReason =
  | "session-missing"
  | "session-archived"
  | "workspace-missing"
  | "worktree-missing"
  | "authorization-revoked"
  | "session-terminal";

/** Why a bound route was downgraded back to notify. */
export type ConversationSessionRouteLeaveReason = "user" | "expired" | "terminal" | "suspended";

export interface ConversationSessionRoute {
  schemaVersion: typeof CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION;
  id: string;
  /**
   * Stable conversation identity: `im:<channel>\0<target>\0<senderId>`. Built
   * by the host (petChatRouteKey) and never by the model. A route key missing
   * target or sender is not addressable and must be rejected, not guessed.
   */
  routeKey: string;
  channel: string;
  target: string;
  senderId: string;
  sessionId: string;
  /** Display cache only. `sessionId` is the sole authority for identity. */
  sessionTitle: string;
  mode: ConversationSessionRouteMode;
  origin: ConversationSessionRouteOrigin;
  status: ConversationSessionRouteStatus;
  suspendedReason?: ConversationSessionRouteSuspendReason;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastInboundAt?: number;
  /** When a bound route auto-downgrades for inactivity. Unset for notify. */
  expiresAt?: number;
  /** Last time the user was told they are still inside a Session. */
  stalePromptAt?: number;
}

/** A bound route with no inbound traffic for this long downgrades itself. */
export const BOUND_ROUTE_IDLE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * After this much silence the next message gets one deterministic reminder
 * that it is about to enter a Session, before it is delivered. Prevents a
 * next-day "check the weather" from landing in yesterday's coding Session
 * with no warning.
 */
export const BOUND_ROUTE_STALE_PROMPT_MS = 2 * 60 * 60 * 1000;

const MAX_ID_LENGTH = 128;
const MAX_ROUTE_KEY_LENGTH = 512;
const MAX_TITLE_LENGTH = 160;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A route key embeds NUL separators by construction, so it is checked for
 * length and shape rather than for control characters.
 */
function isRouteKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ROUTE_KEY_LENGTH;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARACTER_RE.test(value)
  );
}

function isMode(value: unknown): value is ConversationSessionRouteMode {
  return value === "notify" || value === "bound";
}

function isOrigin(value: unknown): value is ConversationSessionRouteOrigin {
  return value === "delegate" || value === "watch" || value === "enter";
}

function isSuspendReason(value: unknown): value is ConversationSessionRouteSuspendReason {
  return (
    value === "session-missing" ||
    value === "session-archived" ||
    value === "workspace-missing" ||
    value === "worktree-missing" ||
    value === "authorization-revoked" ||
    value === "session-terminal"
  );
}

export interface CreateConversationSessionRouteInput {
  id: string;
  routeKey: string;
  channel: string;
  target: string;
  senderId: string;
  sessionId: string;
  sessionTitle: string;
  mode: ConversationSessionRouteMode;
  origin: ConversationSessionRouteOrigin;
  now: number;
}

export function createConversationSessionRoute(
  input: CreateConversationSessionRouteInput,
): ConversationSessionRoute | undefined {
  if (
    !isBoundedText(input.id, MAX_ID_LENGTH) ||
    !isRouteKey(input.routeKey) ||
    !isBoundedText(input.channel, 64) ||
    !isBoundedText(input.target, 256) ||
    !isBoundedText(input.senderId, 256) ||
    !isBoundedText(input.sessionId, MAX_ID_LENGTH) ||
    !isMode(input.mode) ||
    !isOrigin(input.origin) ||
    safeInteger(input.now) === undefined
  ) {
    return undefined;
  }
  // Validate the title AFTER normalizing it: trimming and slicing must not be
  // able to smuggle a control character past the check, and the session-id
  // fallback has to satisfy the same rule the stored value does.
  const normalizedTitle = input.sessionTitle.trim().slice(0, MAX_TITLE_LENGTH);
  const title = normalizedTitle || input.sessionId;
  if (!isBoundedText(title, MAX_TITLE_LENGTH)) return undefined;
  return {
    schemaVersion: CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION,
    id: input.id,
    routeKey: input.routeKey,
    channel: input.channel,
    target: input.target,
    senderId: input.senderId,
    sessionId: input.sessionId,
    sessionTitle: title,
    mode: input.mode,
    origin: input.origin,
    status: "active",
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.mode === "bound" ? { expiresAt: input.now + BOUND_ROUTE_IDLE_EXPIRY_MS } : {}),
  };
}

/**
 * Reject anything that is not a well-formed route rather than repairing it.
 * A half-understood route could deliver a user's message into the wrong
 * Session, so an unreadable row is dropped and the conversation falls back to
 * Mimi. One bad row never blocks the rest of the file.
 */
export function parseConversationSessionRoute(
  value: unknown,
): ConversationSessionRoute | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (value.schemaVersion !== CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION) return undefined;
  const createdAt = safeInteger(value.createdAt);
  const updatedAt = safeInteger(value.updatedAt);
  const revision = safeInteger(value.revision);
  if (
    !isBoundedText(value.id, MAX_ID_LENGTH) ||
    !isRouteKey(value.routeKey) ||
    !isBoundedText(value.channel, 64) ||
    !isBoundedText(value.target, 256) ||
    !isBoundedText(value.senderId, 256) ||
    !isBoundedText(value.sessionId, MAX_ID_LENGTH) ||
    !isBoundedText(value.sessionTitle, MAX_TITLE_LENGTH) ||
    !isMode(value.mode) ||
    !isOrigin(value.origin) ||
    (value.status !== "active" && value.status !== "suspended") ||
    createdAt === undefined ||
    updatedAt === undefined ||
    revision === undefined
  ) {
    return undefined;
  }
  if (value.suspendedReason !== undefined && !isSuspendReason(value.suspendedReason)) {
    return undefined;
  }
  const lastInboundAt =
    value.lastInboundAt === undefined ? undefined : safeInteger(value.lastInboundAt);
  if (value.lastInboundAt !== undefined && lastInboundAt === undefined) return undefined;
  const expiresAt = value.expiresAt === undefined ? undefined : safeInteger(value.expiresAt);
  if (value.expiresAt !== undefined && expiresAt === undefined) return undefined;
  const stalePromptAt =
    value.stalePromptAt === undefined ? undefined : safeInteger(value.stalePromptAt);
  if (value.stalePromptAt !== undefined && stalePromptAt === undefined) return undefined;
  return {
    schemaVersion: CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION,
    id: value.id,
    routeKey: value.routeKey,
    channel: value.channel,
    target: value.target,
    senderId: value.senderId,
    sessionId: value.sessionId,
    sessionTitle: value.sessionTitle,
    mode: value.mode,
    origin: value.origin,
    status: value.status,
    ...(value.suspendedReason ? { suspendedReason: value.suspendedReason } : {}),
    revision,
    createdAt,
    updatedAt,
    ...(lastInboundAt !== undefined ? { lastInboundAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(stalePromptAt !== undefined ? { stalePromptAt } : {}),
  };
}

/** Upgrade a route to `bound`: this conversation now talks to the Session. */
export function enterConversationSessionRoute(
  route: ConversationSessionRoute,
  now: number,
): ConversationSessionRoute {
  return {
    ...route,
    mode: "bound",
    origin: "enter",
    status: "active",
    suspendedReason: undefined,
    revision: route.revision + 1,
    updatedAt: now,
    expiresAt: now + BOUND_ROUTE_IDLE_EXPIRY_MS,
    stalePromptAt: undefined,
  };
}

/**
 * Downgrade to `notify` instead of deleting. The user stops chatting with the
 * Session but still gets told when it finishes — that is what makes Mimi a
 * front desk rather than a switch.
 */
export function leaveConversationSessionRoute(
  route: ConversationSessionRoute,
  now: number,
  reason: ConversationSessionRouteLeaveReason,
): ConversationSessionRoute {
  return {
    ...route,
    mode: "notify",
    status: reason === "suspended" ? route.status : "active",
    revision: route.revision + 1,
    updatedAt: now,
    expiresAt: undefined,
    stalePromptAt: undefined,
  };
}

/** Mark a route unusable. The caller then routes the message back to Mimi. */
export function suspendConversationSessionRoute(
  route: ConversationSessionRoute,
  now: number,
  reason: ConversationSessionRouteSuspendReason,
): ConversationSessionRoute {
  return {
    ...route,
    mode: "notify",
    status: "suspended",
    suspendedReason: reason,
    revision: route.revision + 1,
    updatedAt: now,
    expiresAt: undefined,
    stalePromptAt: undefined,
  };
}

export function recordConversationSessionRouteInbound(
  route: ConversationSessionRoute,
  now: number,
): ConversationSessionRoute {
  return {
    ...route,
    revision: route.revision + 1,
    updatedAt: now,
    lastInboundAt: now,
    ...(route.mode === "bound" ? { expiresAt: now + BOUND_ROUTE_IDLE_EXPIRY_MS } : {}),
  };
}

export function markConversationSessionRouteStalePrompted(
  route: ConversationSessionRoute,
  now: number,
): ConversationSessionRoute {
  return { ...route, revision: route.revision + 1, updatedAt: now, stalePromptAt: now };
}

export function isConversationSessionRouteExpired(
  route: ConversationSessionRoute,
  now: number,
): boolean {
  if (route.mode !== "bound") return false;
  return route.expiresAt !== undefined && now >= route.expiresAt;
}

/**
 * True when the user should get one reminder that they are still inside a
 * Session before this message is delivered to it. Sent at most once per quiet
 * period so an active conversation is never nagged.
 */
export function shouldPromptConversationSessionRouteStale(
  route: ConversationSessionRoute,
  now: number,
): boolean {
  if (route.mode !== "bound" || route.status !== "active") return false;
  const since = route.lastInboundAt ?? route.createdAt;
  if (now - since < BOUND_ROUTE_STALE_PROMPT_MS) return false;
  return route.stalePromptAt === undefined || route.stalePromptAt <= since;
}

/**
 * The bound route for a conversation, if it is still usable right now.
 * Expiry is evaluated at read time so a route that aged out while the app was
 * closed never captures the next message.
 */
export function activeBoundRoute(
  routes: readonly ConversationSessionRoute[],
  routeKey: string,
  now: number,
): ConversationSessionRoute | undefined {
  return routes.find(
    (route) =>
      route.routeKey === routeKey &&
      route.mode === "bound" &&
      route.status === "active" &&
      !isConversationSessionRouteExpired(route, now),
  );
}
