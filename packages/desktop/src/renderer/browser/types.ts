export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Electron's <webview> element. React 19's JSX doesn't know it; declare a
// minimal typing so we can render it and call its imperative methods.
export interface WebviewElement extends HTMLElement {
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

export interface Tab {
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

export const NEW_TAB = "about:blank";
/** Sentinel title for a freshly-minted tab; compared by identity and translated at render time. */
export const NEW_TAB_TITLE = "新选项卡";

// Tab-id generation. The counter alone is NOT collision-proof: React StrictMode
// double-invokes the useState initializer AND setState updaters in dev, and a
// hot-reload resets the module counter — both can mint the same `tab-N` twice
// ("two children with the same key `tab-1`"), which makes React duplicate/omit
// the keyed WebviewHost (blank / "点了没反应"). Mix in a per-call random suffix so
// even a re-run of the same counter value yields a distinct id.
let tabSeq = 0;
export function freshTabId(): string {
  tabSeq += 1;
  return `tab-${tabSeq}-${Math.random().toString(36).slice(2, 8)}`;
}
export function freshTab(initialUrl?: string): Tab {
  const url = initialUrl && initialUrl !== NEW_TAB ? initialUrl : NEW_TAB;
  return { id: freshTabId(), url, title: NEW_TAB_TITLE, draft: url === NEW_TAB ? "" : url };
}

/** Coerce user input into a loadable URL (bare host → https, search → ddg). */
export function normalizeUrl(raw: string): string | null {
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
