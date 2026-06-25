/**
 * CdpActionsDriver — drives a single browser target over the Chrome DevTools
 * Protocol. Self-contained: depends only on an injected `CdpSender`. Knows
 * NOTHING about Electron, React, core, or any UI — so the same driver can back
 * an Electron <webview>, a hidden BrowserWindow (unattended runs), or a
 * standalone Chromium over a raw CDP socket.
 *
 * observe: snapshot() returns the RAW Accessibility.getFullAXTree nodes — the
 *   host flattens them (which roles count, ref assignment, sensitive masking)
 *   because that carries product/security policy, not transport concerns.
 * act: ref → backendDOMNodeId → DOM.getBoxModel center → Input.dispatchMouseEvent
 *   (real, isTrusted=true input — not synthetic JS events).
 *
 * The host owns the ref→backendDOMNodeId map: snapshot() does NOT assign refs
 * (it returns raw nodes), so the host hands a backendDOMNodeId straight to the
 * action methods (clickNode/typeNode/…). This keeps the driver stateless w.r.t.
 * refs and lets the host's flatten + ref scheme live in one place.
 */

import type { CdpSender, PageInfo } from "./sender.js";
import type { RawSnapshot, CdpActionResult, CdpContentResult, CdpExtractResult, CdpImageData } from "./types.js";
import { planKeySequence } from "./keymap.js";

/** Default cap for extracted page text (chars). */
export const CONTENT_CHAR_CAP = 12_000;
/** Cap for extracted links/images/videos per call. */
export const EXTRACT_LINK_CAP = 200;
/** Max image dimension (px) we keep — Claude caps at 1568, downscaling past it
 *  is free token loss. Both image-fetch and screenshot downscale to this. */
export const MAX_IMAGE_DIM = 1568;

export class CdpActionsDriver {
  private enabled = false;

  constructor(
    private readonly send: CdpSender,
    private readonly pageInfo: () => Promise<PageInfo> | PageInfo,
  ) {}

  /** Accessibility/DOM domains must be enabled once before tree/box queries. */
  private async ensureEnabled(): Promise<void> {
    if (this.enabled) return;
    await this.send("DOM.enable");
    await this.send("Accessibility.enable");
    this.enabled = true;
  }

  /** Invalidate cached enable-state after a navigation (domains may reset). */
  resetDomains(): void {
    this.enabled = false;
  }

  /** Raw observation: page URL/title + raw AX nodes. Host flattens the nodes. */
  async snapshot(): Promise<RawSnapshot> {
    await this.ensureEnabled();
    const info = await this.pageInfo();
    const { nodes } = (await this.send("Accessibility.getFullAXTree")) as { nodes: RawSnapshot["nodes"] };
    return { url: info.url, title: info.title, nodes: nodes ?? [] };
  }

  /** Resolve a backendDOMNodeId to its element's viewport-center coordinates, or
   *  null if the node no longer has a box (DOM changed → stale). */
  async centerOf(backendNodeId: number): Promise<{ x: number; y: number } | null> {
    try {
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
      const { model } = (await this.send("DOM.getBoxModel", { backendNodeId })) as {
        model?: { content: number[] };
      };
      if (!model?.content || model.content.length < 8) return null;
      const xs = [model.content[0]!, model.content[2]!, model.content[4]!, model.content[6]!];
      const ys = [model.content[1]!, model.content[3]!, model.content[5]!, model.content[7]!];
      return { x: avg(xs), y: avg(ys) };
    } catch {
      return null; // node detached / no box → treat as stale
    }
  }

