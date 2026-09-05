/**
 * Which browser identity a Session browses as.
 *
 * A partition IS the cookie jar. It used to be derived from the bucket — which
 * carries the sessionId — so every new Session started logged out of
 * everything: 72 partition dirs and 1.9 GB on one developer machine, with a
 * single project holding 14 separate jars for the same sites.
 *
 * The profile is now the unit of login state, and the Session is not:
 *
 * - default `shared-auth`: one profile per project, so a login done in one
 *   Session is there in the next one;
 * - explicit selection: a Session may name its own profile when it must NOT
 *   share (two accounts on one site, a test tenant beside production), or may
 *   name a shared one across projects (a company SSO);
 * - Quick Chat is always process-local and can never be pointed at a
 *   persistent jar.
 *
 * See docs/todo/browser-profile-workspace-lease-design.md §3.1.
 */

import {
  BROWSER_PARTITION_PREFIX,
  QUICK_CHAT_PARTITION_PREFIX,
  isQuickChatBucket,
  sanitizeBrowserBucket,
} from "./browser-partition.js";

/** Namespace for a profile derived from a project. */
const PROJECT_PROFILE_PREFIX = "p";

/** Namespace for a profile the user named explicitly. */
const NAMED_PROFILE_PREFIX = "u";

/** Namespace for the process-local Quick Chat profile. */
const QUICK_CHAT_PROFILE_PREFIX = "q";

const MAX_PROFILE_ID_LENGTH = 128;

/**
 * A user-supplied profile name is usable. Deliberately strict: this string ends
 * up inside a partition name, so anything that could collide with another
 * profile's namespace or climb out of it is refused rather than sanitized into
 * something surprising.
 */
export function isBrowserProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_ID_LENGTH &&
    value.trim() === value &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(value)
  );
}

/** Project segment of a bucket (`<project>::<session>`); the session is dropped. */
function projectSegmentOf(bucket: string): string {
  const sep = bucket.indexOf("::");
  return sep >= 0 ? bucket.slice(0, sep) : bucket;
}

/**
 * The profile a bucket uses when the Session made no explicit choice: one per
 * project, shared by every Session and the project's draft slot.
 */
export function browserProfileIdForBucket(bucket: string): string {
  if (isQuickChatBucket(bucket)) {
    // Process-local: keyed by the full bucket so two quick chats stay apart.
    return `${QUICK_CHAT_PROFILE_PREFIX}:${sanitizeBrowserBucket(bucket)}`;
  }
  return `${PROJECT_PROFILE_PREFIX}:${sanitizeBrowserBucket(projectSegmentOf(bucket))}`;
}

/** The default profile — a no-repo Session with no explicit choice. */
export const DEFAULT_BROWSER_PROFILE_ID = browserProfileIdForBucket("__no_repo__::_none_");

/**
 * Resolve the profile for one bucket, honouring an explicit choice.
 *
 * Quick Chat ignores `chosen` on purpose: letting it name a persistent profile
 * would leave login state behind after the window closes, which is exactly what
 * its non-persistent partition exists to prevent. An absent or unusable choice
 * falls back to the project default rather than producing a partition named
 * after garbage.
 */
export function resolveBrowserProfileId(bucket: string, chosen: unknown): string {
  if (isQuickChatBucket(bucket)) return browserProfileIdForBucket(bucket);
  if (!isBrowserProfileId(chosen)) return browserProfileIdForBucket(bucket);
  return `${NAMED_PROFILE_PREFIX}:${chosen}`;
}

/**
 * Electron partition for a profile. The Quick Chat namespace maps to the
 * non-persistent prefix; everything else persists across restarts.
 */
export function browserPartitionForProfile(profileId: string): string {
  const prefix = profileId.startsWith(`${QUICK_CHAT_PROFILE_PREFIX}:`)
    ? QUICK_CHAT_PARTITION_PREFIX
    : BROWSER_PARTITION_PREFIX;
  return `${prefix}:${sanitizeBrowserBucket(profileId)}`;
}

/**
 * Electron partition for one browser bucket, via that bucket's profile.
 *
 * The partition is derived from the PROFILE, never from the sessionId — that is
 * Phase 1 of docs/todo/browser-profile-workspace-lease-design.md. A second
 * Session in the same project therefore reuses the first one's login state
 * instead of starting from an empty cookie jar.
 *
 * `chosenProfileId` lets a Session opt out of the project default when it must
 * not share (two accounts on one site) or must share more widely (one SSO login
 * across projects). Keep this the only place that decides the shape.
 */
export function browserPartitionForBucket(bucket: string, chosenProfileId?: unknown): string {
  return browserPartitionForProfile(resolveBrowserProfileId(bucket, chosenProfileId));
}

/**
 * How a profile should be described to a person.
 *
 * The capture/inject UI has to state the SCOPE of a cookie jar, not just its
 * id: users were previously told they were capturing "this session" while the
 * jar was in fact shared by every session in the project.
 */
export interface BrowserProfileLabel {
  scope: "project" | "named" | "temporary" | "unknown";
  /** The project id, the chosen name, or the raw id when unrecognised. */
  name: string;
}

export function browserProfileLabel(profileId: string): BrowserProfileLabel {
  const cut = profileId.indexOf(":");
  const prefix = cut >= 0 ? profileId.slice(0, cut) : "";
  const rest = cut >= 0 ? profileId.slice(cut + 1) : profileId;
  if (prefix === PROJECT_PROFILE_PREFIX) return { scope: "project", name: rest };
  if (prefix === NAMED_PROFILE_PREFIX) return { scope: "named", name: rest };
  if (prefix === QUICK_CHAT_PROFILE_PREFIX) return { scope: "temporary", name: rest };
  return { scope: "unknown", name: profileId };
}
