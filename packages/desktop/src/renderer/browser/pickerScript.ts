// The in-page element picker injected into the <webview> guest (no preload
// available there), extracted from BrowserPanel so the selector strategy is
// documented + testable in one place.
//
// Selector strategy (the part that bit us): the guest pages are commonly
// Tailwind apps whose class names contain `:` `[` `]` `/` `.` (e.g.
// `hover:bg-x`, `p-1.5`, `w-[120px]`). Naively concatenating them into a CSS
// selector makes querySelector THROW (`:bg-x` parses as a pseudo-class), so
// the echo engine reported "元素未能重新定位" on a page that hadn't changed
// at all. Three fixes, all verified AT PICK TIME while we still hold the
// element:
//   1. class names go through CSS.escape;
//   2. the candidate selector must round-trip (`querySelector(sel) === el`)
//      before we store it;
//   3. when the readable class-path fails, fall back to an exact positional
//      `html > … > tag:nth-child(i)` chain — guaranteed to resolve as long as
//      the DOM hasn't actually changed.

/** What the picker resolves with about the clicked element. */
export interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  id?: string;
  className?: string;
  /** Readable short label (tag + first classes, unescaped) for chips/dots —
   *  the stored `selector` may be a positional chain that reads poorly. */
  labelHint?: string;
  rect: { x: number; y: number; width: number; height: number };
  /**
   * URL of the page the element was picked on. Reported by the picker itself
   * (location.href) — authoritative, unlike the host panel's `active.url`
   * bookkeeping, which can go stale when a guest-side redirect happened
   * before navigation listeners were attached.
   */
  url: string;
  /** document.title at pick time (page-attribution display). */
  pageTitle?: string;
}

// Runs as the completion value of executeJavaScript — one expression
// evaluating to a Promise. Resolves null when the user presses Escape.
export const PICKER_SCRIPT = `
(() => new Promise((resolve) => {
  const OUTLINE = '2px solid #2563eb';
  let last = null;
  const restore = () => { if (last) { last.style.outline = lastOutline; last = null; } };
  let lastOutline = '';
  const cssEsc = (s) => (window.CSS && CSS.escape)
    ? CSS.escape(s)
    : String(s).replace(/[^a-zA-Z0-9_-]/g, (m) => '\\\\' + m);
  const matches = (sel, el) => { try { return document.querySelector(sel) === el; } catch (_) { return false; } };
  function classPath(el) {
    let path = [];
    let node = el;
    while (node && node.nodeType === 1 && path.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        part += '.' + Array.from(node.classList).slice(0, 2).map(cssEsc).join('.');
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
  function positionalPath(el) {
    let path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(node) + 1;
      path.unshift(node.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      node = parent;
    }
    return path.length ? 'html > ' + path.join(' > ') : el.tagName.toLowerCase();
  }
  function selectorFor(el) {
    if (el.id) { const s = '#' + cssEsc(el.id); if (matches(s, el)) return s; }
    const cls = classPath(el);
    if (matches(cls, el)) return cls;
    const pos = positionalPath(el);
    if (matches(pos, el)) return pos;
    return cls; // best effort — the echo engine rect-falls-back on a miss
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
    const cls = (el.classList && el.classList.length)
      ? '.' + Array.from(el.classList).slice(0, 2).join('.')
      : '';
    const info = {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().slice(0, 200),
      id: el.id || undefined,
      className: (typeof el.className === 'string' ? el.className : '') || undefined,
      labelHint: el.tagName.toLowerCase() + cls,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      url: location.href,
      pageTitle: document.title || undefined,
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
