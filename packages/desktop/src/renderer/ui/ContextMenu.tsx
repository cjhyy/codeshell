import React, { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

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
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  return (
    <ul
      ref={ref}
      className="fixed z-50 min-w-40 list-none rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      style={{ top: y, left: x }}
      role="menu"
    >
      {items.map((item, i) => (
        <li
          key={i}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent",
            item.danger && "text-status-err",
            item.disabled && "cursor-not-allowed text-muted-foreground hover:bg-transparent",
          )}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
          role="menuitem"
        >
          {item.label}
        </li>
      ))}
    </ul>
  );
}
