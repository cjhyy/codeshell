import React from "react";
import { cn } from "@/lib/utils";

/**
 * Compact 28px square icon button used in the topbar / inspector chrome.
 *
 * Migrated off the legacy `.icon-btn` CSS (deleted in shadcn Phase D) to inline
 * Tailwind utilities — equivalent geometry/colors plus a self-contained
 * focus-visible ring (the old global `button:focus-visible` rule was deleted
 * with the rest of the hand-written CSS).
 */
const ICON_BTN_BASE =
  "inline-flex h-7 w-7 items-center justify-center align-middle rounded-sm " +
  "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground " +
  "disabled:opacity-40 disabled:cursor-not-allowed " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  /**
   * Toggle/selected state — when true the button shows a persistent "on" look:
   * a soft, semi-transparent DARK scrim (bg-foreground/15) with the normal icon
   * color, so e.g. the panel button reads as active while the panel is open
   * without the loud orange fill. Darker than the neutral hover gray so it's
   * still distinguishable from a plain hover. `!` + `hover:!…` beat the base
   * `hover:bg-accent` utility, which would otherwise flash the active scrim off
   * on hover.
   */
  active?: boolean;
}

export function IconButton({ label, children, className = "", active = false, ...rest }: Props) {
  const activeCls = active
    ? "!bg-foreground/15 hover:!bg-foreground/20"
    : "";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(ICON_BTN_BASE, activeCls, className)}
      {...rest}
    >
      {children}
    </button>
  );
}
