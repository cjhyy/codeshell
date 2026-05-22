/**
 * VirtualMessageList — ScrollBox + viewport-windowed chat rendering.
 *
 * Owns its own ScrollBox + useVirtualScroll. Only items in the viewport
 * (+ overscan) are mounted as React fibers / Yoga nodes; the rest live
 * as height-equivalent topSpacer / bottomSpacer boxes. ScrollBox handles
 * sticky-bottom, wheel/key scroll, render-time clamping.
 *
 * Each rendered item is wrapped in <MessageRow> (React.memo) so historical
 * entries skip re-render entirely on stream ticks. Cursor-outline decoration
 * is applied OUTSIDE the memo boundary so the render closure stays cursor-
 * agnostic.
 *
 * Auto-stick: when entries grow while ScrollBox is "sticky" (default + after
 * scrollToBottom), the view follows the tail. User scrolling up breaks
 * stickiness; clicking the "N new messages" pill should call onJumpToNew
 * which ultimately invokes scrollToBottom (wired via the imperative handle).
 */
import React, { forwardRef, useImperativeHandle, useMemo, useRef, type ReactNode } from "react";
import {
  Box,
  Text,
  ScrollBox,
  type ScrollBoxHandle,
} from "../../render/index.js";
import { type ChatEntry } from "../store.js";
import { MessageRow } from "./MessageRow.js";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";
import { useFullscreenMode } from "../fullscreen-mode.js";
import { computeSliceStart, type AnchorRef } from "../slice-anchor.js";

interface VirtualMessageListProps {
  entries: ChatEntry[];
  renderEntry: (entry: ChatEntry, key: string, expanded: boolean) => ReactNode;
  /** Terminal width — threaded into MessageRow so width changes invalidate memo. */
  columns: number;
  /** Id of the entry currently receiving stream deltas (null = no stream). */
  streamingEntryId?: string | null;
  /** Id of the entry under the transcript-mode cursor (null = no cursor). */
  selectedEntryId?: string | null;
  /** True when long entries should render expanded (transcript mode). */
  expanded?: boolean;
  /** Index where "N new" divider should render (null = no divider). */
  dividerIndex?: number | null;
  /** Count of unseen messages to show in divider. */
  unseenCount?: number;
}

export interface VirtualMessageListHandle {
  scrollToBottom: () => void;
  scrollBy: (dy: number) => void;
  getViewportHeight: () => number;
}

/**
 * Wraps a row in a left-border outline when it is the transcript cursor target.
 * Kept outside MessageRow so the row's render closure stays cursor-agnostic.
 */
