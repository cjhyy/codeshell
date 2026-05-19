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
import { useFullscreenMode } from "../fullscreen-mode.js";
import { chatStore } from "../store.js";

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
  const { fullscreen } = useFullscreenMode();
  // Track previous mode to detect the fullscreen→flow transition and flush
  // existing transcript text to the terminal scrollback before alt-screen
  // exits. Otherwise older entries (currently rendered inside alt-screen but
  // not the most-recent TAIL_ENTRY_LIMIT) would vanish on switch.
  const prevFullscreenRef = useRef(fullscreen);
  useEffect(() => {
    const prev = prevFullscreenRef.current;
    prevFullscreenRef.current = fullscreen;
    if (prev === true && fullscreen === false) {
      // Switching to flow. Write current transcript to stdout BEFORE React
      // commits the unmount of AlternateScreen — actually, we can't easily
      // do that here (effect runs after commit), so we accept that the
      // alt-screen has already exited by the time this fires. Print the
      // text into the now-main screen so it occupies the scrollback.
      const entries = chatStore.getEntries();
      if (entries.length === 0) return;
      const lines: string[] = [];
      for (const e of entries) {
        // Render a single text-summary line per entry. Detailed formatting
        // (ANSI, code fences, tool result framing) is intentionally skipped:
        // the alternate-screen content was already wiped and we just want
        // the historical context discoverable via terminal scrollback. The
        // user can /resume in fullscreen mode for the full render.
        switch (e.type) {
          case "user":            lines.push(`> ${e.text}`); break;
          case "assistant_text":  lines.push(e.text); break;
          case "tool_start":      lines.push(`[${e.toolName}] running…`); break;
          case "tool_result":     lines.push(`[${e.toolName}] ${e.error ? "✗ " + e.error : "✓"}`); break;
          case "status":          lines.push(`(${e.reason})`); break;
          case "system":          lines.push(e.text ? `── ${e.text} ──` : ""); break;
          case "error":           lines.push(`error: ${e.error}`); break;
          default:                lines.push("");
        }
      }
      const text = lines.filter(Boolean).join("\n") + "\n";
      process.stdout.write(text);
    }
  }, [fullscreen]);

  // In flow mode: no alt-screen, no flexGrow on the outer columns, no "new
  // messages" pill (there is no scroll-away state to pill about — content
  // has already flowed into the terminal's scrollback).
  const body = (
    <Box flexDirection="column" flexGrow={fullscreen ? 1 : 0}>
      {/* Scrollable area — VirtualMessageList owns its own ScrollBox in
          fullscreen mode. Don't wrap in an overflow-hidden Box: ScrollBox
          needs to read its own viewport height via Yoga, and an outer clip
          can confuse the measurement on resize.

          In flow mode the overlay rides inside the scroll column (it just
          appears under the latest message). In fullscreen the scrollable
          column has flexGrow=1, which crowds an inline overlay out of the
          viewport — pin the overlay above `bottom` with flexShrink=0 so it
          always stays visible. */}
      <Box flexDirection="column" flexGrow={fullscreen ? 1 : 0}>
        {scrollable}
        {!fullscreen && overlay}
      </Box>

      {fullscreen && showPill && newMessageCount > 0 && (
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

      {fullscreen && overlay && (
        <Box flexDirection="column" flexShrink={0}>
          {overlay}
        </Box>
      )}

      {/* Bottom pinned area */}
      <Box flexDirection="column" flexShrink={0}>
        {bottom}
      </Box>
    </Box>
  );

  return fullscreen ? <AlternateScreen>{body}</AlternateScreen> : body;
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
