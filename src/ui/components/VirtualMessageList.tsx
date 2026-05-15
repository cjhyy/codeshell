/**
 * VirtualMessageList — renders chat entries with a memo boundary per row.
 *
 * Each entry is wrapped in <MessageRow>, which is React.memo'd with a
 * hand-written comparator. Entries whose object reference doesn't change
 * (stable history) skip re-render entirely; only the streaming row,
 * cursor selection, and width changes invalidate.
 *
 * Cursor-outline decoration is applied OUTSIDE the memo boundary so the
 * inner render closure (renderEntry) doesn't need to know about selection
 * state — keeping it stable across cursor moves.
 *
 * For >VIRTUALIZE_THRESHOLD conversations the head is dropped to keep
 * react reconciliation bounded — Task 4 (P3) replaces this with proper
 * ScrollBox-based virtual scrolling.
 *
 * Also provides an unseen message divider ("── N new ──") when the user
 * scrolls away and new messages arrive.
 */
import React, { type ReactNode } from "react";
import { Box, Text } from "../../render/index.js";
import type { ChatEntry } from "../store.js";
import { MessageRow } from "./MessageRow.js";

const VIRTUALIZE_THRESHOLD = 100;
const OVERSCAN = 10;

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

function renderRow(
  e: ChatEntry,
  renderEntry: (entry: ChatEntry, key: string, expanded: boolean) => ReactNode,
  columns: number,
  streamingEntryId: string | null,
  selectedEntryId: string | null,
  expanded: boolean,
): ReactNode {
  const isSelected = selectedEntryId === e.id;
  return (
    <CursorOutline active={isSelected}>
      <MessageRow
        entry={e}
        columns={columns}
        isStreaming={streamingEntryId === e.id}
        isSelected={isSelected}
        expanded={expanded}
        // render closure captures `expanded`; it's only invoked on memo
        // miss, which the comparator triggers when `expanded` changes —
        // so the captured value is always fresh.
        render={(en) => renderEntry(en, en.id, expanded)}
      />
    </CursorOutline>
  );
}

export function VirtualMessageList({
  entries,
  renderEntry,
  columns,
  streamingEntryId = null,
  selectedEntryId = null,
  expanded = false,
  dividerIndex,
  unseenCount = 0,
}: VirtualMessageListProps) {
  // For small conversations, render everything.
  if (entries.length < VIRTUALIZE_THRESHOLD) {
    return (
      <Box flexDirection="column">
        {entries.map((e, i) => (
          <React.Fragment key={e.id}>
            {dividerIndex !== null && dividerIndex === i && unseenCount > 0 && (
              <UnseenDivider count={unseenCount} />
            )}
            {renderRow(e, renderEntry, columns, streamingEntryId, selectedEntryId, expanded)}
          </React.Fragment>
        ))}
      </Box>
    );
  }

  // Virtualized: only render tail (most recent messages).
  // In a terminal REPL, the user is almost always at the bottom,
  // so we optimize for the tail-render case.
  const start = Math.max(0, entries.length - VIRTUALIZE_THRESHOLD - OVERSCAN);
  const visibleEntries = entries.slice(start);
  const hiddenCount = start;

  return (
    <Box flexDirection="column">
      {/* Top spacer for hidden messages */}
      {hiddenCount > 0 && (
        <Box marginLeft={1}>
          <Text dim>{"── "}{hiddenCount}{" earlier messages ──"}</Text>
        </Box>
      )}

      {/* Visible messages */}
      {visibleEntries.map((e, i) => {
        const globalIdx = start + i;
        return (
          <React.Fragment key={e.id}>
            {dividerIndex !== null && dividerIndex === globalIdx && unseenCount > 0 && (
              <UnseenDivider count={unseenCount} />
            )}
            {renderRow(e, renderEntry, columns, streamingEntryId, selectedEntryId, expanded)}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

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
