import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  Plus,
  X,
  MousePointerSquareDashed,
  PictureInPicture2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { CommentBox } from "../chat/CommentBox";
import { addAnchor } from "../chat/addAnchor";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A saved comment marker shown as a dot over the page. */
interface PageMarker {
  id: string;
  /** Composer anchor id this marker is tied to (for removal sync). */
  anchorId: string;
  url: string;
  rect: Rect;
  /** CSS selector of the picked element, so re-editing can re-highlight the
   *  actual element in the guest page (rect alone drifts on scroll/reflow). */
  selector?: string;
  label: string;
  comment: string;
}

let markerSeq = 0;

/** What the in-page picker returns about the clicked element. */
interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  id?: string;
  className?: string;
  rect: Rect;
  /** URL of the page the element was picked on (captured at pick time, so a
   *  later tab switch can't misattribute the anchor to another page). */
  url: string;
}

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
}

const NEW_TAB = "about:blank";

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

// Injected into the guest page (no preload available there). Highlights the
// hovered element with an outline, and on click resolves with a compact
// descriptor: a best-effort CSS selector, tag, trimmed text, and bounding rect.
// Returns null if the user presses Escape. Runs as the completion value of
// executeJavaScript, so the whole thing is one expression evaluating to a
// Promise.
const PICKER_SCRIPT = `
(() => new Promise((resolve) => {
  const OUTLINE = '2px solid #2563eb';
  let last = null;
  const restore = () => { if (last) { last.style.outline = lastOutline; last = null; } };
  let lastOutline = '';
  function selectorFor(el) {
    if (el.id) return '#' + el.id;
    let path = [];
    let node = el;
    while (node && node.nodeType === 1 && path.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        part += '.' + Array.from(node.classList).slice(0, 2).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      path.unshift(part);
      node = node.parentElement;
    }
    return path.join(' > ');
  }
  function onMove(e) {
    const el = e.target;
    if (el === last) return;
    restore();
    last = el; lastOutline = el.style.outline; el.style.outline = OUTLINE;
  }
  function cleanup() {
    restore();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onClick(e) {
    e.preventDefault(); e.stopPropagation();
    const el = e.target;
    const r = el.getBoundingClientRect();
    const info = {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().slice(0, 200),
      id: el.id || undefined,
      className: (typeof el.className === 'string' ? el.className : '') || undefined,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
    cleanup();
    resolve(info);
  }
  function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(null); } }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}))()
`;

let tabSeq = 0;
function freshTab(initialUrl?: string): Tab {
  tabSeq += 1;
  const url = initialUrl && initialUrl !== NEW_TAB ? initialUrl : NEW_TAB;
  return { id: `tab-${tabSeq}`, url, title: "新选项卡", draft: url === NEW_TAB ? "" : url };
}

interface Props {
  /** Workspace root — reserved for future "open file in browser" wiring. */
  cwd: string | null;
  /** Initial URL to open (used by the popout window). */
  initialUrl?: string;
  /**
   * Where a comment anchor goes. Defaults to the in-window composer (via the
   * add-anchor event). The popout window overrides this to send over IPC to the
   * parent window's composer. Return value unused.
   */
  onAnchor?: (a: { kind: "browser"; label: string; locator: Record<string, string>; comment: string }) => string | void;
  /** Whether to show the "弹出独立窗口" button (hidden inside the popout itself). */
  showPopout?: boolean;
}

/**
 * Built-in browser, modeled on Codex: Electron <webview> (own process +
 * persistent partition) with a self-drawn address bar, tabs, and a
 * localhost bookmark list discovered by port-probing common dev ports.
 */
