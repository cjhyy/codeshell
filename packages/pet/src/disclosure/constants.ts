/**
 * Pure disclosure constants, deliberately free of any node: imports so that
 * browser-safe modules (e.g. sessions-tool.ts, which only dynamically imports
 * the fs-backed readers) can statically import them.
 */

/** Shared cap on L2 latest-result text (Mimi Sessions tool + desktop work tree). */
export const LATEST_RESULT_MAX_CHARS = 2_000;
