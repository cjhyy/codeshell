/**
 * The browser bucket for an externally-driven session.
 *
 * Per-session rather than the renderer's active bucket: buckets select a
 * browser partition, so reusing the user's would put the runtime's automation
 * in the same cookie jar and login state as the tab they are looking at.
 */
export function externalRuntimeBrowserBucket(sessionId: string): string {
  return `external-runtime:${sessionId}`;
}
