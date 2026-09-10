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
import type {
  RawSnapshot,
  CdpActionResult,
  CdpContentResult,
  CdpExtractResult,
  CdpImageData,
  CdpReadOptions,
  CdpScrollState,
} from "./types.js";
import { planKeySequence, type KeyboardPlatform } from "./keymap.js";
import { READ_PAGE_STATE_EXPRESSION } from "./scroll-state.js";

/** Default cap for extracted page text (chars). */
export const CONTENT_CHAR_CAP = 12_000;
/** Hard ceiling for one text chunk even if a caller requests more. */
export const MAX_CONTENT_CHAR_CAP = 24_000;
/** Cap for extracted links/images/videos per call. */
export const EXTRACT_LINK_CAP = 200;
/** Max image dimension (px) we keep — Claude caps at 1568, downscaling past it
 *  is free token loss. Both image-fetch and screenshot downscale to this. */
export const MAX_IMAGE_DIM = 1568;
/** Default timeout for in-page image fetch/decode/canvas work. */
export const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 15_000;
/** Schemes the standalone driver will navigate to without host policy. */
export const DEFAULT_NAVIGATION_SCHEMES = ["http:", "https:", "about:"] as const;

export interface CdpScreenshotRequest {
  /** Optional visible element region in viewport-relative CSS pixels. */
  region?: { x: number; y: number; width: number; height: number };
  /** Maximum encoded image width or height in pixels. */
  maxDim: number;
}

export interface CdpActionsDriverOptions {
  /** Host OS of the target browser; required for macOS shortcut semantics. */
  keyboardPlatform?: KeyboardPlatform;
  /** Host-assigned target generation, so refs/cursors cannot cross recreated targets. */
  documentNamespace?: string;
  /** Optional host policy gate; false blocks before Page.navigate. */
  canNavigate?: (url: URL) => boolean | Promise<boolean>;
  /** Allowed URL schemes. Defaults to http(s) plus about:blank. */
  allowedNavigationSchemes?: readonly string[];
  /** Timeout for in-page image fetch/decode/canvas work. */
  imageFetchTimeoutMs?: number;
  /** Host-native screenshot capture, bound to this exact browser target. */
  captureScreenshot?: (request: CdpScreenshotRequest) => Promise<CdpImageData>;
}

export type NavigationUrlValidation =
  | { ok: true; url: string; parsed: URL }
  | { ok: false; detail: string };

export function validateNavigationUrl(
  raw: string,
  allowedSchemes: readonly string[] = DEFAULT_NAVIGATION_SCHEMES,
): NavigationUrlValidation {
  const input = raw.trim();
  if (!input) return { ok: false, detail: "navigation URL is empty" };
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, detail: "navigation URL must be absolute" };
  }
  const allowed = new Set(allowedSchemes.map((s) => (s.endsWith(":") ? s : `${s}:`).toLowerCase()));
  const scheme = parsed.protocol.toLowerCase();
  if (!allowed.has(scheme))
    return { ok: false, detail: `navigation scheme not allowed: ${scheme.replace(/:$/, "")}` };
  if (scheme === "about:" && parsed.href !== "about:blank") {
    return { ok: false, detail: "only about:blank is allowed for about: navigation" };
  }
  return { ok: true, url: parsed.href, parsed };
}

export class CdpActionsDriver {
  private enabled = false;

  constructor(
    private readonly send: CdpSender,
    private readonly pageInfo: () => Promise<PageInfo> | PageInfo,
    private readonly options: CdpActionsDriverOptions = {},
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
    const { nodes } = (await this.send("Accessibility.getFullAXTree")) as {
      nodes: RawSnapshot["nodes"];
    };
    const documentId = await this.currentDocumentId(info.url);
    return { url: info.url, title: info.title, documentId, nodes: nodes ?? [] };
  }

