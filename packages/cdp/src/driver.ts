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
import type { RawSnapshot, CdpActionResult, CdpContentResult, CdpExtractResult } from "./types.js";
import { planKeySequence } from "./keymap.js";

/** Default cap for extracted page text (chars). */
export const CONTENT_CHAR_CAP = 12_000;
/** Cap for extracted links/images/videos per call. */
export const EXTRACT_LINK_CAP = 200;

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
      const deadline = Date.now() + timeoutMs;
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
    const deltaY = (dir === "down" ? 1 : -1) * (amount ?? 600);
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
    for(var j=0;j<ims.length;j++){
      var im=ims[j],s=im.src;
      if(!s||s.indexOf('data:')===0)continue;
      if(seenI[s])continue;seenI[s]=1;
      if(images.length>=cap){it=true;break;}
      var o={url:s};var alt=(im.getAttribute('alt')||'').trim();if(alt)o.alt=alt.slice(0,200);
      images.push(o);
    }
    function pushVid(s){if(!s||s.indexOf('data:')===0||s.indexOf('blob:')===0)return;if(seenV[s])return;seenV[s]=1;if(videos.length>=cap){vt=true;return;}videos.push({url:s});}
    var vs=document.querySelectorAll('video');
    for(var k=0;k<vs.length&&!vt;k++){
      var vd=vs[k];
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
