/**
 * FullscreenLayout — CC-style fullscreen terminal layout.
 *
 * Structure:
 *   ┌──────────────────────────┐
 *   │  scrollable (messages)   │  ← grows, scrollable
 *   │  overlay (permissions)   │  ← renders inside scroll area
 *   ├──────────────────────────┤
 *   │  bottom (prompt/spinner) │  ← pinned at bottom
 *   └──────────────────────────┘
 *   [pill: "N new messages"]      ← absolute, shown when scrolled away
 *
 * Supports:
 * - Scrollable message area with sticky-scroll
 * - Overlay content (permission dialogs inside scroll)
 * - "N new messages" pill when user scrolls up
 * - Modal pane for slash-command dialogs
 */
import React, { useState, useRef, useEffect, useCallback, type RefObject, type ReactNode } from "react";
import { Box, Text, useInput, AlternateScreen } from "../../render/index.js";

interface FullscreenLayoutProps {
  /** Main scrollable content (messages). */
  scrollable: ReactNode;
  /** Bottom-pinned content (prompt input, spinner). */
  bottom: ReactNode;
  /** Overlay content rendered after scrollable (permission dialogs). */
  overlay?: ReactNode;
  /** Count of unseen messages (for pill display). */
  newMessageCount?: number;
  /** Called when user clicks "jump to new" pill. */
  onJumpToNew?: () => void;
  /** Whether to show the unseen messages pill. */
  showPill?: boolean;
}

export function FullscreenLayout({
  scrollable,
  bottom,
  overlay,
  newMessageCount = 0,
  onJumpToNew,
  showPill = false,
}: FullscreenLayoutProps) {
  return (
    <AlternateScreen>
      <Box flexDirection="column" flexGrow={1}>
        {/* Scrollable area — alt-screen has no terminal scrollback, so we
            clip overflow inside the viewport here. Task 4 replaces this
            with a real ScrollBox; until then, content beyond the viewport
            is hidden rather than corrupting the screen. */}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {scrollable}
          {overlay}
        </Box>

        {/* Unseen messages pill */}
        {showPill && newMessageCount > 0 && (
          <Box justifyContent="center" marginY={0}>
            <Text
              color="ansi:black"
              backgroundColor="ansi:cyanBright"
              bold
            >
              {` ↓ ${newMessageCount} new message${newMessageCount > 1 ? "s" : ""} `}
            </Text>
          </Box>
        )}

        {/* Bottom pinned area */}
        <Box flexDirection="column" flexShrink={0}>
          {bottom}
        </Box>
      </Box>
    </AlternateScreen>
  );
}

/**
 * Hook for tracking unseen messages when user scrolls up.
 *
 * Returns:
 * - dividerIndex: where the "new messages" boundary is
 * - showPill: whether to display the unseen pill
 * - onNewMessage: call when a new message arrives
 * - onScrollToBottom: call when user scrolls to bottom or types
 */
export function useUnseenDivider(messageCount: number) {
  const [dividerIndex, setDividerIndex] = useState<number | null>(null);
  const [isScrolledAway, setIsScrolledAway] = useState(false);

  const onScrollAway = useCallback(() => {
    if (dividerIndex === null) {
      setDividerIndex(messageCount);
    }
    setIsScrolledAway(true);
  }, [dividerIndex, messageCount]);

  const onScrollToBottom = useCallback(() => {
    setDividerIndex(null);
    setIsScrolledAway(false);
  }, []);

  // Clear divider if message count drops (e.g., /clear)
  useEffect(() => {
    if (dividerIndex !== null && messageCount < dividerIndex) {
      setDividerIndex(null);
      setIsScrolledAway(false);
    }
  }, [messageCount, dividerIndex]);

  const unseenCount = dividerIndex !== null ? messageCount - dividerIndex : 0;

  return {
    dividerIndex,
    showPill: isScrolledAway && unseenCount > 0,
    unseenCount,
    onScrollAway,
    onScrollToBottom,
  };
}
