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
import { FULLSCREEN_MODE } from "../fullscreen-mode.js";

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
  // In flow mode (FULLSCREEN_MODE=false): no alt-screen, no flexGrow on the
  // outer columns, no "new messages" pill (there is no scroll-away state to
  // pill about — content has already flowed into the terminal's scrollback).
  const body = (
    <Box flexDirection="column" flexGrow={FULLSCREEN_MODE ? 1 : 0}>
      {/* Scrollable area — VirtualMessageList owns its own ScrollBox in
          fullscreen mode. Don't wrap in an overflow-hidden Box: ScrollBox
          needs to read its own viewport height via Yoga, and an outer clip
          can confuse the measurement on resize. */}
      <Box flexDirection="column" flexGrow={FULLSCREEN_MODE ? 1 : 0}>
        {scrollable}
        {overlay}
      </Box>

      {FULLSCREEN_MODE && showPill && newMessageCount > 0 && (
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
  );

  return FULLSCREEN_MODE ? <AlternateScreen>{body}</AlternateScreen> : body;
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
