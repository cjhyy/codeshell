import React, { useRef } from "react";
import type { WebviewElement } from "./types";

/**
 * The <webview> with a FROZEN `src` — set once at mount, never re-driven by
 * React afterward. Critical: `src` is a controlled prop, but the guest page
 * navigates itself (redirects, SPA route changes, e.g. localhost:3000 → /chat).
 * Each such navigation fires did-navigate → the parent records it into
 * `active.url` (for the address bar). If `src` were bound to that live value,
 * React would re-set `src` on the next render → a SECOND navigation that aborts
 * the in-flight one (ERR_ABORTED -3, the error in the popout). By capturing the
 * initial url in a ref and rendering it as a constant, the guest owns its own
 * navigation after the first load; the address bar still updates via state, and
 * deliberate re-navigation (address bar / open-url) goes through loadURL().
 * Mounted fresh per tab (keyed by tab id upstream), so each tab loads its own
 * initial url exactly once.
 */
export const WebviewHost = React.forwardRef<WebviewElement, { initialUrl: string }>(
  function WebviewHost({ initialUrl }, ref) {
    const frozenSrc = useRef(initialUrl).current;
    return (
      <webview
        ref={ref as unknown as React.Ref<HTMLElement>}
        src={frozenSrc}
        partition="persist:browser"
        style={{ width: "100%", height: "100%", display: "flex" }}
      />
    );
  },
);
