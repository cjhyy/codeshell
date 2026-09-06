import React, { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useAnchoredPopover } from "../chat/useAnchoredPopover";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Tiny right-click menu rendered at viewport coordinates.
 *
 * Closes on outside click, escape, or after any item activation. The
 * menu is portal-free — we trust the parent's z-index ladder. Items
 * with `danger` get a red text tint; disabled items are no-ops.
 *
 * Positioned via `useAnchoredPopover` with the cursor as a virtual
 * anchor, so it flips left/up and clamps to the viewport near the
 * right/bottom edges instead of overflowing.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLUListElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const style = useAnchoredPopover(true, ref, ref, {
    preferredSide: "bottom",
    align: "start",
    gap: 2,
    point: { x, y },
  });

  const restoreFocus = () => {
    const active = document.activeElement;
    if (
      openerRef.current?.isConnected &&
      (active === document.body || active === null || ref.current?.contains(active))
    ) {
      openerRef.current.focus({ preventScroll: true });
    }
  };

  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = ref.current;
    // The positioning hook first measures a hidden menu. Focus after its
    // visible position is committed, without moving the underlying page.
    const frame = window.requestAnimationFrame(() => {
      const first = menu?.querySelector<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      );
      (first ?? menu)?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const active = document.activeElement;
      if (
        openerRef.current?.isConnected &&
        (active === document.body || active === null || menu?.contains(active))
      )
        openerRef.current.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  return (
    <ul
      ref={ref}
      className="max-h-[calc(100dvh-1.25rem)] w-max min-w-40 max-w-[calc(100vw-1.25rem)] list-none overflow-y-auto rounded-xl border border-border/80 bg-popover p-1 text-sm text-popover-foreground shadow-xl outline-none"
      style={style}
      role="menu"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const choices = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button[role="menuitem"]:not(:disabled)',
            ),
          );
          const current = choices.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? choices.length - 1
                : event.key === "ArrowDown"
                  ? (current + 1) % choices.length
                  : current < 0
                    ? choices.length - 1
                    : (current - 1 + choices.length) % choices.length;
          choices[next]?.focus({ preventScroll: true });
        } else if (event.key === "Escape" || event.key === "Tab") {
          event.stopPropagation();
          if (event.key === "Escape") event.preventDefault();
          restoreFocus();
          onClose();
        }
      }}
    >
      {items.map((item, i) => (
        <li key={i} role="none">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            className={cn(
              "block w-full rounded-lg px-3 py-2 text-left text-sm [overflow-wrap:anywhere] hover:bg-accent focus:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent",
              item.danger && "text-status-err",
            )}
            onClick={() => {
              if (item.disabled) return;
              // A selected action may open a dialog. Give it a persistent
              // opener before the temporary menu button unmounts.
              restoreFocus();
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
