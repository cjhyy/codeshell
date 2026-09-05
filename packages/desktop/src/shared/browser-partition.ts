/**
 * The single definition of how a browser bucket becomes an Electron partition.
 *
 * A partition IS the cookie jar, so main and the renderer MUST agree byte for
 * byte: capture/restore, panel mounting and the guest registry all key off this
 * string, and a one-character disagreement silently points them at different
 * login state. It previously existed as two independent copies (renderer
 * `app/appUtils.ts` and main `browser-driver/active-guest.ts`) plus two separate
 * definitions of the Quick Chat prefix, which is exactly the drift this module
 * removes.
 *
 * Lives in `shared/` because both processes already import from here; the
 * renderer must not import main modules and vice versa.
 */

/** Repo key standing in for the process-local Quick Chat scope. */
export const QUICK_CHAT_REPO_KEY = "__quick_chat__";

/** Bucket prefix identifying a Quick Chat bucket (`<repo key>::`). */
export const QUICK_CHAT_BUCKET_PREFIX = `${QUICK_CHAT_REPO_KEY}::`;

/** Persistent partition prefix — survives restarts, holds real login state. */
export const BROWSER_PARTITION_PREFIX = "persist:browser";

/**
 * Quick Chat partition prefix. Deliberately NOT `persist:` — a quick chat's
 * browser state is process-local and must not outlive the window.
 */
export const QUICK_CHAT_PARTITION_PREFIX = "browser:qchat";

/**
 * Restrict a bucket to characters that are safe in an Electron partition name.
 * Applied with no trimming: the result is compared for equality across the IPC
 * boundary, so both sides must normalize identically.
 */
export function sanitizeBrowserBucket(bucket: string): string {
  return bucket.replace(/[^a-zA-Z0-9_:.@-]/g, "_");
}

/** True when this bucket belongs to a process-local Quick Chat. */
export function isQuickChatBucket(bucket: string): boolean {
  return bucket.startsWith(QUICK_CHAT_BUCKET_PREFIX);
}

// The bucket → partition entry point lives in ./browser-profile.ts: the
// partition is derived from the PROFILE, and that module imports these
// primitives, so putting it here would create an import cycle.
