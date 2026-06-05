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
function freshTab(): Tab {
  tabSeq += 1;
  return { id: `tab-${tabSeq}`, url: NEW_TAB, title: "新选项卡", draft: "" };
}

interface Props {
  /** Workspace root — reserved for future "open file in browser" wiring. */
  cwd: string | null;
}

/**
 * Built-in browser, modeled on Codex: Electron <webview> (own process +
 * persistent partition) with a self-drawn address bar, tabs, and a
 * localhost bookmark list discovered by port-probing common dev ports.
 */
export function BrowserPanel(_props: Props) {
  const [tabs, setTabs] = useState<Tab[]>(() => [freshTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const viewRef = useRef<WebviewElement | null>(null);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false, loading: false });
  // Element-picking ("圈选") state.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

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
      // Single navigation driver: update the tab url, which flows into the
      // <webview src> prop and triggers exactly one navigation. We deliberately
      // do NOT also call view.loadURL here — driving both the controlled `src`
      // and an imperative loadURL races two navigations and aborts one
      // (ERR_ABORTED). If the URL is unchanged (re-enter same address), nudge
      // via loadURL since `src` won't change.
      const view = viewRef.current;
      if (url === active.url && view) {
        void view.loadURL(url).catch(() => undefined);
      } else {
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
      {picked && (
        <div className="shrink-0 border-b border-border px-2">
          <CommentBox
            title={`${picked.tag}${picked.id ? "#" + picked.id : ""} · ${picked.selector}`}
            onCancel={() => setPicked(null)}
            onSubmit={(comment) => {
              addAnchor({
                kind: "browser",
                label: picked.id
                  ? `${picked.tag}#${picked.id}`
                  : picked.selector.split(" > ").pop() || picked.tag,
                locator: {
                  网址: picked.url,
                  选择器: picked.selector,
                  元素: picked.tag + (picked.className ? ` .${picked.className}` : ""),
                  ...(picked.text ? { 文本: picked.text } : {}),
                  尺寸: `${Math.round(picked.rect.width)}×${Math.round(picked.rect.height)}`,
                },
                comment,
              });
              setPicked(null);
            }}
          />
        </div>
      )}

      {/* Content: webview or the new-tab landing (localhost bookmarks). */}
      <div className="relative min-h-0 flex-1">
        {active.url === NEW_TAB ? (
          <NewTabLanding onOpen={navigate} />
        ) : (
          <webview
            // key per tab: one <webview> is mounted at a time, so without a
            // per-tab key React would reuse a single guest across tabs and
            // their navigation histories (canGoBack/Forward) would bleed
            // together. Keying by tab gives each its own guest + history.
            key={activeId}
            ref={viewRef as unknown as React.Ref<HTMLElement>}
            src={active.url}
            partition="persist:browser"
            style={{ width: "100%", height: "100%", display: "flex" }}
          />
        )}
      </div>
    </div>
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