function CursorOutline({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return <>{children}</>;
  return (
    <Box
      borderStyle="single"
      borderColor="ansi:cyan"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      paddingLeft={1}
    >
      {children}
    </Box>
  );
}

export const VirtualMessageList = forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(
  function VirtualMessageList(
    {
      entries,
      renderEntry,
      columns,
      streamingEntryId = null,
      selectedEntryId = null,
      expanded = false,
      dividerIndex,
      unseenCount = 0,
    },
    ref,
  ) {
    const scrollRef = useRef<ScrollBoxHandle | null>(null);
    // Persistent slice anchor for flow mode. Defined at the top level so React
    // hook order stays stable across the fullscreen / flow branch below — the
    // ref is harmlessly unused in fullscreen.
    const sliceAnchorRef = useRef<AnchorRef["current"]>(null);

    useImperativeHandle(ref, () => ({
      scrollToBottom: () => scrollRef.current?.scrollToBottom(),
      scrollBy: (dy) => scrollRef.current?.scrollBy(dy),
      getViewportHeight: () => scrollRef.current?.getViewportHeight() ?? 0,
    }));

    // Stable, identity-preserving array of keys. Recomputed only when entries
    // identity changes (Task 2 guarantees that's only when content changed).
    // Computed in both modes so React hook order stays stable across the
    // FULLSCREEN_MODE branch below.
    const keys = useMemo(() => entries.map((e) => e.id), [entries]);

    const {
      range,
      topSpacer,
      bottomSpacer,
      measureRef,
      spacerRef,
    } = useVirtualScroll(scrollRef, keys, columns);

    const { fullscreen } = useFullscreenMode();

    // Flow mode: all entries render through the normal React/Ink diff path,
    // with a UUID-anchored slice cap to keep yoga layout and the screen
    // buffer bounded. Older entries dropped from this slice live in the
    // terminal's native scrollback — users can scroll up natively.
    //
    // The slice anchor is the key to avoiding per-turn flicker: a naive
    // entries.slice(-CAP) shifts the head by one on every append, and
    // log-update's diff sees changes at scrollback rows it can't reach,
    // forcing a fullResetSequence. UUID anchoring keeps the head pinned
    // until length exceeds CAP+STEP — flicker happens once per STEP
    // appends instead of once per append.
    //
    // <Static> is intentionally NOT used here: it appends ANSI at the
    // current physical cursor (parked inside the prompt input mid-session),
    // which corrupts the prompt area and produces overwrite artifacts.
    // Kept as an ink primitive (src/render/components/Static.tsx) for
    // future use cases, but not used by this list.
    if (!fullscreen) {
      const sliceStart = computeSliceStart(entries, sliceAnchorRef);
      const visible = sliceStart > 0 ? entries.slice(sliceStart) : entries;
      const sliceBase = sliceStart;

      const renderRow = (e: ChatEntry, globalIdx: number): ReactNode => {
        const isSelected = selectedEntryId === e.id;
        return (
          <React.Fragment key={e.id}>
            {dividerIndex !== null && dividerIndex === globalIdx && unseenCount > 0 && (
              <UnseenDivider count={unseenCount} />
            )}
            <Box flexDirection="column" flexShrink={0}>
              <CursorOutline active={isSelected}>
                <MessageRow
                  entry={e}
                  columns={columns}
                  isStreaming={streamingEntryId === e.id}
                  isSelected={isSelected}
                  expanded={expanded}
                  render={(en) => renderEntry(en, en.id, expanded)}
                />
              </CursorOutline>
            </Box>
          </React.Fragment>
        );
      };

      return (
        <Box flexDirection="column">
          {visible.map((e, i) => renderRow(e, sliceBase + i))}
        </Box>
      );
    }

    const [start, end] = range;

    return (
      <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" stickyScroll>
        {/* Topspacer: hold layout for unrendered items above. spacerRef
            lets useVirtualScroll read listOrigin via Yoga computedTop.
            overflow="hidden" is critical: every scroll bin crossing
            rebuilds offsets and changes this Box's height, marking it
            dirty. As the FIRST child of ScrollBox a plain dirty spacer
            would cancel blit on every subsequent item (renderChildren
            in render-node-to-output.ts:1306 short-circuits prevScreen
            on the first non-clipped dirty sibling), forcing 100%
            writes for the entire viewport and producing the scrolling
            flicker we see in ui-ink logs as bursts of
            `High write ratio: blit=0`. Marking the spacer clipsBothAxes
            shunts its dirty into seenDirtyClipped, leaving the
            siblings' blit path intact. */}
        <Box ref={spacerRef} height={topSpacer} flexShrink={0} overflow="hidden" />

        {entries.slice(start, end).map((e, i) => {
          const globalIdx = start + i;
          const isSelected = selectedEntryId === e.id;
          return (
            <React.Fragment key={e.id}>
              {dividerIndex !== null && dividerIndex === globalIdx && unseenCount > 0 && (
                <UnseenDivider count={unseenCount} />
              )}
              {/* overflow="hidden": each item is a clipsBothAxes child of
                  ScrollBox, so when one item is dirty (newly mounted on a
                  scroll-bin crossing, or re-rendered because heightCache
                  bumped offsetVersion mid-frame) its dirty flag goes into
                  seenDirtyClipped instead of seenDirtyChild — the next
                  item still gets prevScreen and can blit. Without this,
                  one dirty item poisons the blit path for every item
                  below it (render-node-to-output.ts:1306) and we slide
                  back into 100%-writes flicker on scroll. CC dodges this
                  via React Compiler-driven element identity; we don't
                  have that yet, so the overflow-clip shield is our
                  equivalent. Item content is laid out vertically and
                  never paints outside its computed bounds, so clipping
                  is a no-op visually. */}
              <Box
                ref={measureRef(e.id)}
                flexDirection="column"
                flexShrink={0}
                overflow="hidden"
              >
                <CursorOutline active={isSelected}>
                  <MessageRow
                    entry={e}
                    columns={columns}
                    isStreaming={streamingEntryId === e.id}
                    isSelected={isSelected}
                    expanded={expanded}
                    render={(en) => renderEntry(en, en.id, expanded)}
                  />
                </CursorOutline>
              </Box>
            </React.Fragment>
          );
        })}

        {/* Bottom spacer: conditional render to match CC's
            VirtualMessageList:867. When bottomSpacer is 0 (scrolled to
            the bottom — the steady state for streaming and most
            interactions) leaving NO node here means totalHeight equals
            sum(item heights), which keeps the renderer's DECSTBM
            fast-path heightDelta check stable across spinner ticks
            and message growth. Rendering an always-mounted spacer with
            height={0} caused its height attribute to flip 0↔N every
            heightCache mutation, breaking the safeForFastPath guard
            (render-node-to-output.ts:937) and falling back to a full
            viewport rewrite. */}
        {bottomSpacer > 0 && (
          <Box height={bottomSpacer} flexShrink={0} overflow="hidden" />
        )}
      </ScrollBox>
    );
  },
);

function UnseenDivider({ count }: { count: number }) {
  return (
    <Box marginY={0} marginLeft={1}>
      <Text dim>{"────── "}</Text>
      <Text color="ansi:cyanBright" bold>
        {count} new
      </Text>
      <Text dim>{" ──────"}</Text>
    </Box>
  );
}
