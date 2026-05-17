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
  Static,
  type ScrollBoxHandle,
} from "../../render/index.js";
import { type ChatEntry, isEntryFinalized } from "../store.js";
import { MessageRow } from "./MessageRow.js";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";
import { useFullscreenMode } from "../fullscreen-mode.js";

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

    // Flow mode: no ScrollBox, no virtual windowing. Partition entries into:
    //   - committed (finalized + not currently streaming) → <Static> so they
    //     are appended to stdout once and skipped by future diff cycles.
    //   - active tail (last entry if still streaming + any trailing
    //     non-finalized rows) → normal React tree, redrawn each frame.
    // This is CC's playbook: append-only history + a tiny live region.
    // The terminal's scrollback owns the committed content; the diff engine
    // only ever rewrites the active rows, so no flicker / no scroll-to-top.
    if (!fullscreen) {
      // Walk from the end to find the start of the active region. Anything
      // not finalized (streaming assistant_text, tool_running, thinking)
      // OR matching streamingEntryId belongs to the active region.
      let activeStart = entries.length;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const isActive = !isEntryFinalized(e) || streamingEntryId === e.id;
        if (isActive) {
          activeStart = i;
        } else {
          // Once we hit a finalized entry, everything before is committed.
          break;
        }
      }
      const committed = entries.slice(0, activeStart);
      const active = entries.slice(activeStart);
      const activeBaseIdx = activeStart;

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
          <Static<ChatEntry>
            items={committed}
            children={(e, i) => renderRow(e, i)}
          />
          {active.map((e, i) => renderRow(e, activeBaseIdx + i))}
        </Box>
      );
    }

    const [start, end] = range;

    return (
      <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" stickyScroll>
        {/* Topspacer: hold layout for unrendered items above. spacerRef
            lets useVirtualScroll read listOrigin via Yoga computedTop. */}
        <Box ref={spacerRef} height={topSpacer} flexShrink={0} />

        {entries.slice(start, end).map((e, i) => {
          const globalIdx = start + i;
          const isSelected = selectedEntryId === e.id;
          return (
            <React.Fragment key={e.id}>
              {dividerIndex !== null && dividerIndex === globalIdx && unseenCount > 0 && (
                <UnseenDivider count={unseenCount} />
              )}
              <Box ref={measureRef(e.id)} flexDirection="column" flexShrink={0}>
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

        {/* Bottom spacer: hold layout for unrendered items below. */}
        <Box height={bottomSpacer} flexShrink={0} />
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
