/**
 * Pure classifiers for electron-updater error messages. Kept free of any
 * electron import so they're unit-testable under `bun test` (importing
 * updater.ts pulls in electron, which can't load in the test runtime).
 */

export function isReadOnlyInstallError(message: string): boolean {
  return /read-only volume|move the application|move .* out of the Downloads directory/i.test(message);
}

/**
 * True when an update request failed because the remote feed could not be
 * reached. Keep this separate from HTTP/auth failures: those are actionable,
 * while an offline or blocked GitHub connection is expected in some networks.
 */
export function isUpdateFeedConnectivityError(message: string): boolean {
  return (
    /\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE)\b/i.test(
      message,
    ) ||
    /\b(?:ERR_(?:CONNECTION|NAME|INTERNET|NETWORK|PROXY)[A-Z_]*|UND_ERR_CONNECT_TIMEOUT)\b/i.test(
      message,
    ) ||
    /(?:connection|network) (?:error|failed|timed out)|socket hang up|client network socket disconnected|could not connect|fetch failed/i.test(
      message,
    )
  );
}

/**
 * True when the error is "no update manifest is published (yet)" rather than a
 * real failure. Happens in the window between pushing a release tag and CI
 * finishing the upload of latest-*.yml: electron-updater fetches the manifest,
 * gets a GitHub 404, and throws a raw HttpError. That is NOT an error the user
 * should see as a red stack trace — it just means "no update available right
 * now".
 */
export function isNoUpdateManifestError(message: string): boolean {
  return (
    /HttpError:\s*404/i.test(message) ||
    /\b404\b/.test(message) ||
    /Cannot find (latest-\S*\.yml|channel)/i.test(message) ||
    /latest-\S*\.yml/i.test(message)
  );
}
