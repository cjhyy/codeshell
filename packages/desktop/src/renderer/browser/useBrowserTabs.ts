import { useCallback, useEffect, useRef, useState } from "react";
import { NEW_TAB, freshTab, normalizeUrl, type Tab, type WebviewElement } from "./types";

export const OPEN_TAB_SENTINEL = "__CS_OPEN_TAB__";
export const OPEN_TAB_RATE_WINDOW_MS = 1000;
export const OPEN_TAB_MAX_PER_RATE_WINDOW = 6;
export const OPEN_TAB_DEDUPE_WINDOW_MS = 750;

export interface OpenTabConsoleGuardState {
  windowStartedAt: number;
  openedInWindow: number;
  recentUrls: Map<string, number>;
}

export function createOpenTabConsoleGuardState(): OpenTabConsoleGuardState {
  return { windowStartedAt: 0, openedInWindow: 0, recentUrls: new Map() };
}

function createOpenTabConsoleNonce(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

export function parseOpenTabConsoleMessage(message: string, expectedNonce: string): string | null {
  if (!message.startsWith(OPEN_TAB_SENTINEL)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(message.slice(OPEN_TAB_SENTINEL.length));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  const { nonce, url } = payload as { nonce?: unknown; url?: unknown };
  if (nonce !== expectedNonce || typeof url !== "string") return null;

  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function shouldAcceptOpenTabConsoleUrl(
  state: OpenTabConsoleGuardState,
  url: string,
  now = Date.now(),
): boolean {
  if (now < state.windowStartedAt || now - state.windowStartedAt >= OPEN_TAB_RATE_WINDOW_MS) {
    state.windowStartedAt = now;
    state.openedInWindow = 0;
  }

  for (const [recentUrl, seenAt] of state.recentUrls) {
    if (now < seenAt || now - seenAt >= OPEN_TAB_DEDUPE_WINDOW_MS) {
      state.recentUrls.delete(recentUrl);
    }
  }

  if (state.recentUrls.has(url)) return false;
  if (state.openedInWindow >= OPEN_TAB_MAX_PER_RATE_WINDOW) return false;

  state.recentUrls.set(url, now);
  state.openedInWindow += 1;
  return true;
}

export function buildOpenTabBridgeScript(nonce: string | null): string {
  return `(() => {
      if (window.__cs_tab_hook_v2) return; window.__cs_tab_hook_v2 = 1;
      const sentinel = ${JSON.stringify(OPEN_TAB_SENTINEL)};
      const nonce = ${JSON.stringify(nonce)};
      document.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        const a = e.target && e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        const href = a.href;
        if (!/^https?:/i.test(href)) return;
        const wantsNew = a.target === '_blank' || e.metaKey || e.ctrlKey || e.button === 1;
        if (!wantsNew) return;
        e.preventDefault(); e.stopPropagation();
        console.info(sentinel + JSON.stringify({ nonce, url: href }));
      }, true);
    })();`;
}

/**
 * Tab management + webview lifecycle wiring for the browser panel. Owns the
 * tabs list, the active tab, the nav state (back/forward/loading), and the
 * single <webview> ref. Wires guest events for the active tab and routes
 * in-app new-tab / reload / open-url signals.
 */
export function useBrowserTabs(
  initialUrl: string | undefined,
  openUrl: { url: string; nonce: number } | undefined,
): {
  tabs: Tab[];
  activeId: string;
  active: Tab;
  nav: { canGoBack: boolean; canGoForward: boolean; loading: boolean };
  viewRef: React.RefObject<WebviewElement | null>;
  setActiveId: React.Dispatch<React.SetStateAction<string>>;
  patchTab: (id: string, patch: Partial<Tab>) => void;
  closeTab: (id: string) => void;
  openInNewTab: (url: string) => void;
  navigate: (raw: string) => void;
} {
  const [tabs, setTabs] = useState<Tab[]>(() => [freshTab(initialUrl)]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const viewRef = useRef<WebviewElement | null>(null);
  const openTabConsoleNonce = useRef<string | null>(null);
  if (!openTabConsoleNonce.current) openTabConsoleNonce.current = createOpenTabConsoleNonce();
  const openTabConsoleGuard = useRef(createOpenTabConsoleGuardState());
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false, loading: false });

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // Defined before the lifecycle effect below because that effect calls it (for
  // in-guest new-tab link interception) and lists it as a dependency.
  const openInNewTab = useCallback((url: string) => {
    const tab = freshTab();
    // NEW_TAB is the landing-page sentinel — never run it through normalizeUrl
    // (which would treat the `about:` scheme as a search and send it to a
    // search engine). Only normalize real user-supplied URLs.
    if (url && url !== NEW_TAB) {
      const norm = normalizeUrl(url);
      if (norm) {
        tab.url = norm;
        tab.draft = norm;
      }
    }
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }, []);

  // Wire webview lifecycle events for the active tab. `hasGuest` matters: a
  // tab born on the NEW_TAB landing has NO <webview> when this effect first
  // runs (viewRef null → bail); typing a URL mounts WebviewHost, and without
  // hasGuest in the deps the effect never re-ran — did-navigate /
  // page-title-updated were never attached, so a guest-side redirect (e.g.
  // localhost:3000 → /chat) left active.url/title permanently stale (圈选
  // 标注存了旧 URL,回显匹配不上的根因之一).
  const hasGuest = active.url !== NEW_TAB;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const refreshNav = () => {
      try {
        setNav((n) => ({ ...n, canGoBack: view.canGoBack(), canGoForward: view.canGoForward() }));
      } catch {
        /* not ready */
      }
    };
    const onStart = () => setNav((n) => ({ ...n, loading: true }));
    const onStop = () => {
      setNav((n) => ({ ...n, loading: false }));
      refreshNav();
    };
    const onTitle = (e: Event) => {
      const title = (e as unknown as { title: string }).title;
      if (title) patchTab(activeId, { title });
    };
    const onNavigate = (e: Event) => {
      const url = (e as unknown as { url: string }).url;
      // A real navigation committed → the page loaded; clear any prior error.
      if (url && url !== NEW_TAB) patchTab(activeId, { url, draft: url, error: undefined });
      refreshNav();
    };
    const onFail = (e: Event) => {
      const ev = e as unknown as {
        errorCode: number;
        errorDescription: string;
        validatedURL: string;
        isMainFrame: boolean;
      };
      // Only main-frame failures matter (subframe/ad failures are noise). Ignore
      // ERR_ABORTED (-3): we deliberately abort in-flight loads on re-navigation
      // (see WebviewHost frozen-src note), and that's not a user-facing error.
      if (ev.isMainFrame === false || ev.errorCode === -3) return;
      patchTab(activeId, {
        error: { code: ev.errorCode, desc: ev.errorDescription, url: ev.validatedURL },
      });
      setNav((n) => ({ ...n, loading: false }));
    };
    // Electron <webview> has a long-standing bug where clicking a
    // `target="_blank"` link (or window.open) fires NOTHING — no will-navigate,
    // no setWindowOpenHandler, no navigation at all (electron/electron#30886).
    // So we can't catch new-tab links in main. Instead inject a capturing click
    // listener into the guest on every load: it intercepts clicks that WANT a
    // new window (target=_blank, or ⌘/Ctrl/middle-click) and signals the URL out
    // via console.info with a sentinel; we parse it in onConsole below and open
    // an in-app tab. Same-tab links keep working through normal navigation.
    const inject = buildOpenTabBridgeScript(openTabConsoleNonce.current);
    const onDomReady = () => {
      try {
        void view.executeJavaScript(inject, true).catch(() => undefined);
      } catch {
        /* guest torn down */
      }
    };
    const onConsole = (e: Event) => {
      const msg = (e as unknown as { message?: string }).message ?? "";
      const url = parseOpenTabConsoleMessage(msg, openTabConsoleNonce.current ?? "");
      if (!url) return;
      if (!shouldAcceptOpenTabConsoleUrl(openTabConsoleGuard.current, url)) return;
      openInNewTab(url);
    };
    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    view.addEventListener("page-title-updated", onTitle as EventListener);
    view.addEventListener("did-navigate", onNavigate as EventListener);
    view.addEventListener("did-navigate-in-page", onNavigate as EventListener);
    view.addEventListener("did-fail-load", onFail as EventListener);
    view.addEventListener("dom-ready", onDomReady);
    view.addEventListener("console-message", onConsole as EventListener);
    // Late attach (see hasGuest above): the guest may have already navigated /
    // titled itself before we got listeners on — sync once from the live guest
    // so the address bar and tab title catch up.
    try {
      const liveUrl = view.getURL();
      if (liveUrl && liveUrl !== NEW_TAB && liveUrl !== active.url) {
        patchTab(activeId, { url: liveUrl, draft: liveUrl });
      }
      const liveTitle = view.getTitle?.();
      if (liveTitle) patchTab(activeId, { title: liveTitle });
    } catch {
      /* guest not ready yet — the listeners above will catch up */
    }
    return () => {
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("page-title-updated", onTitle as EventListener);
      view.removeEventListener("did-navigate", onNavigate as EventListener);
      view.removeEventListener("did-navigate-in-page", onNavigate as EventListener);
      view.removeEventListener("did-fail-load", onFail as EventListener);
      view.removeEventListener("dom-ready", onDomReady);
      view.removeEventListener("console-message", onConsole as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, hasGuest, patchTab, openInNewTab]);

  const navigate = useCallback(
    (raw: string) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      // `src` is frozen at the tab's initial url (see WebviewHost), so it never
      // re-drives navigation. In-tab navigations are imperative via loadURL.
      // EXCEPT leaving the NEW_TAB landing: there's no <webview> mounted yet, so
      // we must set the tab url to MOUNT WebviewHost (its frozen src loads once).
      const view = viewRef.current;
      if (active.url !== NEW_TAB && view) {
        // Already have a guest → navigate it imperatively. Keep state's
        // active.url in sync for the address bar (did-navigate also updates it,
        // but set eagerly so the bar reflects the typed target immediately).
        patchTab(activeId, { draft: url });
        void view.loadURL(url).catch(() => undefined);
      } else {
        // From the landing page: mounting WebviewHost with this url loads it.
        patchTab(activeId, { url, draft: url });
      }
    },
    [activeId, active.url, patchTab],
  );

  // A link inside a guest page wanted a new window (target=_blank / window.open).
  // Main denies the native popup and routes the URL here; open it as a new tab so
  // in-page links behave like a real browser instead of doing nothing ("点了没反应").
  useEffect(() => {
    const off = window.codeshell.onBrowserOpenTab?.(({ url }) => {
      if (url) openInNewTab(url);
    });
    return () => off?.();
  }, [openInNewTab]);

  // Cookie 账号切换:main 导回 cookie 后广播 browser:reload,重载当前 tab 让登录态生效。
  useEffect(() => {
    const off = window.codeshell.onBrowserReload?.(() => viewRef.current?.reload());
    return () => off?.();
  }, []);

  // A chat answer link (http/https) was clicked: App surfaces this panel and
  // hands the URL down via the `openUrl` prop (NOT a window event — that would
  // be missed when the panel was closed at click time, since this component is
  // unmounted then; the prop survives the mount and we navigate on it here).
  //
  // Open the URL in a new tab. If the only tab is the blank landing, load into
  // it rather than stacking an empty tab in front of it. Driven by openUrl.nonce
  // so re-clicking the same link re-fires; the ref dedupes a single nonce
  // (incl. StrictMode's double effect and unrelated re-renders).
  const lastOpenUrlNonce = useRef<number>(-1);
  useEffect(() => {
    if (!openUrl) return;
    if (lastOpenUrlNonce.current === openUrl.nonce) return;
    lastOpenUrlNonce.current = openUrl.nonce;
    const norm = normalizeUrl(openUrl.url);
    if (!norm) return;
    setTabs((prev) => {
      if (prev.length === 1 && prev[0].url === NEW_TAB) {
        setActiveId(prev[0].id);
        return [{ ...prev[0], url: norm, draft: norm }];
      }
      const tab = freshTab(norm);
      setActiveId(tab.id);
      return [...prev, tab];
    });
  }, [openUrl]);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          const t = freshTab();
          setActiveId(t.id);
          return [t];
        }
        if (id === activeId) setActiveId(next[next.length - 1].id);
        return next;
      });
    },
    [activeId],
  );

  return {
    tabs,
    activeId,
    active,
    nav,
    viewRef,
    setActiveId,
    patchTab,
    closeTab,
    openInNewTab,
    navigate,
  };
}
