import React, { useState } from "react";

interface Props {
  title: string;
  subtitle?: string;
  /** Right-aligned count/badge text in the header. */
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Collapsible connection group. The whole header is a toggle button (the
 * earlier WebSearch group header wasn't collapsible — user asked for groups to
 * fold). Pure presentational; each connection group (WebSearch, ImageGen, …)
 * wraps its card grid in one of these.
 */
export function CollapsibleGroup({ title, subtitle, badge, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`connections-group${open ? "" : " is-collapsed"}`}>
      <button
        type="button"
        className="connections-group-head is-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="connections-group-head-left">
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </span>
        <span className="connections-group-head-right" style={{ display: "flex", alignItems: "center" }}>
          {badge && <span className="connections-group-count">{badge}</span>}
          <span className={`connections-group-chevron${open ? " is-open" : ""}`} aria-hidden>
            {/* simple right-chevron; rotates 90° when open */}
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
      </button>
      {open && children}
    </div>
  );
}