  /** Main-frame identity used to invalidate snapshots/cursors after navigation. */
  async currentDocumentId(fallbackUrl?: string): Promise<string> {
    const scoped = (id: string) =>
      this.options.documentNamespace ? `${this.options.documentNamespace}:${id}` : id;
    try {
      const tree = (await this.send("Page.getFrameTree")) as {
        frameTree?: { frame?: { id?: string; loaderId?: string; url?: string } };
      };
      const frame = tree.frameTree?.frame;
      if (frame?.id && frame.loaderId) return scoped(`${frame.id}:${frame.loaderId}`);
      if (frame?.id && frame.url) return scoped(`${frame.id}:url:${frame.url}`);
    } catch {
      // Older/minimal CDP transports may not expose Page.getFrameTree.
    }
    const info = fallbackUrl === undefined ? await this.pageInfo() : undefined;
    return scoped(`url:${fallbackUrl ?? info?.url ?? ""}`);
  }

  /** Resolve a backendDOMNodeId to its element's viewport-center coordinates, or
   *  null if the node no longer has a box (DOM changed → stale). */
  async centerOf(backendNodeId: number): Promise<{ x: number; y: number } | null> {
    try {
      await this.ensureEnabled();
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
      const { model } = (await this.send("DOM.getBoxModel", { backendNodeId })) as {
        model?: { content: number[] };
      };
      if (!model?.content || model.content.length < 8) return null;
      const viewport = await this.layoutViewportRect();
      const box = rectFromQuad(model.content);
      const visible = intersectRects(box, viewport);
      if (!visible) return null;
      return {
        x: visible.x + visible.width / 2,
        y: visible.y + visible.height / 2,
      };
    } catch {
      return null; // node detached / no box → treat as stale
    }
  }

