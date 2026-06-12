// Session-bucketed anchor state helpers (浏览器圈选统一架构, spec
// 2026-06-12-browser-marker-unified-design.md).
//
// Anchors used to be ONE App-level array, so a draft's annotations leaked into
// whatever session you switched to. They are now keyed by the same bucketKey()
// the transcripts map / permissionOverrides use (`${repoKey}::${sessionId ??
// "_none_"}`), so switching sessions switches annotation sets. Pure functions
// over the Record so App stays slim and this stays unit-testable.

import type { Anchor } from "./anchors";

export type AnchorsByBucket = Record<string, Anchor[]>;

// Stable empty list: `state[bucket] ?? []` would mint a NEW array identity on
// every call, which cascades through App's useMemo/useEffect chain into a
// sync-IPC send per render while a bucket has no annotations.
const EMPTY: Anchor[] = [];

export function anchorsIn(state: AnchorsByBucket, bucket: string): Anchor[] {
  return state[bucket] ?? EMPTY;
}

export function addAnchorTo(
  state: AnchorsByBucket,
  bucket: string,
  anchor: Anchor,
): AnchorsByBucket {
  return { ...state, [bucket]: [...anchorsIn(state, bucket), anchor] };
}

export function removeAnchorFrom(
  state: AnchorsByBucket,
  bucket: string,
  anchorId: string,
): AnchorsByBucket {
  const cur = anchorsIn(state, bucket);
  const next = cur.filter((a) => a.id !== anchorId);
  if (next.length === cur.length) return state;
  return { ...state, [bucket]: next };
}

/** Update one anchor's comment in place (marker edit card / popout edit). */
export function updateAnchorCommentIn(
  state: AnchorsByBucket,
  bucket: string,
  anchorId: string,
  comment: string,
): AnchorsByBucket {
  const cur = anchorsIn(state, bucket);
  let touched = false;
  const next = cur.map((a) => {
    if (a.id !== anchorId || a.comment === comment) return a;
    touched = true;
    return { ...a, comment };
  });
  return touched ? { ...state, [bucket]: next } : state;
}

/**
 * Clear the buckets involved in a just-sent message. The send path can promote
 * a draft (sessionId null → real id) BEFORE ChatView fires onClearAnchors, so
 * clearing only the (new) active bucket would orphan the draft slot's anchors —
 * they'd resurface on the next 新对话 (same "_none_ 粘连" failure mode as
 * permissionOverrides #11). Clear both the active bucket and the repo's draft
 * bucket; anchors are draft-scoped, so both belong to "what was just sent".
 */
export function clearAnchorBuckets(
  state: AnchorsByBucket,
  buckets: string[],
): AnchorsByBucket {
  let next: AnchorsByBucket | null = null;
  for (const b of buckets) {
    if ((next ?? state)[b]?.length) {
      next = { ...(next ?? state), [b]: [] };
    }
  }
  return next ?? state;
}

/** The browser-kind subset (the echo set broadcast to browser surfaces). */
export function browserAnchorsOf(anchors: Anchor[]): Anchor[] {
  return anchors.filter((a) => a.kind === "browser" && !!a.browser);
}
