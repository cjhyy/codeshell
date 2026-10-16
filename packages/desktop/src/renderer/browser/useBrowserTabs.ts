import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { parseBrowserGuestLinkIpcMessage, type GuestLinkRequest } from "../../browser-guest-link";
import { NEW_TAB, freshTab, normalizeUrl, type Tab, type WebviewElement } from "./types";

export const OPEN_TAB_RATE_WINDOW_MS = 1000;
export const OPEN_TAB_MAX_PER_RATE_WINDOW = 6;
export const OPEN_TAB_DEDUPE_WINDOW_MS = 750;

export interface GuestLinkGuardState {
  windowStartedAt: number;
  openedInWindow: number;
  recentUrls: Map<string, number>;
}

export function createGuestLinkGuardState(): GuestLinkGuardState {
  return { windowStartedAt: 0, openedInWindow: 0, recentUrls: new Map() };
}

export function shouldAcceptGuestLinkRequest(
  state: GuestLinkGuardState,
  request: GuestLinkRequest,
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

  const requestKey = `${request.disposition}\0${request.url}`;
  if (state.recentUrls.has(requestKey)) return false;
  if (state.openedInWindow >= OPEN_TAB_MAX_PER_RATE_WINDOW) return false;

  state.recentUrls.set(requestKey, now);
  state.openedInWindow += 1;
  return true;
}

/**
 * Tab management + webview lifecycle wiring for the browser panel. Owns the
 * tabs list, the active tab, the nav state (back/forward/loading), and the
 * active <webview> ref. Wires each retained guest's own events and routes
 * in-app new-tab / reload / open-url signals.
 */
