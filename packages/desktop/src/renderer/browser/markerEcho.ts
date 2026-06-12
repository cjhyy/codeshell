// markerEcho — the shared echo engine for browser annotations (圈选统一架构,
// spec 2026-06-12-browser-marker-unified-design.md).
//
// Both browser surfaces (the in-app BrowserPanel and the popout window's
// full-screen panel) feed it the SAME anchor list (panel: props from App;
// popout: the hub broadcast) and get identical behavior:
//   - URL filtering: which anchors belong to the page currently shown
//   - edit-time highlight: inject an outline onto the marked element, retry
//     after navigations (dom-ready), and report whether the selector matched
//     so the caller can fall back to a rect overlay instead of silently
//     showing nothing (the old behavior — "看不到 outline").
//
// Pure helpers are exported separately from the hook so they unit-test without
// a webview.

import { useEffect, useState } from "react";
import type { Anchor, BrowserAnchorEcho } from "../chat/anchors";

/** The subset of Electron's <webview> the echo engine needs. */
export interface EchoWebview extends HTMLElement {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

/** A browser anchor narrowed to "echo payload present". */
export interface BrowserMarker {
  anchor: Anchor;
  echo: BrowserAnchorEcho;
}

/** Narrow an anchor list to displayable browser markers. */
export function browserMarkersFrom(anchors: Anchor[]): BrowserMarker[] {
  const out: BrowserMarker[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === "browser" && anchor.browser) {
      out.push({ anchor, echo: anchor.browser });
    }
  }
  return out;
}

/** Markers that belong to the page currently shown (exact-URL semantics). */
export function visibleMarkersOn(markers: BrowserMarker[], url: string): BrowserMarker[] {
  return markers.filter((m) => m.echo.url === url);
}

/** Group markers by page for the annotations-overview dropdown. */
export interface MarkerPageGroup {
  url: string;
  /** Display label: pageTitle when captured, else the bare URL. */
  title: string;
  markers: BrowserMarker[];
}

export function groupMarkersByPage(markers: BrowserMarker[]): MarkerPageGroup[] {
  const byUrl = new Map<string, MarkerPageGroup>();
  for (const m of markers) {
    let g = byUrl.get(m.echo.url);
    if (!g) {
      g = { url: m.echo.url, title: m.echo.pageTitle || m.echo.url, markers: [] };
      byUrl.set(m.echo.url, g);
    }
    g.markers.push(m);
    // Prefer any non-empty title over a bare-URL fallback.
    if (g.title === g.url && m.echo.pageTitle) g.title = m.echo.pageTitle;
  }
  return Array.from(byUrl.values());
}

/** Short "host/path" attribution line for chips/cards, e.g. "localhost:3000/settings". */
export function pageAttribution(echo: BrowserAnchorEcho): string {
  try {
    const u = new URL(echo.url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return echo.url;
  }
}

const HL = "__cs_marker_hl__";

/** Clear any previous echo highlight inside the guest page. */
export const CLEAR_HIGHLIGHT_SCRIPT = `(()=>{const e=document.querySelector('[data-${HL}]');if(e){e.style.outline=e.dataset.${HL}||'';e.removeAttribute('data-${HL}');}})()`;

/**
 * Build the guest-page script that highlights `selector` and reports whether
 * it actually matched (the completion value is `true`/`false`). The old code
 * silently no-opped on a selector miss — the user just saw nothing; surfacing
 * the miss lets the panel fall back to a rect overlay.
 */
export function buildHighlightScript(selector: string): string {
  const sel = JSON.stringify(selector);
  return `(()=>{${CLEAR_HIGHLIGHT_SCRIPT};try{const el=document.querySelector(${sel});if(!el)return false;el.dataset.${HL}=el.style.outline||'';el.style.outline='2px solid #2563eb';el.scrollIntoView({block:'center'});return true;}catch(_){return false;}})()`;
}

/**
 * Execute guest-page JS without letting EITHER failure mode escape:
 * executeJavaScript THROWS SYNCHRONOUSLY when the <webview> isn't attached +
 * dom-ready yet (an uncaught throw here unmounts the whole panel — the old
 * blank-popout bug), and rejects asynchronously on navigation teardown.
 * Resolves to null when the call couldn't run.
 */
async function safeExec(view: EchoWebview, code: string): Promise<unknown> {
  try {
    return await view.executeJavaScript(code);
  } catch {
    return null;
  }
}

/**
 * Edit-time highlight with navigation replay and selector-miss reporting.
 *
 * While `editingId` names a marker on the current page, inject the outline
 * onto its selector; re-inject after every dom-ready (refresh/navigation used
 * to wipe the outline permanently); clear on exit. Returns the anchor id whose
 * selector MISSED (element gone / selector unstable) so the caller can render
 * a rect-based fallback overlay instead of nothing.
 */
export function useMarkerEcho(
  viewRef: React.RefObject<EchoWebview | null>,
  visible: BrowserMarker[],
  editingId: string | null,
): { selectorMissFor: string | null } {
  const [selectorMissFor, setSelectorMissFor] = useState<string | null>(null);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const target = editingId ? visible.find((m) => m.anchor.id === editingId) : undefined;

    if (!target) {
      setSelectorMissFor(null);
      void safeExec(view, CLEAR_HIGHLIGHT_SCRIPT);
      return;
    }

    let alive = true;
    const inject = (): void => {
      if (!target.echo.selector) {
        // No selector recorded at pick time — rect fallback immediately.
        if (alive) setSelectorMissFor(target.anchor.id);
        return;
      }
      void safeExec(view, buildHighlightScript(target.echo.selector)).then((matched) => {
        if (!alive) return;
        setSelectorMissFor(matched === true ? null : target.anchor.id);
      });
    };

    inject();
    // Replay after refresh/navigation — the guest DOM is rebuilt and the old
    // outline is gone; without this the highlight "worked once then vanished".
    const onReady = (): void => inject();
    view.addEventListener("dom-ready", onReady);
    return () => {
      alive = false;
      view.removeEventListener("dom-ready", onReady);
      void safeExec(view, CLEAR_HIGHLIGHT_SCRIPT);
    };
  }, [viewRef, editingId, visible]);

  return { selectorMissFor };
}
