import React from "react";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  /**
   * Toggle/selected state — when true the button shows a persistent "on" look:
   * a soft, semi-transparent DARK scrim (bg-foreground/15) with the normal icon
   * color, so e.g. the panel button reads as active while the panel is open
   * without the loud orange fill. Darker than the neutral hover gray so it's
   * still distinguishable from a plain hover. `!` + `hover:!…` beat the legacy
   * `.icon-btn:hover` rule (a :hover class out-specifies a single utility),
   * which would otherwise flash the active scrim off on hover.
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
      className={`icon-btn ${activeCls} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
