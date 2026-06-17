import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  MapPin,
  Plus,
  X,
  MousePointerSquareDashed,
  PictureInPicture2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useT } from "../i18n/I18nProvider";
import { CommentBox } from "../chat/CommentBox";
import { addAnchor } from "../chat/addAnchor";
import type { Anchor } from "../chat/anchors";
import { PICKER_SCRIPT, type PickedElement } from "../browser/pickerScript";
import {
  browserMarkersFrom,
  visibleMarkersOn,
  groupMarkersByPage,
  pageAttribution,
  urlsMatch,
  useMarkerEcho,
  type BrowserMarker,
} from "../browser/markerEcho";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// PickedElement / PICKER_SCRIPT live in browser/pickerScript.ts (selector
// escaping + pick-time verification + positional fallback are documented there).

// Electron's <webview> element. React 19's JSX doesn't know it; declare a
// minimal typing so we can render it and call its imperative methods.
interface WebviewElement extends HTMLElement {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle?(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  insertCSS(css: string): Promise<string>;
  capturePage(rect?: Rect): Promise<{ toDataURL(): string }>;
}

interface Tab {
  id: string;
  url: string;
  title: string;
  /** Address-bar text (may differ from the loaded url while typing). */
  draft: string;
  /**
   * Set when the main frame failed to load (did-fail-load). The <webview> shows
   * a blank page on failure, so we render our own overlay instead. Cleared on a
   * successful (re)navigation. `code` is Chromium's net error (e.g. -102
   * ERR_CONNECTION_REFUSED, -105 ERR_NAME_NOT_RESOLVED).
   */
  error?: { code: number; desc: string; url: string };
}

const NEW_TAB = "about:blank";
/** Sentinel title for a freshly-minted tab; compared by identity and translated at render time. */
const NEW_TAB_TITLE = "新选项卡";

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
const WebviewHost = React.forwardRef<WebviewElement, { initialUrl: string }>(
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


// Tab-id generation. The counter alone is NOT collision-proof: React StrictMode
// double-invokes the useState initializer AND setState updaters in dev, and a
// hot-reload resets the module counter — both can mint the same `tab-N` twice
// ("two children with the same key `tab-1`"), which makes React duplicate/omit
// the keyed WebviewHost (blank / "点了没反应"). Mix in a per-call random suffix so
// even a re-run of the same counter value yields a distinct id.
let tabSeq = 0;
function freshTabId(): string {
  tabSeq += 1;
  return `tab-${tabSeq}-${Math.random().toString(36).slice(2, 8)}`;
}
function freshTab(initialUrl?: string): Tab {
  const url = initialUrl && initialUrl !== NEW_TAB ? initialUrl : NEW_TAB;
  return { id: freshTabId(), url, title: NEW_TAB_TITLE, draft: url === NEW_TAB ? "" : url };
}

interface Props {
  /** Workspace root — reserved for future "open file in browser" wiring. */
  cwd: string | null;
  /** Initial URL to open (used by the popout window). */
  initialUrl?: string;
  /**
   * URL a clicked chat link asked to open, threaded as a prop (nonce re-fires
   * on re-click). Prop-driven, NOT a window event the panel subscribes to, so
   * it works even when the panel was CLOSED at click time: App opens the panel,
   * this component mounts, and the effect below navigates to the pending URL.
   */
  openUrl?: { url: string; nonce: number };
  /**
   * The active session's browser anchors — the SINGLE source the page dots /
   * highlights echo (圈选统一架构). Main-window panel: App passes its bucketed
   * state; popout: the hub broadcast. No local marker state exists anymore.
   */
  anchors?: Anchor[];
  /**
   * Where a comment anchor goes. Defaults to the in-window composer (via the
   * add-anchor event). The popout window overrides this to send over IPC to the
   * parent window's composer. Return value unused.
   */
  onAnchor?: (a: Omit<Anchor, "id">) => string | void;
  /** Remove an anchor by id — routed to the owner (App / via IPC for popouts). */
  onRemoveAnchor?: (anchorId: string) => void;
  /** Update an anchor's comment by id — routed like onRemoveAnchor. */
  onUpdateAnchor?: (anchorId: string, comment: string) => void;
  /** Whether to show the "弹出独立窗口" button (hidden inside the popout itself). */
  showPopout?: boolean;
}

/**
 * Built-in browser, modeled on Codex: Electron <webview> (own process +
 * persistent partition) with a self-drawn address bar, tabs, and a
 * localhost bookmark list discovered by port-probing common dev ports.
 */
export function BrowserPanel({ initialUrl, openUrl, anchors, onAnchor, onRemoveAnchor, onUpdateAnchor, showPopout = true }: Props) {
  const { t } = useT();
  const emitAnchor = onAnchor ?? addAnchor;
  const [tabs, setTabs] = useState<Tab[]>(() => [freshTab(initialUrl)]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const viewRef = useRef<WebviewElement | null>(null);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false, loading: false });
  // Element-picking ("圈选") state.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  // Which marker is open for editing (anchor id), if any. Pure UI state — the
  // markers themselves are derived from the `anchors` prop (single source).
  const [editingMarker, setEditingMarker] = useState<string | null>(null);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const markers = useMemo(() => browserMarkersFrom(anchors ?? []), [anchors]);
  // Markers belong to a page; hide them when not on that URL.
  const visibleMarkers = useMemo(
    () => visibleMarkersOn(markers, active.url),
    [markers, active.url],
  );

  // The edited anchor can disappear underneath us (removed in the composer /
  // another window, or cleared on send) — drop the editing state with it.
  useEffect(() => {
    if (editingMarker && !markers.some((m) => m.anchor.id === editingMarker)) {
      setEditingMarker(null);
    }
  }, [editingMarker, markers]);

  // Shared echo engine: edit-time outline + dom-ready replay + miss reporting.
  const { selectorMissFor } = useMarkerEcho(viewRef, visibleMarkers, editingMarker);

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // Enter element-pick mode: inject a picker into the guest page that
  // highlights elements on hover and resolves with the clicked element's info.
  // The guest has no preload, so we drive it entirely via executeJavaScript and
  // read the picker's Promise resolution value back here.
  const startPicking = useCallback(async () => {
    const view = viewRef.current;
    if (!view || active.url === NEW_TAB) return;
    const pickUrl = active.url;
    setSelecting(true);
    // Safety net: if the picker promise never settles (e.g. a navigation tears
    // down the guest without rejecting executeJavaScript), don't leave the
    // button permanently disabled.
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), 60_000));
    try {
      const result = (await Promise.race([
        view.executeJavaScript(PICKER_SCRIPT, true) as Promise<PickedElement | null>,
        timeout,
      ])) as (Omit<PickedElement, "url"> & { url?: string }) | null;
      // Prefer the picker's own location.href (authoritative) over the host's
      // active.url bookkeeping (can be stale across guest-side redirects).
      if (result) setPicked({ ...result, url: result.url || pickUrl });
    } catch {
      /* navigation/CSP interrupted the picker — just exit select mode */
    } finally {
      setSelecting(false);
    }
  }, [active.url]);

  // If the active tab changes while picking, abandon select mode so the button
  // can't get stuck (the guest running the picker may have been torn down).
  useEffect(() => {
    if (selecting) setSelecting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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
    const INJECT = `(() => {
      if (window.__cs_tab_hook) return; window.__cs_tab_hook = 1;
      document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        const href = a.href;
        if (!/^https?:/i.test(href)) return;
        const wantsNew = a.target === '_blank' || e.metaKey || e.ctrlKey || e.button === 1;
        if (!wantsNew) return;
        e.preventDefault(); e.stopPropagation();
        console.info('__CS_OPEN_TAB__' + href);
      }, true);
    })();`;
    const onDomReady = () => {
      try {
        void view.executeJavaScript(INJECT, true).catch(() => undefined);
      } catch {
        /* guest torn down */
      }
    };
    const onConsole = (e: Event) => {
      const msg = (e as unknown as { message?: string }).message ?? "";
      const i = msg.indexOf("__CS_OPEN_TAB__");
      if (i !== -1) openInNewTab(msg.slice(i + "__CS_OPEN_TAB__".length));
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        {/* Tabs scroll horizontally when they overflow; the + button stays
            pinned (shrink-0) so it's always reachable. Each tab is shrink-0 so
            they keep their width instead of squishing into unreadable slivers. */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:thin]">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex w-[180px] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs ${
                tab.id === activeId ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-1 p-0 hover:bg-transparent" onClick={() => setActiveId(tab.id)}>
                <Globe className="h-3 w-3 shrink-0" />
                <span className="truncate">{tab.title === NEW_TAB_TITLE ? t("panels.browser.newTab") : tab.title}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
                onClick={() => closeTab(tab.id)}
                aria-label={t("panels.common.closeTab")}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => openInNewTab(NEW_TAB)}
          aria-label={t("panels.browser.newTab")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Address bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <IconBtn disabled={!nav.canGoBack} onClick={() => viewRef.current?.goBack()} label={t("panels.browser.back")}>
          <ArrowLeft className="h-4 w-4" />
        </IconBtn>
        <IconBtn disabled={!nav.canGoForward} onClick={() => viewRef.current?.goForward()} label={t("panels.browser.forward")}>
          <ArrowRight className="h-4 w-4" />
        </IconBtn>
        <IconBtn onClick={() => viewRef.current?.reload()} label={t("panels.browser.refresh")}>
          <RotateCw className={`h-4 w-4 ${nav.loading ? "animate-spin" : ""}`} />
        </IconBtn>
        <Input
          value={active.draft}
          onChange={(e) => patchTab(activeId, { draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(active.draft);
          }}
          placeholder={t("panels.browser.addressPlaceholder")}
          className="h-8 flex-1"
        />
        <IconBtn
          onClick={() => void startPicking()}
          disabled={active.url === NEW_TAB || selecting}
          label={selecting ? t("panels.browser.picking") : t("panels.browser.pickElement")}
          active={selecting}
        >
          <MousePointerSquareDashed className="h-4 w-4" />
        </IconBtn>
        {markers.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="relative h-8 gap-1 px-1.5 text-muted-foreground"
                title={t("panels.browser.markers", { total: markers.length, visible: visibleMarkers.length })}
              >
                <MapPin className="h-4 w-4" />
                <span className="text-xs tabular-nums">{markers.length}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
              {groupMarkersByPage(markers).map((group, gi) => (
                <React.Fragment key={group.url}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                    {group.title}
                    {urlsMatch(group.url, active.url) ? t("panels.browser.onThisPage") : ""}
                  </DropdownMenuLabel>
                  {group.markers.map((m) => (
                    <DropdownMenuItem
                      key={m.anchor.id}
                      onSelect={() => {
                        // Same page: just open the marker. Another page:
                        // navigate there first — the echo engine re-highlights
                        // after dom-ready, and the dot appears once
                        // active.url matches.
                        if (!urlsMatch(group.url, active.url)) navigate(group.url);
                        setEditingMarker(m.anchor.id);
                      }}
                    >
                      <span className="truncate">
                        <span className="font-medium">{m.anchor.label}</span>
                        {m.anchor.comment ? ` · ${m.anchor.comment}` : ""}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {showPopout && (
          <IconBtn
            onClick={() => void window.codeshell.openBrowserPopout(active.url === NEW_TAB ? undefined : active.url)}
            label={t("panels.browser.popout")}
          >
            <PictureInPicture2 className="h-4 w-4" />
          </IconBtn>
        )}
        <IconBtn
          onClick={() => active.url !== NEW_TAB && void window.codeshell.openExternal(active.url)}
          label={t("panels.browser.openExternal")}
        >
          <ExternalLink className="h-4 w-4" />
        </IconBtn>
      </div>

      {selecting && (
        <div className="shrink-0 border-b border-border bg-primary/10 px-3 py-1 text-xs text-foreground">
          {t("panels.browser.pickHint")}
        </div>
      )}

      {/* Content: webview or the new-tab landing (localhost bookmarks). The
          element-pick comment box + saved markers float over the page. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {active.url === NEW_TAB ? (
          <NewTabLanding onOpen={navigate} />
        ) : (
          <WebviewHost
            // key per tab: one <webview> is mounted at a time, so without a
            // per-tab key React would reuse a single guest across tabs and
            // their navigation histories (canGoBack/Forward) would bleed
            // together. Keying by tab gives each its own guest + history — and
            // freezes the per-tab initial src (see WebviewHost) so the guest's
            // own redirects don't re-drive `src` into an ERR_ABORTED race.
            key={activeId}
            ref={viewRef}
            initialUrl={active.url}
          />
        )}

        {/* Load-failure overlay. The <webview> renders blank on a failed load,
            so we cover it with our own message + retry rather than leave the user
            staring at a white panel (refused localhost dev server, DNS miss…). */}
        {active.url !== NEW_TAB && active.error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
            <Globe className="h-10 w-10 text-muted-foreground/50" />
            <div className="text-sm font-medium text-foreground">{t("panels.browser.cannotAccess")}</div>
            <div className="max-w-md break-all text-xs text-muted-foreground">{active.error.url}</div>
            <div className="text-xs text-muted-foreground">
              {/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(active.error.url)
                ? t("panels.browser.localhostDown")
                : t("panels.browser.connectionFailed")}
              <span className="ml-1 opacity-60">({active.error.desc || t("panels.browser.errorCode", { code: active.error.code })})</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const view = viewRef.current;
                  const target = active.error?.url ?? active.url;
                  patchTab(activeId, { error: undefined });
                  if (view) void view.loadURL(target).catch(() => undefined);
                }}
              >
                <RotateCw className="mr-1.5 h-3.5 w-3.5" /> {t("panels.common.retry")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void window.codeshell.openExternal(active.error?.url ?? active.url)}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> {t("panels.browser.openWithSystemBrowser")}
              </Button>
            </div>
          </div>
        )}

        {/* Saved comment dots over the page (derived from the anchors prop —
            every browser surface shows the same set). Click to edit/delete. */}
        {visibleMarkers.map((m, i) => (
          <MarkerDot
            key={m.anchor.id}
            index={i + 1}
            marker={m}
            editing={editingMarker === m.anchor.id}
            selectorMissed={selectorMissFor === m.anchor.id}
            onOpen={() => setEditingMarker(editingMarker === m.anchor.id ? null : m.anchor.id)}
            onDelete={() => {
              onRemoveAnchor?.(m.anchor.id);
              setEditingMarker(null);
            }}
            onUpdateComment={onUpdateAnchor ? (c) => onUpdateAnchor(m.anchor.id, c) : undefined}
          />
        ))}

        {/* Floating comment box for a freshly-picked element, near its rect. */}
        {picked && (
          <FloatingAt rect={picked.rect}>
            <CommentBox
              title={`${picked.tag}${picked.id ? "#" + picked.id : ""}`}
              onCancel={() => setPicked(null)}
              onSubmit={(comment) => {
                const label = picked.id
                  ? `${picked.tag}#${picked.id}`
                  : picked.labelHint || picked.selector.split(" > ").pop() || picked.tag;
                // Single source of truth: emit the anchor WITH its echo payload;
                // the dot appears when the anchor flows back via the anchors
                // prop (App state / hub broadcast) — no local marker copy.
                emitAnchor({
                  kind: "browser",
                  label,
                  locator: {
                    网址: picked.url,
                    选择器: picked.selector,
                    元素: picked.tag + (picked.className ? ` .${picked.className}` : ""),
                    ...(picked.text ? { 文本: picked.text } : {}),
                    尺寸: `${Math.round(picked.rect.width)}×${Math.round(picked.rect.height)}`,
                  },
                  comment,
                  browser: {
                    url: picked.url,
                    pageTitle:
                      picked.pageTitle ?? (active.title !== NEW_TAB_TITLE ? active.title : undefined),
                    selector: picked.selector,
                    rect: picked.rect,
                  },
                });
                setPicked(null);
              }}
            />
          </FloatingAt>
        )}
      </div>
    </div>
  );
}

/** Position children near a webview-viewport rect, clamped into view. */
function FloatingAt({ rect, children }: { rect: Rect; children: React.ReactNode }) {
  // Place just below the element; clamp so it doesn't overflow the panel.
  const top = Math.max(4, Math.min(rect.y + rect.height + 6, 9999));
  const left = Math.max(4, rect.x);
  return (
    <div className="absolute z-30 w-72 max-w-[90%]" style={{ top, left }}>
      {children}
    </div>
  );
}

/** A numbered dot at an element's rect; hover shows the comment, click edits. */
function MarkerDot({
  index,
  marker,
  editing,
  selectorMissed,
  onOpen,
  onDelete,
  onUpdateComment,
}: {
  index: number;
  marker: BrowserMarker;
  editing: boolean;
  /** The echo engine couldn't re-find the element by selector — show the
   *  pick-time rect as an overlay box instead of (silently) nothing. */
  selectorMissed: boolean;
  onOpen: () => void;
  onDelete: () => void;
  /** Save an edited comment (absent → comment is read-only). */
  onUpdateComment?: (comment: string) => void;
}) {
  const { t } = useT();
  const { rect } = marker.echo;
  // Editable comment draft — re-seeded each time the card opens (and when the
  // comment changes underneath us, e.g. edited in another window).
  const [draft, setDraft] = useState(marker.anchor.comment);
  useEffect(() => {
    if (editing) setDraft(marker.anchor.comment);
  }, [editing, marker.anchor.comment]);
  const dirty = draft !== marker.anchor.comment;
  return (
    <>
      <Button
        type="button"
        onClick={onOpen}
        title={marker.anchor.comment}
        size="icon"
        className="group absolute z-30 h-5 w-5 rounded-full text-[10px] font-semibold shadow ring-2 ring-background"
        style={{ top: Math.max(2, rect.y - 8), left: Math.max(2, rect.x - 8) }}
      >
        {index}
      </Button>
      {editing && selectorMissed && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-20 rounded-sm border-2 border-primary/80"
          style={{ top: rect.y, left: rect.x, width: rect.width, height: rect.height }}
        />
      )}
      {editing && (
        <div
          className="absolute z-40 w-72 max-w-[90%] rounded-md border border-border bg-card p-2 shadow-lg"
          style={{ top: Math.max(4, rect.y + rect.height + 6), left: Math.max(4, rect.x) }}
        >
          <div className="mb-1 truncate text-xs font-medium text-muted-foreground">{marker.anchor.label}</div>
          <div className="mb-1 truncate text-[11px] text-muted-foreground/80">
            {marker.echo.pageTitle ? `${marker.echo.pageTitle} · ` : ""}
            {pageAttribution(marker.echo)}
          </div>
          {selectorMissed && (
            <div className="mb-1 text-[11px] text-status-warn">
              {t("panels.browser.selectorMissed")}
            </div>
          )}
          {onUpdateComment ? (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("panels.browser.commentPlaceholder")}
              className="mb-2 min-h-14 resize-y text-xs"
            />
          ) : (
            <div className="mb-2 whitespace-pre-wrap break-words text-xs text-foreground">
              {marker.anchor.comment}
            </div>
          )}
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-status-err"
              onClick={onDelete}
            >
              {t("panels.common.delete")}
            </Button>
            {onUpdateComment && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!dirty}
                onClick={() => onUpdateComment(draft)}
              >
                {t("panels.common.save")}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onOpen}>
              {t("panels.common.close")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function IconBtn({
  children,
  onClick,
  disabled,
  label,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      variant="ghost"
      size="icon"
      className={
        "h-8 w-8 disabled:opacity-40 " +
        (active ? "bg-primary/15 text-primary" : "text-muted-foreground")
      }
    >
      {children}
    </Button>
  );
}

/** New-tab landing: discovered localhost dev servers as quick-open cards. */
function NewTabLanding({ onOpen }: { onOpen: (url: string) => void }) {
  const { t } = useT();
  const ports = useLocalhostPorts();
  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">{t("panels.browser.local")}</span>
      </div>
      {ports.length === 0 ? (
        <div className="text-sm text-muted-foreground">{t("panels.browser.noLocalServers")}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {ports.map((p) => (
            <Button
              key={p}
              type="button"
              onClick={() => onOpen(`http://localhost:${p}`)}
              variant="outline"
              className="flex h-auto items-center gap-3 rounded-lg p-3 text-left"
            >
              <Globe className="h-5 w-5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">localhost:{p}</div>
                <div className="truncate text-xs text-muted-foreground">http://localhost:{p}</div>
              </div>
              <span className="h-2 w-2 shrink-0 rounded-full bg-status-ok" />
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// Common dev-server ports (subset of Codex's list). We can't open raw TCP
// sockets from the renderer, so we probe each with a no-cors fetch and treat
// "reachable" (resolved or opaque) as up; CSP allows http://localhost:*.
const CANDIDATE_PORTS = [
  3000, 3001, 4000, 5000, 5173, 5174, 6006, 7000, 8000, 8080, 8888, 9000, 1420, 1313,
];

function useLocalhostPorts(): number[] {
  const [open, setOpen] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const live: number[] = [];
      await Promise.all(
        CANDIDATE_PORTS.map(async (port) => {
          try {
            await fetch(`http://localhost:${port}`, { mode: "no-cors", signal: AbortSignal.timeout(800) });
            live.push(port);
          } catch {
            /* not listening */
          }
        }),
      );
      if (!cancelled) setOpen(live.sort((a, b) => a - b));
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => open, [open]);
}

/** Coerce user input into a loadable URL (bare host → https, search → ddg). */
function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // Explicit scheme: only allow http(s). Anything else (javascript:, data:,
  // file:, vbscript:, …) is NOT navigated to — treat it as a search query so
  // the address bar can never be a script/file-exfil injection vector.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (schemeMatch) {
    return /^https?$/i.test(schemeMatch[1])
      ? s
      : `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
  }
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1/.test(s)) return `http://${s}`;
  // Looks like a domain (has a dot, no spaces) → assume https.
  if (/^[^\s]+\.[^\s]+$/.test(s)) return `https://${s}`;
  // Otherwise treat as a search query.
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}
