/**
 * ScrollView — virtual scrolling container for terminal UI.
 *
 * Inspired by Claude Code's ScrollBox component. Key design:
 * - Manages scrollTop + viewport height
 * - Only renders children visible in the viewport (virtual scrolling)
 * - stickyScroll: auto-follows new content (like "tail -f")
 * - Mouse wheel scrolling support
 * - Exposes imperative handle for programmatic scroll control
 *
 * Unlike CC's ScrollBox which uses a custom Yoga-based renderer,
 * this implementation works with standard Ink by slicing the
 * children array to only render visible items.
 */
import {
  useState,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useCallback,
  type ReactNode,
} from "react";
import { Box, Text, useStdout, useInput } from "../../ink/index.js";

export interface ScrollViewHandle {
  scrollTo: (y: number) => void;
  scrollBy: (dy: number) => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  isAtBottom: () => boolean;
}

interface ScrollViewProps {
  /** Total number of items (not pixels). */
  itemCount: number;
  /** Render a single item by index. */
  renderItem: (index: number) => ReactNode;
  /** If true, auto-scroll to bottom when new items appear. */
  stickyScroll?: boolean;
  /** Height in terminal rows to reserve for non-scrollable UI (input, status). */
  reservedRows?: number;
}

export const ScrollView = forwardRef<ScrollViewHandle, ScrollViewProps>(
  function ScrollView({ itemCount, renderItem, stickyScroll = true, reservedRows = 5 }, ref) {
    const { stdout } = useStdout();
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(
      (stdout?.rows ?? 24) - reservedRows,
    );
    const isSticky = useRef(stickyScroll);
    const prevItemCount = useRef(itemCount);

    // Update viewport on terminal resize
    useEffect(() => {
      const update = () => {
        setViewportHeight(Math.max(1, (stdout?.rows ?? 24) - reservedRows));
      };
      stdout?.on("resize", update);
      return () => { stdout?.off("resize", update); };
    }, [stdout, reservedRows]);

    // Auto-scroll when new items added (sticky mode)
    useEffect(() => {
      if (itemCount > prevItemCount.current && isSticky.current) {
        // Scroll to show the last item
        const maxScroll = Math.max(0, itemCount - viewportHeight);
        setScrollTop(maxScroll);
      }
      prevItemCount.current = itemCount;
    }, [itemCount, viewportHeight]);

    // Mouse wheel / arrow key scrolling
    useInput((_input, key) => {
      if (key.upArrow && key.shift) {
        scrollBy(-3);
      } else if (key.downArrow && key.shift) {
        scrollBy(3);
      }
    });

    const scrollBy = useCallback((dy: number) => {
      setScrollTop((prev) => {
        const maxScroll = Math.max(0, itemCount - viewportHeight);
        const next = Math.max(0, Math.min(maxScroll, prev + dy));
        isSticky.current = next >= maxScroll;
        return next;
      });
    }, [itemCount, viewportHeight]);

    const scrollTo = useCallback((y: number) => {
      const maxScroll = Math.max(0, itemCount - viewportHeight);
      const clamped = Math.max(0, Math.min(maxScroll, Math.floor(y)));
      isSticky.current = clamped >= maxScroll;
      setScrollTop(clamped);
    }, [itemCount, viewportHeight]);

    const scrollToBottom = useCallback(() => {
      const maxScroll = Math.max(0, itemCount - viewportHeight);
      isSticky.current = true;
      setScrollTop(maxScroll);
    }, [itemCount, viewportHeight]);

    useImperativeHandle(ref, () => ({
      scrollTo,
      scrollBy,
      scrollToBottom,
      getScrollTop: () => scrollTop,
      isAtBottom: () => isSticky.current,
    }), [scrollTo, scrollBy, scrollToBottom, scrollTop]);

    // Compute visible range
    const start = Math.max(0, Math.floor(scrollTop));
    const end = Math.min(itemCount, start + viewportHeight);

    // Render only visible items
    const visibleItems: ReactNode[] = [];
    for (let i = start; i < end; i++) {
      visibleItems.push(renderItem(i));
    }

    // Scroll indicator
    const maxScroll = Math.max(0, itemCount - viewportHeight);
    const showScrollHint = itemCount > viewportHeight;
    const atTop = scrollTop <= 0;
    const atBottom = scrollTop >= maxScroll;

    return (
      <Box flexDirection="column" height={viewportHeight}>
        {showScrollHint && !atTop && (
          <Box justifyContent="flex-end">
            <Text dim>{"↑ " + scrollTop + " more (shift+↑ to scroll)"}</Text>
          </Box>
        )}

        <Box flexDirection="column" flexGrow={1}>
          {visibleItems}
        </Box>

        {showScrollHint && !atBottom && (
          <Box justifyContent="flex-end">
            <Text dim>{"↓ " + (itemCount - end) + " more (shift+↓ to scroll)"}</Text>
          </Box>
        )}
      </Box>
    );
  },
);