export function BrowserPanel({ initialUrl, onAnchor, showPopout = true }: Props) {
  const emitAnchor = onAnchor ?? addAnchor;
  const [tabs, setTabs] = useState<Tab[]>(() => [freshTab(initialUrl)]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const viewRef = useRef<WebviewElement | null>(null);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false, loading: false });
  // Element-picking ("圈选") state.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  // Saved comment markers on the current page (kept until the message sends).
  // Keyed list; each has the element rect (for the dot position), the comment,
  // and the anchor id so removing the anchor removes the dot.
  const [markers, setMarkers] = useState<PageMarker[]>([]);
  // Which marker is open for editing (its id), if any.
  const [editingMarker, setEditingMarker] = useState<string | null>(null);

  // Clear page markers once the composer's anchors are cleared (message sent),
  // and drop a single marker if its anchor chip is removed.
  useEffect(() => {
    const onCleared = (): void => setMarkers([]);
    const onRemoved = (e: Event): void => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) setMarkers((m) => m.filter((x) => x.anchorId !== id));
    };
    window.addEventListener("codeshell:anchors-cleared", onCleared);
    window.addEventListener("codeshell:anchor-removed", onRemoved);
    return () => {
      window.removeEventListener("codeshell:anchors-cleared", onCleared);
      window.removeEventListener("codeshell:anchor-removed", onRemoved);
    };
  }, []);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  // Markers belong to a page; hide them when not on that URL.
  const visibleMarkers = markers.filter((m) => m.url === active.url);

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
      if (result) setPicked({ ...result, url: pickUrl });
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

  // Re-highlight the marked element in the GUEST page while its marker is being
  // edited, so the user sees "where it was circled" (not just the dot). Injects
  // an outline on the marker's selector; clears it when editing stops/changes.
  // Best-effort: a selector that no longer matches (dynamic page) just no-ops.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const HL = "__cs_marker_hl__";
    const clear = `(()=>{const e=document.querySelector('[data-${HL}]');if(e){e.style.outline=e.dataset.${HL}||'';e.removeAttribute('data-${HL}');}})()`;
    // executeJavaScript THROWS SYNCHRONOUSLY (not a rejected promise) when the
    // <webview> isn't attached + dom-ready yet — the popout mounts with a real
    // src so this effect can fire pre-ready, and an uncaught throw here unmounts
    // the whole BrowserPanel (blank popout). `.catch()` only catches the async
    // reject; wrap the call so the sync throw can't escape.
    const exec = (code: string): void => {
      try {
        void view.executeJavaScript(code).catch(() => {});
      } catch {
        /* webview not ready yet — the highlight is best-effort, skip */
      }
    };
    const target = editingMarker ? markers.find((m) => m.id === editingMarker) : null;
    if (!target?.selector) {
      exec(clear);
      return;
    }
    const sel = JSON.stringify(target.selector);
    exec(
      `(()=>{${clear};try{const el=document.querySelector(${sel});if(el){el.dataset.${HL}=el.style.outline||'';el.style.outline='2px solid #2563eb';el.scrollIntoView({block:'center'});}}catch(_){}})()`,
    );
    return () => exec(clear);
  }, [editingMarker, markers]);

  // Wire webview lifecycle events for the active tab.
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
      if (url && url !== NEW_TAB) patchTab(activeId, { url, draft: url });
      refreshNav();
    };
    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    view.addEventListener("page-title-updated", onTitle as EventListener);
    view.addEventListener("did-navigate", onNavigate as EventListener);
    view.addEventListener("did-navigate-in-page", onNavigate as EventListener);
    return () => {
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("page-title-updated", onTitle as EventListener);
      view.removeEventListener("did-navigate", onNavigate as EventListener);
      view.removeEventListener("did-navigate-in-page", onNavigate as EventListener);
    };
  }, [activeId, patchTab]);

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

  // A chat answer link (http/https) was clicked: App opens/focuses this panel,
  // and we open the URL in a new tab here. If the only tab is the blank landing,
  // load into it rather than stacking an empty tab in front of it.
  useEffect(() => {
    const onOpenUrl = (e: Event): void => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      const norm = normalizeUrl(url);
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
    };
    window.addEventListener("codeshell:open-url", onOpenUrl);
    return () => window.removeEventListener("codeshell:open-url", onOpenUrl);
  }, []);

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
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex max-w-[180px] items-center gap-1 rounded-md px-2 py-1 text-xs ${
              t.id === activeId ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
            }`}
          >
            <button type="button" className="flex min-w-0 items-center gap-1" onClick={() => setActiveId(t.id)}>
              <Globe className="h-3 w-3 shrink-0" />
              <span className="truncate">{t.title}</span>
            </button>
            <button
              type="button"
              className="shrink-0 opacity-0 group-hover:opacity-100"
              onClick={() => closeTab(t.id)}
              aria-label="关闭标签"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground hover:bg-accent"
          onClick={() => openInNewTab(NEW_TAB)}
          aria-label="新选项卡"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Address bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <IconBtn disabled={!nav.canGoBack} onClick={() => viewRef.current?.goBack()} label="后退">
          <ArrowLeft className="h-4 w-4" />
        </IconBtn>
        <IconBtn disabled={!nav.canGoForward} onClick={() => viewRef.current?.goForward()} label="前进">
          <ArrowRight className="h-4 w-4" />
        </IconBtn>
        <IconBtn onClick={() => viewRef.current?.reload()} label="刷新">
          <RotateCw className={`h-4 w-4 ${nav.loading ? "animate-spin" : ""}`} />
        </IconBtn>
        <Input
          value={active.draft}
          onChange={(e) => patchTab(activeId, { draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(active.draft);
          }}
          placeholder="输入 URL"
          className="h-8 flex-1"
        />
        <IconBtn
          onClick={() => void startPicking()}
          disabled={active.url === NEW_TAB || selecting}
          label={selecting ? "点选页面元素…" : "圈选元素(加入输入框)"}
          active={selecting}
        >
          <MousePointerSquareDashed className="h-4 w-4" />
        </IconBtn>
        {showPopout && (
          <IconBtn
            onClick={() => void window.codeshell.openBrowserPopout(active.url === NEW_TAB ? undefined : active.url)}
            label="弹出独立窗口"
          >
            <PictureInPicture2 className="h-4 w-4" />
          </IconBtn>
        )}
        <IconBtn
          onClick={() => active.url !== NEW_TAB && void window.codeshell.openExternal(active.url)}
          label="在外部打开"
        >
          <ExternalLink className="h-4 w-4" />
        </IconBtn>
      </div>

      {selecting && (
        <div className="shrink-0 border-b border-border bg-primary/10 px-3 py-1 text-xs text-foreground">
          点选页面上的元素以添加评论 · Esc 取消
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

        {/* Saved comment dots over the page. Click to edit/delete. */}
        {visibleMarkers.map((m, i) => (
          <MarkerDot
            key={m.id}
            index={i + 1}
            marker={m}
            editing={editingMarker === m.id}
            onOpen={() => setEditingMarker(editingMarker === m.id ? null : m.id)}
            onDelete={() => {
              setMarkers((prev) => prev.filter((x) => x.id !== m.id));
              window.dispatchEvent(
                new CustomEvent("codeshell:remove-anchor-request", { detail: { id: m.anchorId } }),
              );
              setEditingMarker(null);
            }}
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
                  : picked.selector.split(" > ").pop() || picked.tag;
                const ret = emitAnchor({
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
                });
                markerSeq += 1;
                setMarkers((prev) => [
                  ...prev,
                  {
                    id: `mk-${markerSeq}`,
                    anchorId: typeof ret === "string" ? ret : `mk-${markerSeq}`,
                    url: picked.url,
                    rect: picked.rect,
                    selector: picked.selector,
                    label,
                    comment,
                  },
                ]);
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
  onOpen,
  onDelete,
}: {
  index: number;
  marker: PageMarker;
  editing: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { rect } = marker;
  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        title={marker.comment}
        className="group absolute z-30 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground shadow ring-2 ring-background"
        style={{ top: Math.max(2, rect.y - 8), left: Math.max(2, rect.x - 8) }}
      >
        {index}
      </button>
      {editing && (
        <div
          className="absolute z-40 w-72 max-w-[90%] rounded-md border border-border bg-card p-2 shadow-lg"
          style={{ top: Math.max(4, rect.y + rect.height + 6), left: Math.max(4, rect.x) }}
        >
          <div className="mb-1 truncate text-xs font-medium text-muted-foreground">{marker.label}</div>
          <div className="mb-2 whitespace-pre-wrap break-words text-xs text-foreground">{marker.comment}</div>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              className="rounded px-2 py-0.5 text-xs text-status-err hover:bg-accent"
              onClick={onDelete}
            >
              删除
            </button>
            <button type="button" className="rounded px-2 py-0.5 text-xs hover:bg-accent" onClick={onOpen}>
              关闭
            </button>
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={
        "rounded-md p-1.5 hover:bg-accent disabled:opacity-40 " +
        (active ? "bg-primary/15 text-primary" : "text-muted-foreground")
      }
    >
      {children}
    </button>
  );
}

/** New-tab landing: discovered localhost dev servers as quick-open cards. */
function NewTabLanding({ onOpen }: { onOpen: (url: string) => void }) {
  const ports = useLocalhostPorts();
  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">本地</span>
      </div>
      {ports.length === 0 ? (
        <div className="text-sm text-muted-foreground">未发现正在运行的本地服务</div>
      ) : (
        <div className="flex flex-col gap-2">
          {ports.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onOpen(`http://localhost:${p}`)}
              className="flex items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-accent"
            >
              <Globe className="h-5 w-5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">localhost:{p}</div>
                <div className="truncate text-xs text-muted-foreground">http://localhost:{p}</div>
              </div>
              <span className="h-2 w-2 shrink-0 rounded-full bg-status-ok" />
            </button>
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