export function useBrowserTabs(
  initialUrl: string | undefined,
  openUrl: { url: string; nonce: number } | undefined,
  bucket?: string,
): {
  tabs: Tab[];
  activeId: string;
  active: Tab;
  nav: { canGoBack: boolean; canGoForward: boolean; loading: boolean };
  viewRef: React.RefObject<WebviewElement | null>;
  tabViewRef: (id: string) => React.RefCallback<WebviewElement>;
  setActiveId: React.Dispatch<React.SetStateAction<string>>;
  patchTab: (id: string, patch: Partial<Tab>) => void;
  closeTab: (id: string) => void;
  openInNewTab: (url: string) => void;
  navigate: (raw: string) => void;
} {
  const [tabs, setTabs] = useState<Tab[]>(() => [freshTab(initialUrl)]);
  const currentTabs = useRef(tabs);
  currentTabs.current = tabs;
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const viewRef = useRef<WebviewElement | null>(null);
  const tabViews = useRef(new Map<string, WebviewElement>());
  const tabRefCallbacks = useRef(new Map<string, React.RefCallback<WebviewElement>>());
  const [guestRevision, setGuestRevision] = useState(0);
  const guestLinkGuard = useRef(createGuestLinkGuardState());
  const [tabNav, setTabNav] = useState<
    Record<string, { canGoBack: boolean; canGoForward: boolean; loading: boolean }>
  >({});
  const nav = tabNav[activeId] ?? { canGoBack: false, canGoForward: false, loading: false };

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const tabViewRef = useCallback((id: string): React.RefCallback<WebviewElement> => {
    let callback = tabRefCallbacks.current.get(id);
    if (!callback) {
      callback = (view) => {
        if (tabViews.current.get(id) === (view ?? undefined)) return;
        if (view) tabViews.current.set(id, view);
        else tabViews.current.delete(id);
        // Attach and idle-eviction remounts need fresh listeners even when the
        // selected tab and URL have not changed.
        setGuestRevision((revision) => revision + 1);
      };
      tabRefCallbacks.current.set(id, callback);
    }
    return callback;
  }, []);

  useLayoutEffect(() => {
    viewRef.current = tabViews.current.get(activeId) ?? null;
  }, [activeId, guestRevision]);

  useEffect(() => {
    const liveIds = new Set(tabs.map((tab) => tab.id));
    for (const id of tabRefCallbacks.current.keys()) {
      if (!liveIds.has(id)) tabRefCallbacks.current.delete(id);
    }
    setTabNav((previous) => {
      const removed = Object.keys(previous).filter((id) => !liveIds.has(id));
      if (!removed.length) return previous;
      return Object.fromEntries(Object.entries(previous).filter(([id]) => liveIds.has(id)));
    });
  }, [tabs]);

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

  // A tab keeps its guest while another tab is selected. Background redirects
  // and failures must update that tab, never the current address bar/history.
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    for (const [tabId, view] of tabViews.current) {
      const setNav = (update: (previous: typeof nav) => typeof nav) =>
        setTabNav((previous) => ({
          ...previous,
          [tabId]: update(
            previous[tabId] ?? { canGoBack: false, canGoForward: false, loading: false },
          ),
        }));
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
        if (title) patchTab(tabId, { title });
      };
      const onNavigate = (e: Event) => {
        const url = (e as unknown as { url: string }).url;
        // A real navigation committed → the page loaded; clear any prior error.
        if (url && url !== NEW_TAB) patchTab(tabId, { url, draft: url, error: undefined });
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
        patchTab(tabId, {
          error: { code: ev.errorCode, desc: ev.errorDescription, url: ev.validatedURL },
        });
        setNav((n) => ({ ...n, loading: false }));
      };
      // Electron <webview> has a long-standing bug where clicking a
      // `target="_blank"` link (or window.open) fires NOTHING — no will-navigate,
      // no setWindowOpenHandler, no navigation at all (electron/electron#30886).
      // The main process forces a context-isolated document-start preload onto
      // every guest. It forwards only trusted link gestures via sendToHost; page
      // scripts cannot read or forge this host-only Electron event channel.
      const onGuestIpc = (e: Event) => {
        const request = parseBrowserGuestLinkIpcMessage(
          e as unknown as { channel?: unknown; args?: unknown },
        );
        if (!request) return;
        if (!shouldAcceptGuestLinkRequest(guestLinkGuard.current, request)) return;
        if (request.disposition === "external") {
          void window.codeshell.openExternal(request.url).catch(() => undefined);
        } else {
          openInNewTab(request.url);
        }
      };
      view.addEventListener("did-start-loading", onStart);
      view.addEventListener("did-stop-loading", onStop);
      view.addEventListener("page-title-updated", onTitle as EventListener);
      view.addEventListener("did-navigate", onNavigate as EventListener);
      view.addEventListener("did-navigate-in-page", onNavigate as EventListener);
      view.addEventListener("did-fail-load", onFail as EventListener);
      view.addEventListener("ipc-message", onGuestIpc as EventListener);
      // Late attach (see hasGuest above): the guest may have already navigated /
      // titled itself before we got listeners on — sync once from the live guest
      // so the address bar and tab title catch up.
      try {
        const liveUrl = view.getURL();
        if (
          liveUrl &&
          liveUrl !== NEW_TAB &&
          liveUrl !== currentTabs.current.find((tab) => tab.id === tabId)?.url
        ) {
          patchTab(tabId, { url: liveUrl, draft: liveUrl });
        }
        const liveTitle = view.getTitle?.();
        if (liveTitle) patchTab(tabId, { title: liveTitle });
        refreshNav();
      } catch {
        /* guest not ready yet — the listeners above will catch up */
      }
      cleanups.push(() => {
        view.removeEventListener("did-start-loading", onStart);
        view.removeEventListener("did-stop-loading", onStop);
        view.removeEventListener("page-title-updated", onTitle as EventListener);
        view.removeEventListener("did-navigate", onNavigate as EventListener);
        view.removeEventListener("did-navigate-in-page", onNavigate as EventListener);
        view.removeEventListener("did-fail-load", onFail as EventListener);
        view.removeEventListener("ipc-message", onGuestIpc as EventListener);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [guestRevision, patchTab, openInNewTab]);

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
    const off = window.codeshell.onBrowserOpenTab?.(({ url, bucket: eventBucket }) => {
      if (eventBucket && bucket && eventBucket !== bucket) return;
      if (url) openInNewTab(url);
    });
    return () => off?.();
  }, [bucket, openInNewTab]);

  // Cookie 账号切换:main 导回 cookie 后广播 browser:reload,重载当前 tab 让登录态生效。
  useEffect(() => {
    const off = window.codeshell.onBrowserReload?.(({ bucket: eventBucket } = {}) => {
      if (eventBucket && bucket && eventBucket !== bucket) return;
      viewRef.current?.reload();
    });
    return () => off?.();
  }, [bucket]);

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
    tabViewRef,
    setActiveId,
    patchTab,
    closeTab,
    openInNewTab,
    navigate,
  };
}
