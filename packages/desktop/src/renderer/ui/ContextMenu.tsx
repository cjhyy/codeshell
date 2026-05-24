import React, { useEffect, useRef } from "react";

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
      className="context-menu"
      style={{ top: y, left: x }}
      role="menu"
    >
      {items.map((item, i) => (
        <li
          key={i}
          className={`context-menu-item${item.danger ? " danger" : ""}${item.disabled ? " disabled" : ""}`}
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
