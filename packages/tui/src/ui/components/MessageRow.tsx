/**
 * MessageRow — memo boundary around a single chat entry's rendered output.
 *
 * Why this exists: stream events fire dozens of times per second. Without
 * a memo boundary, every entry's renderer (markdown lexing, Yoga layout,
 * syntax-highlight token cache) re-runs on every frame, defeating ink's
 * blit fast-path. The hand-written comparator below mirrors Claude Code
 * 2.1.88's areMessageRowPropsEqual: bail only when we are CERTAIN the
 * entry didn't change.
 *
 * Why `render` is excluded from the comparator (intentional, see CC's
 * VirtualItem note): when entry/columns/isStreaming all match, React.memo
 * returns the PREVIOUS rendered ReactNode — it does NOT invoke render
 * again with the new closure, so a stale-closure-on-bail scenario is
 * impossible. Including `render` in the comparator would defeat memo
 * entirely (render is fresh on every parent render).
 */
import React, { type ReactNode } from "react";
import type { ChatEntry } from "../store.js";

export interface MessageRowProps {
  entry: ChatEntry;
  /** Terminal columns — affects text wrap inside the renderer. */
  columns: number;
  /**
   * True iff this entry is the one currently receiving stream deltas.
   * Streaming rows never memo-bail (their text grows mid-frame).
   */
  isStreaming: boolean;
  /**
   * True iff this entry is the transcript-mode cursor target. State
   * external to the entry that affects rendering (cursor outline) must
   * be a prop so the comparator can invalidate when it flips. CC handles
   * cursor/hover/expanded the same way on its VirtualItem.
   */
  isSelected: boolean;
  /**
   * True when long entries should render expanded (transcript mode).
   * Flipping this re-renders every row — low-frequency event, acceptable.
   */
  expanded: boolean;
  /**
   * Called with the entry when we actually need to render. Excluded
   * from the memo comparator on purpose (see file header).
   */
  render: (entry: ChatEntry) => ReactNode;
}

function MessageRowImpl({ entry, render }: MessageRowProps) {
  return <>{render(entry)}</>;
}

/**
 * Returns true when the row can safely skip re-render. False on any
 * uncertainty — we fail safe by re-rendering.
 */
export function areMessageRowPropsEqual(
  prev: MessageRowProps,
  next: MessageRowProps,
): boolean {
  // Content identity — Task 2 guarantees this stays stable for entries
  // that didn't actually change.
  if (prev.entry !== next.entry) return false;
  // Terminal width drives text wrap — must re-measure.
  if (prev.columns !== next.columns) return false;
  // Streaming rows grow mid-frame — never safe to skip.
  if (prev.isStreaming || next.isStreaming) return false;
  // Cursor moved onto or off this row — re-render to update outline.
  if (prev.isSelected !== next.isSelected) return false;
  // Expanded/collapsed mode changed — every row must re-render.
  if (prev.expanded !== next.expanded) return false;
  return true;
}

export const MessageRow = React.memo(MessageRowImpl, areMessageRowPropsEqual);
