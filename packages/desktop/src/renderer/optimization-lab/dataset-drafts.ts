/** Window-lifetime drafts only. Export JSON to retain material across app restarts.
 * Keep raw text, including invalid JSON, separate from immutable worker artifacts.
 * Project IDs are opaque keys (never object properties or filesystem paths).
 */
export const datasetDrafts = new Map<string, string>();
