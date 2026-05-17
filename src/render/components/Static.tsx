import React, { useRef, useEffect, type ReactNode, type ReactElement } from 'react';
import '../global.d.ts';

interface StaticProps<T> {
  /** Stable array; only NEW items past the previously-emitted index get rendered. */
  items: readonly T[];
  /** Render fn — same shape as Array.prototype.map. */
  children: (item: T, index: number) => ReactNode;
}

/**
 * Append-only output component. Each time `items` grows, the NEW items are
 * rendered to ANSI and written directly to stdout. They are never touched by
 * the diff engine again — they live permanently in the terminal scrollback.
 *
 * Shape matches ink's <Static>: https://github.com/vadimdemedes/ink#static
 *
 * Implementation: we use a custom host element 'ink-static' so ink.tsx can
 * detect it in onRender. The pendingStaticElement prop carries the React
 * subtree for the new items. ink.tsx renders that element via renderToScreen,
 * converts to ANSI, writes to stdout, then the next render cycle sees
 * emittedCount === items.length and passes null (nothing to flush).
 */
export function Static<T>({ items, children }: StaticProps<T>): ReactElement {
  const emittedCountRef = useRef(0);

  // Only the NEW items past emittedCount are passed for flushing.
  const newItems = items.slice(emittedCountRef.current);
  const newOffset = emittedCountRef.current;

  // Advance emittedCount AFTER the host node has been committed and flushed.
  // useEffect fires after paint — by then ink.tsx's onRender has already
  // flushed the ANSI to stdout. The next render will see emittedCount ===
  // items.length and pass null as pendingStaticElement.
  useEffect(() => {
    emittedCountRef.current = items.length;
  }, [items.length]);

  // Build the React element tree for the new items. This is passed to the
  // ink-static host node as `pendingStaticElement`; ink.tsx's flush hook
  // retrieves it and renders it via renderToScreen(). null when nothing new.
  const pendingElement: ReactElement | null =
    newItems.length > 0
      ? React.createElement(
          React.Fragment,
          null,
          newItems.map((it, i) =>
            React.createElement(
              React.Fragment,
              { key: newOffset + i },
              children(it, newOffset + i),
            ),
          ),
        )
      : null;

  return React.createElement(
    'ink-static' as unknown as keyof React.JSX.IntrinsicElements,
    {
      pendingStaticElement: pendingElement,
      staticOffset: newOffset,
      staticTotal: items.length,
    } as never,
  );
}
