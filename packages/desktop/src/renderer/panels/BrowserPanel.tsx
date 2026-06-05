import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  Plus,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";

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
}

interface Tab {
  id: string;
  url: string;
  title: string;
  /** Address-bar text (may differ from the loaded url while typing). */
  draft: string;
}

const NEW_TAB = "about:blank";

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

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

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
      patchTab(activeId, { url, draft: url });
      const view = viewRef.current;
      if (view) void view.loadURL(url).catch(() => undefined);
    },
    [activeId, patchTab],
  );

  const openInNewTab = useCallback((url: string) => {
    const tab = freshTab();
    const norm = normalizeUrl(url);
    if (norm) {
      tab.url = norm;
      tab.draft = norm;
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
          onClick={() => active.url !== NEW_TAB && void window.codeshell.openExternal(active.url)}
          label="在外部打开"
        >
          <ExternalLink className="h-4 w-4" />
        </IconBtn>
      </div>

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
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-40"
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
