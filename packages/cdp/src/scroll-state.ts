/** Shared DOM observation for text reads and trusted wheel actions. The selected
 * region is based on visible area, not document height: app shells commonly
 * keep window.scrollY at zero while their main panel or canvas scrolls. */
export const READ_PAGE_STATE_EXPRESSION = `(() => {
  const candidates = [];
  const texts = [];
  const visit = (doc, offsetX = 0, offsetY = 0, clip = {
    left: 0, top: 0, right: innerWidth, bottom: innerHeight,
  }, depth = 0) => {
    if (depth > 8) return;
    const win = doc.defaultView;
    if (!win) return;
    texts.push(doc.body?.innerText || '');
    const root = doc.scrollingElement || doc.documentElement;
    const add = (el, kind, rect, known, scale = 1) => {
      let left = Math.max(clip.left, offsetX + rect.left);
      let top = Math.max(clip.top, offsetY + rect.top);
      let right = Math.min(clip.right, offsetX + rect.right);
      let bottom = Math.min(clip.bottom, offsetY + rect.bottom);
      for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
        const style = win.getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (['auto', 'scroll', 'hidden', 'clip', 'overlay'].includes(style.overflowX)) {
          left = Math.max(left, offsetX + bounds.left); right = Math.min(right, offsetX + bounds.right);
        }
        if (['auto', 'scroll', 'hidden', 'clip', 'overlay'].includes(style.overflowY)) {
          top = Math.max(top, offsetY + bounds.top); bottom = Math.min(bottom, offsetY + bounds.bottom);
        }
      }
      const width = right - left, height = bottom - top;
      if (width < 24 || height < 24) return;
      const viewportWidth = kind === 'page' ? win.innerWidth : el.clientWidth;
      const viewportHeight = kind === 'page' ? win.innerHeight : el.clientHeight;
      const x = Math.max(0, el.scrollLeft || 0), y = Math.max(0, el.scrollTop || 0);
      const maxX = known ? Math.max(0, el.scrollWidth - viewportWidth) : 0;
      const maxY = known ? Math.max(0, el.scrollHeight - viewportHeight) : 0;
      candidates.push({
        score: width * height * scale,
        wheelPoint: { x: (left + right) / 2, y: (top + bottom) / 2 },
        scroll: { x, y, maxX, maxY, viewportWidth, viewportHeight,
          atTop: known && y <= 1, atEnd: known && y >= maxY - 1,
          target: kind, positionKnown: known },
      });
    };
    const viewport = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
    const rootStyle = win.getComputedStyle(root);
    const bodyStyle = doc.body && win.getComputedStyle(doc.body);
    const rootScrollable = root.scrollHeight > win.innerHeight + 1 &&
      !['hidden', 'clip'].includes(rootStyle.overflowY) &&
      !(rootStyle.overflowY === 'visible' && bodyStyle && ['hidden', 'clip'].includes(bodyStyle.overflowY));
    if (rootScrollable) add(root, 'page', viewport, true);
    const scan = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        if (el === root || el === doc.body) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24 || rect.bottom <= 0 || rect.right <= 0 ||
            rect.top >= win.innerHeight || rect.left >= win.innerWidth) continue;
        const style = win.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const scrollable = el.scrollHeight > el.clientHeight + 1 &&
          ['auto', 'scroll', 'overlay'].includes(style.overflowY);
        if (scrollable) add(el, 'element', rect, true);
        // A canvas/custom frame has no meaningful DOM scroll offset. Keep the
        // position explicitly unknown and verify wheel progress from pixels.
        if (el.tagName === 'CANVAS') add(el, 'canvas', rect, false, 0.95);
        if (el.tagName === 'IFRAME') {
          let child;
          try { child = el.contentDocument; } catch {}
          if (child?.documentElement) {
            visit(child, offsetX + rect.left + el.clientLeft, offsetY + rect.top + el.clientTop, {
              left: Math.max(clip.left, offsetX + rect.left),
              top: Math.max(clip.top, offsetY + rect.top),
              right: Math.min(clip.right, offsetX + rect.right),
              bottom: Math.min(clip.bottom, offsetY + rect.bottom),
            }, depth + 1);
          } else add(el, 'frame', rect, false, 0.95);
        }
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    };
    scan(doc);
    // Static documents still have a valid page state; they must not outrank
    // a scrollable region in a child frame or panel.
    add(root, 'page', viewport, true, 0.000001);
  };
  visit(document);
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0];
  const text = texts.join('\\n');
  return { text, textLength: text.length, scroll: selected?.scroll,
    wheelPoint: selected?.wheelPoint,
    contentSignature: text.length + ':' + text.slice(-256) };
})()`;