  async clickNode(backendNodeId: number): Promise<CdpActionResult> {
    const c = await this.centerOf(backendNodeId);
    if (!c) {
      return { ok: false, detail: "element has no layout box", staleRef: true };
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

  async typeNode(backendNodeId: number, text: string): Promise<CdpActionResult> {
    try {
      await this.ensureEnabled();
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
      const { object } = (await this.send("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string };
      };
      if (!object?.objectId) {
        return { ok: false, detail: "text element not resolvable", staleRef: true };
      }

      // Match Playwright's `fill` semantics: focus without activating the
      // element, select its existing value, then insert the replacement text.
      // A mouse click here was both brittle (overlays/animation) and observable
      // by the page as an extra action before typing.
      const prepared = (await this.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: PREPARE_TEXT_INPUT_FN,
        returnByValue: true,
      })) as { result?: { value?: { ok?: boolean; detail?: string } } };
      const prep = prepared.result?.value;
      if (!prep?.ok) {
        return {
          ok: false,
          code: "BLOCKED",
          retryable: false,
          detail: prep?.detail ?? "element is not an editable text control",
        };
      }

      await this.send("Input.insertText", { text });
      return { ok: true, code: "OK" };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  /** Focus a node without activating it (so subsequent key events land there).
   *  Clicking here made pressKey(ref) activate buttons/links once before the
   *  requested key was even dispatched. DOM.focus is the native CDP operation
   *  for this job and avoids the accidental double action. */
  async focusNode(backendNodeId: number): Promise<CdpActionResult> {
    try {
      await this.ensureEnabled();
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
      await this.send("DOM.focus", { backendNodeId });
      return { ok: true, code: "OK" };
    } catch (e) {
      const detail = errMsg(e);
      const staleRef = /could not find|no node|not found|detached/i.test(detail);
      return {
        ok: false,
        code: staleRef ? "STALE_SNAPSHOT" : "FAILED",
        retryable: staleRef,
        staleRef: staleRef || undefined,
        detail,
      };
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
    const seq = planKeySequence(spec, this.options.keyboardPlatform);
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
      await this.ensureEnabled();
      const { object } = (await this.send("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string };
      };
      if (!object?.objectId)
        return { ok: false, detail: "select element not resolvable", staleRef: true };
      const res = (await this.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: SELECT_OPTION_FN,
        arguments: [{ value }],
        returnByValue: true,
      })) as { result?: { value?: { ok?: boolean; matched?: string; options?: string[] } } };
      const v = res.result?.value;
      if (v?.ok) return { ok: true, detail: v.matched ? `selected "${v.matched}"` : undefined };
      const opts = (v?.options ?? []).slice(0, 50).join(" / ");
      return {
        ok: false,
        detail: `no option matched "${value}". available: ${opts || "(none — not a native <select>?)"}`,
      };
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
      // Resolve the ref (img1/vid1…) tagged by the last extract via namespaced
      // attrs, fetch+canvas IN PAGE (page cookies → beats hotlink protection).
      const timeoutMs = positiveFinite(
        this.options.imageFetchTimeoutMs,
        DEFAULT_IMAGE_FETCH_TIMEOUT_MS,
      );
      const safeMaxDim = positiveFinite(maxDim, MAX_IMAGE_DIM);
      const res = (await this.send("Runtime.evaluate", {
        expression: `(${FETCH_IMAGE_BY_REF_FN})(${JSON.stringify(ref)}, ${safeMaxDim}, ${timeoutMs})`,
        returnByValue: true,
        awaitPromise: true,
      })) as {
        result?: { value?: { ok?: boolean; dataUrl?: string; detail?: string; missing?: boolean } };
      };
      const v = res.result?.value;
      if (v?.missing)
        return {
          ok: false,
          detail: `ref ${ref} not found — re-run browser_observe(extract)`,
          staleRef: true,
        };
      if (!v?.ok || !v.dataUrl)
        return { ok: false, detail: v?.detail ?? "could not read image pixels" };
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
      const safeMaxDim = positiveFinite(maxDim, MAX_IMAGE_DIM);
      if (backendNodeId === undefined && this.options.captureScreenshot) {
        return await this.options.captureScreenshot({ maxDim: safeMaxDim });
      }
      if (backendNodeId !== undefined) {
        await this.ensureEnabled();
        await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
      }
      const capture = await this.screenshotViewport();
      // Keep DOM boxes and the viewport in CSS pixels until the final CDP clip.
      let region = capture.region;
      if (backendNodeId !== undefined) {
        const { model } = (await this.send("DOM.getBoxModel", { backendNodeId })) as {
          model?: { content: number[] };
        };
        if (!model?.content || model.content.length < 8) {
          return { ok: false, detail: "element has no layout box", staleRef: true };
        }
        const box = rectFromQuad(model.content);
        const visible = intersectRects(box, capture.region);
        if (!visible)
          return { ok: false, detail: "element is outside the visible viewport after scrolling" };
        region = visible;
      }
      if (region.width < 1 || region.height < 1) {
        return { ok: false, detail: "capture region is empty" };
      }
      if (this.options.captureScreenshot) {
        return await this.options.captureScreenshot({ region, maxDim: safeMaxDim });
      }
      // CDP's clip uses device-independent pixels, while its output uses native
      // pixels. Electron's deprecated layoutViewport is already device-scaled:
      // passing it as a clip makes Retina captures twice as wide/high, leaving
      // the real page in the upper-left quarter. Include zoom and native scale
      // exactly once so the entire viewport fits the requested pixel budget.
      const dip = capture.cssToDipScale;
      const scale = Math.min(
        1,
        safeMaxDim / (Math.max(region.width, region.height) * dip * capture.deviceScale),
      );
      const shot = (await this.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        captureBeyondViewport: false,
        clip: {
          x: (region.x + capture.pageX) * dip,
          y: (region.y + capture.pageY) * dip,
          width: region.width * dip,
          height: region.height * dip,
          scale,
        },
      })) as { data?: string };
      if (!shot.data) return { ok: false, detail: "screenshot returned no data" };
      return { ok: true, base64: shot.data, mediaType: "image/jpeg" };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  private async screenshotViewport(): Promise<{
    region: { x: number; y: number; width: number; height: number };
    pageX: number;
    pageY: number;
    cssToDipScale: number;
    deviceScale: number;
  }> {
    type Viewport = {
      pageX?: number;
      pageY?: number;
      clientWidth?: number;
      clientHeight?: number;
    };
    const metrics = (await this.send("Page.getLayoutMetrics")) as {
      layoutViewport?: Viewport;
      cssLayoutViewport?: Viewport;
      visualViewport?: { zoom?: number };
      cssVisualViewport?: { zoom?: number };
    };
    const css = metrics.cssLayoutViewport;
    const viewport = css ?? metrics.layoutViewport;
    const cssToDipScale = css
      ? positiveFinite(metrics.cssVisualViewport?.zoom ?? metrics.visualViewport?.zoom, 1)
      : 1;
    const cssWidth = positiveFinite(css?.clientWidth, 0);
    const deviceWidth = positiveFinite(metrics.layoutViewport?.clientWidth, 0);
    const deviceScale =
      cssWidth > 0 && deviceWidth > 0 ? deviceWidth / cssWidth / cssToDipScale : 1;
    return {
      region: {
        x: 0,
        y: 0,
        width: positiveFinite(viewport?.clientWidth, 1280),
        height: positiveFinite(viewport?.clientHeight, 800),
      },
      pageX: finiteOr(viewport?.pageX, 0),
      pageY: finiteOr(viewport?.pageY, 0),
      cssToDipScale,
      deviceScale,
    };
  }

  private async layoutViewportRect(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    // DOM.getBoxModel and Input coordinates are viewport-relative CSS pixels,
    // even after scrolling. Deprecated layoutViewport uses physical pixels on
    // Electron, so its scroll origin must never be subtracted from a DOM box.
    return (await this.screenshotViewport()).region;
  }

  async navigate(url: string): Promise<CdpActionResult> {
    try {
      const validated = validateNavigationUrl(url, this.options.allowedNavigationSchemes);
      if (!validated.ok) return validated;
      if (this.options.canNavigate && !(await this.options.canNavigate(validated.parsed))) {
        return { ok: false, detail: "navigation blocked by host policy" };
      }
      await this.send("Page.navigate", { url: validated.url });
      this.enabled = false; // domains may need re-enabling after cross-doc nav
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  async readContent(options: CdpReadOptions = {}): Promise<CdpContentResult> {
    const info = await this.pageInfo();
    try {
      const res = (await this.send("Runtime.evaluate", {
        expression: READ_PAGE_STATE_EXPRESSION,
        returnByValue: true,
      })) as { result?: { value?: ReadPageState } };
      const state = normalizeReadPageState(res.result?.value);
      const documentId = await this.currentDocumentId(info.url);
      const normalized = normalizePageText(state.text);
      const contentHash = hashText(normalized);
      const parsedCursor = options.cursor ? parseReadCursor(options.cursor) : undefined;
      if (options.cursor && !parsedCursor) {
        return {
          ok: false,
          code: "STALE_CURSOR",
          url: info.url,
          title: info.title,
          documentId,
          text: "",
          scroll: state.scroll,
          contentHash,
          detail: "invalid read cursor — restart browser_observe(read) without a cursor",
        };
      }
      if (parsedCursor && parsedCursor.documentId !== documentId) {
        return {
          ok: false,
          code: "STALE_CURSOR",
          url: info.url,
          title: info.title,
          documentId,
          text: "",
          scroll: state.scroll,
          contentHash,
          detail: "read cursor belongs to a previous document",
        };
      }

      const offset = parsedCursor?.offset ?? 0;
      if (offset < 0 || offset > normalized.length) {
        return {
          ok: false,
          code: "STALE_CURSOR",
          url: info.url,
          title: info.title,
          documentId,
          text: "",
          scroll: state.scroll,
          contentHash,
          detail: "read cursor is outside the current document",
        };
      }
      const requested =
        typeof options.maxChars === "number" && Number.isFinite(options.maxChars)
          ? Math.floor(options.maxChars)
          : CONTENT_CHAR_CAP;
      const maxChars = Math.min(MAX_CONTENT_CHAR_CAP, Math.max(256, requested));
      const end = Math.min(normalized.length, offset + maxChars);
      const done = end >= normalized.length;
      const cursor = encodeReadCursor(documentId, offset);
      return {
        ok: true,
        code: "OK",
        url: info.url,
        title: info.title,
        documentId,
        text: normalized.slice(offset, end),
        cursor,
        nextCursor: done ? undefined : encodeReadCursor(documentId, end),
        done,
        contentHash,
        scroll: state.scroll,
        truncated: !done,
      };
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
          value?: {
            links?: CdpExtractResult["links"];
            images?: CdpExtractResult["images"];
            videos?: CdpExtractResult["videos"];
            truncated?: boolean;
          };
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
      return {
        ok: false,
        url: info.url,
        title: info.title,
        links: [],
        images: [],
        videos: [],
        detail: errMsg(e),
      };
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
    try {
      const before = await this.readProgressState();
      const beforePixels =
        before.scroll.positionKnown === false ? await this.visualSignature() : undefined;
      // Keep one action to at most one viewport. Huge deltas made progress
      // impossible to reason about and encouraged blind 20,000px loops.
      const requested =
        typeof amount === "number" && Number.isFinite(amount) && amount !== 0
          ? Math.abs(amount)
          : 600;
      const magnitude = Math.max(1, Math.min(requested, Math.max(1, before.scroll.viewportHeight)));
      const deltaY = (dir === "down" ? 1 : -1) * magnitude;
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: before.wheelPoint?.x ?? before.scroll.viewportWidth / 2,
        y: before.wheelPoint?.y ?? before.scroll.viewportHeight / 2,
        deltaX: 0,
        deltaY,
      });
      await delay(75);
      const after = await this.readProgressState();
      const documentChanged = before.documentId !== after.documentId;
      if (documentChanged) {
        return {
          ok: true,
          code: "NAVIGATION",
          documentId: after.documentId,
          documentChanged: true,
          scroll: after.scroll,
          contentChanged: before.contentSignature !== after.contentSignature,
        };
      }
      const afterPixels = beforePixels === undefined ? undefined : await this.visualSignature();
      const contentChanged =
        before.contentSignature !== after.contentSignature ||
        (beforePixels !== undefined && afterPixels !== undefined && beforePixels !== afterPixels);
      const moved =
        Math.abs(before.scroll.x - after.scroll.x) > 0.5 ||
        Math.abs(before.scroll.y - after.scroll.y) > 0.5;
      const extentChanged =
        before.scroll.maxX !== after.scroll.maxX || before.scroll.maxY !== after.scroll.maxY;
      if (!moved && !extentChanged && !contentChanged) {
        return {
          ok: false,
          code: "NO_PROGRESS",
          retryable: false,
          documentId: after.documentId,
          scroll: after.scroll,
          contentChanged: false,
          detail: after.scroll.atEnd
            ? "scroll made no progress: already at the end of the page"
            : "scroll made no progress",
        };
      }
      return {
        ok: true,
        code: "OK",
        documentId: after.documentId,
        documentChanged: false,
        scroll: after.scroll,
        contentChanged,
      };
    } catch (e) {
      return { ok: false, code: "FAILED", retryable: true, detail: errMsg(e) };
    }
  }

  private async readProgressState(): Promise<ProgressState> {
    const info = await this.pageInfo();
    const res = (await this.send("Runtime.evaluate", {
      expression: READ_PAGE_STATE_EXPRESSION,
      returnByValue: true,
    })) as { result?: { value?: Partial<ProgressPayload> } };
    const payload = normalizeProgressPayload(res.result?.value);
    return {
      documentId: await this.currentDocumentId(info.url),
      scroll: payload.scroll,
      wheelPoint: payload.wheelPoint,
      contentSignature:
        payload.contentSignature ??
        `${payload.textLength}:${payload.scroll.maxX}:${payload.scroll.maxY}`,
    };
  }

  private async visualSignature(): Promise<string | undefined> {
    const image = await this.screenshot();
    return image.ok && image.base64 ? hashText(image.base64) : undefined;
  }
}

interface ReadPageState {
  text: string;
  scroll: CdpScrollState;
}

interface ProgressPayload {
  scroll: CdpScrollState;
  textLength: number;
  wheelPoint?: { x: number; y: number };
  contentSignature?: string;
}

interface ProgressState {
  documentId: string;
  scroll: CdpScrollState;
  contentSignature: string;
  wheelPoint?: { x: number; y: number };
}

function emptyScrollState(): CdpScrollState {
  return {
    x: 0,
    y: 0,
    maxX: 0,
    maxY: 0,
    viewportWidth: 1280,
    viewportHeight: 800,
    atTop: true,
    atEnd: true,
  };
}

function normalizeScrollState(value: Partial<CdpScrollState> | undefined): CdpScrollState {
  const fallback = emptyScrollState();
  const x = Math.max(0, finiteOr(value?.x, fallback.x));
  const y = Math.max(0, finiteOr(value?.y, fallback.y));
  const maxX = Math.max(0, finiteOr(value?.maxX, fallback.maxX));
  const maxY = Math.max(0, finiteOr(value?.maxY, fallback.maxY));
  const viewportWidth = positiveFinite(value?.viewportWidth, fallback.viewportWidth);
  const viewportHeight = positiveFinite(value?.viewportHeight, fallback.viewportHeight);
  return {
    x,
    y,
    maxX,
    maxY,
    viewportWidth,
    viewportHeight,
    atTop: typeof value?.atTop === "boolean" ? value.atTop : y <= 1,
    atEnd: typeof value?.atEnd === "boolean" ? value.atEnd : y >= maxY - 1,
    ...(value?.target ? { target: value.target } : {}),
    ...(typeof value?.positionKnown === "boolean" ? { positionKnown: value.positionKnown } : {}),
  };
}

function normalizeReadPageState(value: Partial<ReadPageState> | undefined): ReadPageState {
  return {
    text: typeof value?.text === "string" ? value.text : "",
    scroll: normalizeScrollState(value?.scroll),
  };
}

function normalizeProgressPayload(value: Partial<ProgressPayload> | undefined): ProgressPayload {
  return {
    scroll: normalizeScrollState(value?.scroll),
    wheelPoint:
      value?.wheelPoint &&
      Number.isFinite(value.wheelPoint.x) &&
      Number.isFinite(value.wheelPoint.y)
        ? value.wheelPoint
        : undefined,
    contentSignature:
      typeof value?.contentSignature === "string" ? value.contentSignature : undefined,
    textLength:
      typeof value?.textLength === "number" && Number.isFinite(value.textLength)
        ? Math.max(0, Math.floor(value.textLength))
        : 0,
  };
}

export function normalizePageText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function encodeReadCursor(documentId: string, offset: number): string {
  return `${encodeURIComponent(documentId)}:${Math.max(0, Math.floor(offset))}`;
}

export function parseReadCursor(
  cursor: string,
): { documentId: string; offset: number } | undefined {
  const split = cursor.lastIndexOf(":");
  if (split <= 0) return undefined;
  const rawOffset = cursor.slice(split + 1);
  if (!/^\d+$/.test(rawOffset)) return undefined;
  try {
    const documentId = decodeURIComponent(cursor.slice(0, split));
    if (!documentId) return undefined;
    const offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
    return { documentId, offset };
  } catch {
    return undefined;
  }
}

/** Small deterministic FNV-1a hash; used only as a progress signature. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function rectFromQuad(quad: number[]): { x: number; y: number; width: number; height: number } {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function intersectRects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
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
const FETCH_IMAGE_BY_REF_FN = `async function(ref, maxDim, timeoutMs){
  maxDim = maxDim || 1568;
  timeoutMs = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : 15000;
  var REF_ATTR = 'data-codeshell-cdp-ref';
  var RUN_ATTR = 'data-codeshell-cdp-run';
  var run = window.__codeshellCdpExtractRun || '';
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  return await new Promise(function(resolve) {
    var done = false;
    function finish(value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    }
    var timer = setTimeout(function() {
      try { if (controller) controller.abort(); } catch (_) {}
      finish({ ok:false, detail:'image fetch timed out' });
    }, timeoutMs);
    (async function(){
      try {
    var candidates = document.querySelectorAll('[' + REF_ATTR + ']');
    var el = null;
    for (var i=0;i<candidates.length;i++){
      var candidate = candidates[i];
      if (candidate.getAttribute(REF_ATTR) === ref && (!run || candidate.getAttribute(RUN_ATTR) === run)) {
        el = candidate;
        break;
      }
    }
    if (!el) return finish({ ok:false, missing:true });
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
      var fetchOpts = { credentials: 'include' };
      if (controller) fetchOpts.signal = controller.signal;
      var resp = await fetch(el.currentSrc || el.src, fetchOpts);
      if (!resp.ok) return finish({ ok:false, detail: 'fetch ' + resp.status });
      var blob = await resp.blob();
      bmp = await createImageBitmap(blob);
      srcW = bmp.width; srcH = bmp.height;
    }
    if (!srcW || !srcH) return finish({ ok:false, detail: 'image has no dimensions' });
    var scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    var w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0, w, h);
    finish({ ok:true, dataUrl: c.toDataURL('image/jpeg', 0.85) });
  } catch (e) {
    finish({ ok:false, detail: (e && e.message) || String(e) });
  }
    })();
  });
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
    var REF_ATTR='data-codeshell-cdp-ref',RUN_ATTR='data-codeshell-cdp-run';
    var run='run-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    try{
      var old=document.querySelectorAll('['+REF_ATTR+'],['+RUN_ATTR+']');
      for(var oi=0;oi<old.length;oi++){old[oi].removeAttribute(REF_ATTR);old[oi].removeAttribute(RUN_ATTR);}
      window.__codeshellCdpExtractRun=run;
    }catch(e){}
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
      try{im.setAttribute(REF_ATTR,ref);im.setAttribute(RUN_ATTR,run);}catch(e){}
      var o={url:s,ref:ref};var alt=(im.getAttribute('alt')||'').trim();if(alt)o.alt=alt.slice(0,200);
      images.push(o);
    }
    function pushVid(s,ref){if(!s||s.indexOf('data:')===0||s.indexOf('blob:')===0)return;if(seenV[s])return;seenV[s]=1;if(videos.length>=cap){vt=true;return;}videos.push({url:s,ref:ref});}
    var vs=document.querySelectorAll('video'),vidN=0;
    for(var k=0;k<vs.length&&!vt;k++){
      var vd=vs[k];
      vidN++;var ref='vid'+vidN;try{vd.setAttribute(REF_ATTR,ref);vd.setAttribute(RUN_ATTR,run);}catch(e){}
      if(vd.currentSrc)pushVid(vd.currentSrc,ref);else if(vd.src)pushVid(vd.src,ref);
      var srcs=vd.querySelectorAll('source[src]');
      for(var m=0;m<srcs.length&&!vt;m++)pushVid(srcs[m].src,ref);
    }
    return {links:links,images:images,videos:videos,truncated:lt||it||vt};
  })()`;
}

/**
 * Prepare a text-like control for replacement input. This runs on the resolved
 * node so no selector lookup can drift to a different element between snapshot
 * and action. It deliberately focuses/selects without a synthetic mouse click.
 */
const PREPARE_TEXT_INPUT_FN = `function(){
  if (!this || typeof this.focus !== 'function') {
    return { ok:false, detail:'element cannot be focused' };
  }
  var tag = String(this.tagName || '').toUpperCase();
  var isInput = tag === 'INPUT';
  var isTextarea = tag === 'TEXTAREA';
  var isEditable = !!this.isContentEditable;
  if (!isInput && !isTextarea && !isEditable) {
    return { ok:false, detail:'element is not an editable text control' };
  }
  if (this.disabled) return { ok:false, detail:'text control is disabled' };
  if (this.readOnly) return { ok:false, detail:'text control is read-only' };
  if (isInput) {
    var type = String(this.type || 'text').toLowerCase();
    var unsupported = {
      button:1, checkbox:1, color:1, file:1, hidden:1, image:1,
      radio:1, range:1, reset:1, submit:1
    };
    if (unsupported[type]) {
      return { ok:false, detail:'input type ' + type + ' does not accept text' };
    }
  }
  this.focus();
  if (isInput || isTextarea) {
    try { this.select(); }
    catch (_) {
      // Some input types (notably number) reject select(). Clear them through
      // the value property so Input.insertText still has fill semantics.
      try { this.value = ''; } catch (_) {}
    }
  } else {
    var selection = window.getSelection && window.getSelection();
    if (!selection) return { ok:false, detail:'contenteditable selection is unavailable' };
    var range = document.createRange();
    range.selectNodeContents(this);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return { ok:true };
}`;

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
export function cleanPageText(
  raw: string,
  cap: number = CONTENT_CHAR_CAP,
): { text: string; truncated: boolean } {
  const normalized = normalizePageText(raw);
  if (normalized.length <= cap) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, cap) + "\n…(truncated)", truncated: true };
}
