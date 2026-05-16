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
import type { ChatEntry } from "../store.js";
import { MessageRow } from "./MessageRow.js";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";
import { FULLSCREEN_MODE, TAIL_ENTRY_LIMIT } from "../fullscreen-mode.js";

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

    // Flow mode: no ScrollBox, no virtual windowing, no measureRef wiring.
    // Render only the most recent TAIL_ENTRY_LIMIT entries; older content
    // is in the terminal's scrollback. The Box flows downward; the terminal
    // (iTerm/Ghostty/tmux) owns scrolling.
    if (!FULLSCREEN_MODE) {
      const tailStart = Math.max(0, entries.length - TAIL_ENTRY_LIMIT);
      const tail = entries.slice(tailStart);
      return (
        <Box flexDirection="column">
          {tail.map((e, i) => {
            const globalIdx = tailStart + i;
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
          })}
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
