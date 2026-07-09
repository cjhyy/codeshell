import React, { useEffect, useImperativeHandle, useRef } from "react";
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
export const WebviewHost = React.forwardRef<
  WebviewElement,
  { initialUrl: string; partition?: string; bucket?: string; engineSessionId?: string | null }
>(function WebviewHost(
  { initialUrl, partition = "persist:browser", bucket, engineSessionId },
  ref,
) {
  const viewRef = useRef<WebviewElement | null>(null);
  useImperativeHandle(ref, () => viewRef.current as WebviewElement, []);
  const frozenSrc = useRef(initialUrl).current;
  // Freeze the partition too (like src): a webview's partition can't change
  // after attach, and it identifies the isolated storage/session the guest runs
  // in. Per-session partitions keep one chat session's browsing (cookies, logged-
  // in state, and the live page) from bleeding into another's.
  const frozenPartition = useRef(partition).current;

  useEffect(() => {
    if (!bucket) return;
    if (engineSessionId) {
      window.codeshell.registerBrowserSessionBucket({
        sessionId: engineSessionId,
        bucket,
        partition: frozenPartition,
      });
    }
    const view = viewRef.current;
    if (!view) return;
    const registerGuest = () => {
      const guestId = view.getWebContentsId?.();
      if (typeof guestId !== "number" || !Number.isFinite(guestId)) return;
      window.codeshell.registerBrowserGuest({
        guestId,
        bucket,
        partition: frozenPartition,
        engineSessionId,
      });
    };
    const timer = window.setTimeout(registerGuest, 0);
    view.addEventListener("dom-ready", registerGuest);
    return () => {
      window.clearTimeout(timer);
      view.removeEventListener("dom-ready", registerGuest);
    };
  }, [bucket, engineSessionId, frozenPartition]);

  return (
    <webview
      ref={viewRef as unknown as React.Ref<HTMLElement>}
      src={frozenSrc}
      partition={frozenPartition}
      style={{ width: "100%", height: "100%", display: "flex" }}
    />
  );
});
