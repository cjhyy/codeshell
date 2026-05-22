/**
 * SliceAnchor — UUID-anchored cap for the flow-mode chat slice.
 *
 * Flow mode renders all entries through Ink's normal diff path (no <Static>),
 * relying on the terminal's native scrollback for history. To keep yoga
 * layout and the screen buffer bounded, we slice the rendered list to a
 * fixed cap. The naive `entries.slice(-CAP)` shifts the head by one on every
 * append — that means row 0 of prev and row 0 of next describe different
 * content, and log-update's diff sees changes at scrollback rows it can't
 * reach, forcing a fullResetSequence_CAUSES_FLICKER per turn.
 *
 * Fix: anchor the slice start to a specific entry id and only advance when
 * (entries.length - start) exceeds CAP + STEP. Quantizing in STEP-sized
 * chunks turns "flicker every append" into "flicker every STEP appends".
 *
 * The anchor stores BOTH id and idx — if the anchored id disappears (rare
 * for chat entries since ids are stable, but defensive), we fall back to
 * the stored idx clamped into range, instead of resetting to 0 which would
 * try to render the full history at once.
 *
 * Mirrors Claude Code's computeSliceStart in src/components/Messages.tsx.
 */

export const DEFAULT_CAP = 200;
export const DEFAULT_STEP = 50;

export type SliceAnchor = { id: string; idx: number } | null;

export interface AnchorRef {
  current: SliceAnchor;
}

/**
 * Returns the index at which the rendered slice should start. May mutate
 * `anchorRef.current` to refresh the stored anchor when the window advances
 * or the anchored id has shifted in the entries array.
 *
 * @param entries - The full, post-filter chat entries (must expose `.id`).
 * @param anchorRef - Mutable container for the persistent anchor.
 * @param cap - Soft maximum entries to render. Window advances past this.
 * @param step - Hysteresis: only advance when length exceeds cap + step.
 */
export function computeSliceStart(
  entries: ReadonlyArray<{ id: string }>,
  anchorRef: AnchorRef,
  cap = DEFAULT_CAP,
  step = DEFAULT_STEP,
): number {
  const anchor = anchorRef.current;
  const anchorIdx = anchor ? entries.findIndex((e) => e.id === anchor.id) : -1;

  // Anchor found → keep the slice pinned to the anchored id.
  // Anchor lost → fall back to stored idx (clamped) so we don't reset to 0
  //   and rerender the entire history.
  // No anchor yet → start at 0.
  let start =
    anchorIdx >= 0
      ? anchorIdx
      : anchor
        ? Math.min(anchor.idx, Math.max(0, entries.length - cap))
        : 0;

  // Window advanced past cap+step → step the anchor forward to the new tail-cap.
  if (entries.length - start > cap + step) {
    start = entries.length - cap;
  }

  // Refresh anchor — captures a new id after advancement, or heals a stale
  // id after the clamped-idx fallback.
  const atStart = entries[start];
  if (atStart && (anchor?.id !== atStart.id || anchor.idx !== start)) {
    anchorRef.current = { id: atStart.id, idx: start };
  } else if (!atStart && anchor) {
    anchorRef.current = null;
  }

  return start;
}