  async clickNode(backendNodeId: number): Promise<CdpActionResult> {
    const c = await this.centerOf(backendNodeId);
    if (!c) {
      // geometry failed — fall back to a JS .click() on the resolved node.
      return this.jsClick(backendNodeId);
    }
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
      const base = { x: c.x, y: c.y, button: "left", clickCount: 1 };
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  /** JS .click() fallback when the element has no usable box (e.g. zero-size
   *  but clickable, or occluded). Resolves the node to an objectId and calls it. */
  private async jsClick(backendNodeId: number): Promise<CdpActionResult> {
    try {
      const { object } = (await this.send("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string };
      };
      if (!object?.objectId) return { ok: false, detail: "element has no layout box", staleRef: true };
      await this.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function(){ this.click(); }",
      });
      return { ok: true, detail: "clicked via JS fallback (no layout box)" };
    } catch (e) {
      return { ok: false, detail: errMsg(e), staleRef: true };
    }
  }

  async typeNode(backendNodeId: number, text: string): Promise<CdpActionResult> {
    const c = await this.centerOf(backendNodeId);
    if (!c) return { ok: false, detail: "element has no layout box", staleRef: true };
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
      await this.send("Input.insertText", { text });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  /** Focus a node by clicking its center (so subsequent key events land there). */
  async focusNode(backendNodeId: number): Promise<CdpActionResult> {
    const c = await this.centerOf(backendNodeId);
    if (!c) return { ok: false, detail: "element has no layout box", staleRef: true };
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  /** Hover over a node (reveal hover-dependent UI). Moves the mouse to its
   *  center without pressing. */
  async hoverNode(backendNodeId: number): Promise<CdpActionResult> {
    const c = await this.centerOf(backendNodeId);
    if (!c) return { ok: false, detail: "element has no layout box", staleRef: true };
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  /**
   * Press a key (or combination) on the focused element. `spec` is a key name
   * ("Enter", "Tab", "Escape", "ArrowDown") or a combination ("Control+a",
   * "Meta+Shift+z"). The key map + sequence planning live in keymap.ts.
   */
  async pressKey(spec: string): Promise<CdpActionResult> {
    const seq = planKeySequence(spec);
    if (seq.length === 0) return { ok: false, detail: `empty key spec: ${spec}` };
    try {
      for (const ev of seq) {
        const { type, ...rest } = ev;
        await this.send("Input.dispatchKeyEvent", { type, ...rest });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  /**
   * Select an option in a native <select> by setting its value via JS (matching
   * by option value first, then visible text) and dispatching input+change so
   * page frameworks react. On NO match, returns ok:false with the available
   * option labels in `detail` so the agent can re-pick (the "按需查 option" path
   * — we never bloat snapshots with option lists). Custom <div> dropdowns are
   * NOT handled here — those expand into real elements the agent clicks.
   */
  async selectOptionNode(backendNodeId: number, value: string): Promise<CdpActionResult> {
    try {
      const { object } = (await this.send("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string };
      };
      if (!object?.objectId) return { ok: false, detail: "select element not resolvable", staleRef: true };
      const res = (await this.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: SELECT_OPTION_FN,
        arguments: [{ value }],
        returnByValue: true,
      })) as { result?: { value?: { ok?: boolean; matched?: string; options?: string[] } } };
      const v = res.result?.value;
      if (v?.ok) return { ok: true, detail: v.matched ? `selected "${v.matched}"` : undefined };
      const opts = (v?.options ?? []).slice(0, 50).join(" / ");
      return { ok: false, detail: `no option matched "${value}". available: ${opts || "(none — not a native <select>?)"}` };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  /**
   * Fetch ONE page image's real pixels and return base64. Runs fetch+canvas IN
   * THE PAGE so it carries the page's cookies/referer — the only way to read
   * images behind hotlink protection (小红书 etc.); a main-process fetch would
   * 403. Downscales to MAX_IMAGE_DIM. On CORS taint (canvas.toDataURL throws),
   * returns ok:false so the host can fall back to a screenshot of the element.
   */
  async fetchImageData(ref: string, maxDim = MAX_IMAGE_DIM): Promise<CdpImageData> {
    try {
      // Resolve the ref (img1/vid1…) tagged by the last extract via data-cs-ref,
      // fetch+canvas IN PAGE (page cookies → beats hotlink protection).
      const res = (await this.send("Runtime.evaluate", {
        expression: `(${FETCH_IMAGE_BY_REF_FN})(${JSON.stringify(ref)}, ${maxDim})`,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: { ok?: boolean; dataUrl?: string; detail?: string; missing?: boolean } } };
      const v = res.result?.value;
      if (v?.missing) return { ok: false, detail: `ref ${ref} not found — re-run browser_observe(extract)` };
      if (!v?.ok || !v.dataUrl) return { ok: false, detail: v?.detail ?? "could not read image pixels" };
      return { ...parseDataUrl(v.dataUrl), ref };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  /**
   * Capture a screenshot (viewport, or a backendNode's box if given) as JPEG,
   * downscaled to maxDim NATIVELY by CDP via clip.scale — no in-page canvas
   * round-trip (that pathologically stalls on heavy pages: injecting a multi-MB
   * base64 string into a busy JS context + decode took 20-30s on 小红书). CDP
   * scales server-side, so this is fast regardless of page weight. Used for
   * vision mode and as the CORS-taint fallback for fetchImageData (a <video>
   * frame is just a screenshot of the element box).
   */
  async screenshot(backendNodeId?: number, maxDim = MAX_IMAGE_DIM): Promise<CdpImageData> {
    try {
      // Region to capture (CSS px) + the native scale that fits it into maxDim.
      let region: { x: number; y: number; width: number; height: number };
      if (backendNodeId !== undefined) {
        const { model } = (await this.send("DOM.getBoxModel", { backendNodeId })) as {
          model?: { content: number[] };
        };
        if (!model?.content || model.content.length < 8) {
          return { ok: false, detail: "element has no layout box", staleRef: true };
        }
        const xs = [model.content[0]!, model.content[2]!, model.content[4]!, model.content[6]!];
        const ys = [model.content[1]!, model.content[3]!, model.content[5]!, model.content[7]!];
        const x = Math.min(...xs), y = Math.min(...ys);
        region = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
      } else {
        const { layoutViewport } = (await this.send("Page.getLayoutMetrics")) as {
          layoutViewport?: { clientWidth?: number; clientHeight?: number };
        };
        region = {
          x: 0,
          y: 0,
          width: layoutViewport?.clientWidth || 1280,
          height: layoutViewport?.clientHeight || 800,
        };
      }
      if (region.width < 1 || region.height < 1) {
        return { ok: false, detail: "capture region is empty" };
      }
      // scale ≤ 1 so the larger dimension lands at ~maxDim — CDP does the resize.
      const scale = Math.min(1, maxDim / Math.max(region.width, region.height));
      const shot = (await this.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        captureBeyondViewport: false,
        clip: { ...region, scale },
      })) as { data?: string };
      if (!shot.data) return { ok: false, detail: "screenshot returned no data" };
      return { ok: true, base64: shot.data, mediaType: "image/jpeg" };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  async navigate(url: string): Promise<CdpActionResult> {
    try {
      await this.send("Page.navigate", { url });
      this.enabled = false; // domains may need re-enabling after cross-doc nav
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  async readContent(): Promise<CdpContentResult> {
    const info = await this.pageInfo();
    try {
      const res = (await this.send("Runtime.evaluate", {
        expression: "document.body && document.body.innerText || ''",
        returnByValue: true,
      })) as { result?: { value?: string } };
      const raw = res.result?.value ?? "";
      const { text, truncated } = cleanPageText(raw);
      return { ok: true, url: info.url, title: info.title, text, truncated };
    } catch (e) {
      return { ok: false, url: info.url, title: info.title, text: "", detail: errMsg(e) };
    }
  }

  async extractLinks(): Promise<CdpExtractResult> {
    const info = await this.pageInfo();
    try {
      const res = (await this.send("Runtime.evaluate", {
        expression: buildExtractScript(EXTRACT_LINK_CAP),
        returnByValue: true,
      })) as {
        result?: {
          value?: { links?: CdpExtractResult["links"]; images?: CdpExtractResult["images"]; videos?: CdpExtractResult["videos"]; truncated?: boolean };
        };
      };
      const v = res.result?.value;
      return {
        ok: true,
        url: info.url,
        title: info.title,
        links: v?.links ?? [],
        images: v?.images ?? [],
        videos: v?.videos ?? [],
        truncated: v?.truncated ?? false,
      };
    } catch (e) {
      return { ok: false, url: info.url, title: info.title, links: [], images: [], videos: [], detail: errMsg(e) };
    }
  }

  async waitForLoad(timeoutMs = 10_000): Promise<CdpActionResult> {
    try {
      // Guard a non-finite / non-positive timeout: `Date.now() + NaN === NaN`
      // and `Date.now() > NaN` is always false → `while(true)` would never exit
      // (infinite poll loop). Fall back to the default so the loop terminates.
      const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000;
      const deadline = Date.now() + effectiveTimeout;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = (await this.send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        })) as { result?: { value?: string } };
        if (res.result?.value === "complete") return { ok: true };
        if (Date.now() > deadline) return { ok: true, detail: "load wait timed out (proceeding)" };
        await delay(150);
      }
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  async scroll(dir: "up" | "down", amount?: number): Promise<CdpActionResult> {
    // Guard a non-finite amount (NaN/Infinity) → would send NaN deltaY to CDP.
    const magnitude = typeof amount === "number" && Number.isFinite(amount) ? Math.abs(amount) : 600;
    const deltaY = (dir === "down" ? 1 : -1) * magnitude;
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 0, y: 0, deltaX: 0, deltaY });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }
}

function avg(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Split a "data:<mime>;base64,<data>" URL into a CdpImageData. */
function parseDataUrl(dataUrl: string): CdpImageData {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return { ok: false, detail: "unexpected dataURL format" };
  return { ok: true, mediaType: m[1], base64: m[2] };
}

/**
 * In-page (runs on an <img>/<video> element). fetch the element's source with
 * the PAGE's credentials (beats hotlink protection), draw onto a canvas
 * downscaled to maxDim, return a JPEG dataURL. Async (awaitPromise). On a video
 * element, draws the current frame. Returns {ok:false, detail} on CORS taint.
 */
const FETCH_IMAGE_BY_REF_FN = `async function(ref, maxDim){
  maxDim = maxDim || 1568;
  try {
    var el = document.querySelector('[data-cs-ref="' + ref + '"]');
    if (!el) return { ok:false, missing:true };
    var isVideo = el.tagName === 'VIDEO';
    var srcW = isVideo ? (el.videoWidth || el.clientWidth) : (el.naturalWidth || el.width);
    var srcH = isVideo ? (el.videoHeight || el.clientHeight) : (el.naturalHeight || el.height);
    var bmp;
    if (isVideo) {
      bmp = el; // drawImage accepts a video element (current frame)
    } else {
      // Re-fetch through the page so cross-origin-but-same-site cookies apply,
      // then decode to a bitmap the canvas can draw without tainting (the fetch
      // response is same-origin to the canvas once we hold the bytes as a blob).
      var resp = await fetch(el.currentSrc || el.src, { credentials: 'include' });
      if (!resp.ok) return { ok:false, detail: 'fetch ' + resp.status };
      var blob = await resp.blob();
      bmp = await createImageBitmap(blob);
      srcW = bmp.width; srcH = bmp.height;
    }
    if (!srcW || !srcH) return { ok:false, detail: 'image has no dimensions' };
    var scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    var w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0, w, h);
    return { ok:true, dataUrl: c.toDataURL('image/jpeg', 0.85) };
  } catch (e) {
    return { ok:false, detail: (e && e.message) || String(e) };
  }
}`;

/**
 * In-page JS (string) collecting deduped absolute link + image + video URLs.
 * Self-contained (no core dep). Ported from core's buildExtractLinksScript,
 * extended with <video>/<source> src collection (per browser module redesign).
 */
export function buildExtractScript(cap = EXTRACT_LINK_CAP): string {
  return `(function(){
    var cap=${cap};
    var links=[],images=[],videos=[],lt=false,it=false,vt=false,seenL={},seenI={},seenV={};
    var as=document.querySelectorAll('a[href]');
    for(var i=0;i<as.length;i++){
      var a=as[i],u=a.href;
      if(!u||u.indexOf('javascript:')===0||u==='#'||u.charAt(u.length-1)==='#'&&u.indexOf('#')===u.length-1)continue;
      if(seenL[u])continue;seenL[u]=1;
      if(links.length>=cap){lt=true;break;}
      links.push({text:(a.textContent||'').trim().slice(0,200),url:u});
    }
    var ims=document.querySelectorAll('img[src]');
    var imgN=0;
    for(var j=0;j<ims.length;j++){
      var im=ims[j],s=im.src;
      if(!s||s.indexOf('data:')===0)continue;
      if(seenI[s])continue;seenI[s]=1;
      if(images.length>=cap){it=true;break;}
      imgN++;var ref='img'+imgN;
      try{im.setAttribute('data-cs-ref',ref);}catch(e){}
      var o={url:s,ref:ref};var alt=(im.getAttribute('alt')||'').trim();if(alt)o.alt=alt.slice(0,200);
      images.push(o);
    }
    function pushVid(s){if(!s||s.indexOf('data:')===0||s.indexOf('blob:')===0)return;if(seenV[s])return;seenV[s]=1;if(videos.length>=cap){vt=true;return;}videos.push({url:s});}
    var vs=document.querySelectorAll('video'),vidN=0;
    for(var k=0;k<vs.length&&!vt;k++){
      var vd=vs[k];
      vidN++;try{vd.setAttribute('data-cs-ref','vid'+vidN);}catch(e){}
      if(vd.currentSrc)pushVid(vd.currentSrc);else if(vd.src)pushVid(vd.src);
      var srcs=vd.querySelectorAll('source[src]');
      for(var m=0;m<srcs.length&&!vt;m++)pushVid(srcs[m].src);
    }
    return {links:links,images:images,videos:videos,truncated:lt||it||vt};
  })()`;
}

/**
 * In-page function (runs on the <select> node via Runtime.callFunctionOn) that
 * sets the selected option by value-then-text match and fires input+change.
 * Returns {ok, matched?, options?} — options listed only on miss (for re-pick).
 */
const SELECT_OPTION_FN = `function(arg){
  var want = (arg && arg.value != null) ? String(arg.value) : '';
  if (!this || this.tagName !== 'SELECT' || !this.options) {
    return { ok:false, options:[] };
  }
  var opts = this.options, labels = [];
  var wantLc = want.toLowerCase();
  var hit = -1;
  for (var i=0;i<opts.length;i++){
    var o=opts[i], txt=(o.textContent||'').trim();
    labels.push(txt);
    if (hit===-1 && o.value === want) hit=i;            // exact value match first
  }
  if (hit===-1){
    for (var j=0;j<opts.length;j++){                    // then exact text
      if ((opts[j].textContent||'').trim() === want){ hit=j; break; }
    }
  }
  if (hit===-1){
    for (var k=0;k<opts.length;k++){                    // then case-insensitive text contains
      if ((opts[k].textContent||'').trim().toLowerCase().indexOf(wantLc) !== -1){ hit=k; break; }
    }
  }
  if (hit===-1) return { ok:false, options:labels };
  this.selectedIndex = hit;
  this.dispatchEvent(new Event('input', { bubbles:true }));
  this.dispatchEvent(new Event('change', { bubbles:true }));
  return { ok:true, matched:(opts[hit].textContent||'').trim() };
}`;

/** Pure: normalize raw extracted page text. Ported verbatim from core's
 *  cleanPageText so readContent behavior is byte-identical post-extraction. */
export function cleanPageText(raw: string, cap: number = CONTENT_CHAR_CAP): { text: string; truncated: boolean } {
  const normalized = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= cap) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, cap) + "\n…(truncated)", truncated: true };
}
