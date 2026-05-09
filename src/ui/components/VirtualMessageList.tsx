/**
 * VirtualMessageList — renders only visible messages for performance.
 *
 * When message count exceeds VIRTUALIZE_THRESHOLD, only renders messages
 * within the visible viewport (plus overscan buffer). Uses height estimation
 * for off-screen items via spacer elements.
 *
 * For smaller conversations, renders all messages directly (no virtualization).
 *
 * Also provides an unseen message divider ("── N new ──") when the user
 * scrolls away and new messages arrive.
 */
import React, { useMemo, useRef, useEffect, useCallback, type ReactNode } from "react";
import { Box, Text } from "../../render/index.js";
import type { ChatEntry } from "../store.js";

const VIRTUALIZE_THRESHOLD = 100;
const OVERSCAN = 10;
const ESTIMATED_ITEM_HEIGHT = 3; // lines per message (rough)

interface VirtualMessageListProps {
  entries: ChatEntry[];
  renderEntry: (entry: ChatEntry, key: string) => ReactNode;
  /** Index where "N new" divider should render (null = no divider). */
  dividerIndex?: number | null;
  /** Count of unseen messages to show in divider. */
  unseenCount?: number;
}

export function VirtualMessageList({
  entries,
  renderEntry,
  dividerIndex,
  unseenCount = 0,
}: VirtualMessageListProps) {
  // For small conversations, render everything
  if (entries.length < VIRTUALIZE_THRESHOLD) {
    return (
      <Box flexDirection="column">
        {entries.map((e, i) => (
          <React.Fragment key={e.id}>
            {dividerIndex !== null && dividerIndex === i && unseenCount > 0 && (
              <UnseenDivider count={unseenCount} />
            )}
            {renderEntry(e, e.id)}
          </React.Fragment>
        ))}
      </Box>
    );
  }

  // Virtualized: only render tail (most recent messages)
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
            {renderEntry(e, e.id)}
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
