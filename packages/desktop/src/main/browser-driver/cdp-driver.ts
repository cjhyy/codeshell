/**
 * CdpBrowserDriver — drives a single browser target over the Chrome DevTools
 * Protocol to implement core's BrowserBridge. Self-contained: depends only on a
 * `CdpSender` (send one CDP command, get the result) + core's pure helpers. It
 * knows NOTHING about Electron <webview>, React, or any UI — so the same module
 * can later drive a hidden BrowserWindow (unattended runs) or be extracted into
 * its own package. The Electron glue (webContents.debugger → CdpSender) lives in
 * a separate thin adapter (electron-cdp.ts).
 *
 * Spec: docs/superpowers/specs/2026-06-16-browser-automation-mvp.md §1–§3.
 *
 * observe: Accessibility.getFullAXTree → flattenAxTree (core, pure).
 * act: ref → backendDOMNodeId → DOM.getBoxModel center → Input.dispatchMouseEvent
 *      (real, isTrusted=true input — not synthetic JS events).
 */

import {
  flattenAxTree,
  type BrowserBridge,
  type BrowserSnapshot,
  type BrowserResult,
  type AXNode,
} from "@cjhyy/code-shell-core";

/** Send one CDP command, resolve its result. Throws on protocol error. */
export type CdpSender = (method: string, params?: Record<string, unknown>) => Promise<any>;

/** What the driver needs to know about the current page, supplied by the adapter
 *  (the adapter knows the webContents' URL/title; the driver stays UI-agnostic). */
export interface PageInfo {
  url: string;
  title?: string;
}

export class CdpBrowserDriver implements BrowserBridge {
  private enabled = false;
  /** ref (e1,e2,…) → backendDOMNodeId from the latest snapshot. Cleared each snapshot. */
  private refMap: Record<string, number> = {};

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

  async snapshot(): Promise<BrowserSnapshot> {
    await this.ensureEnabled();
    const info = await this.pageInfo();
    const { nodes } = (await this.send("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
    const { elements, refToBackendId } = flattenAxTree(nodes ?? []);
    this.refMap = refToBackendId;
    const needsHuman = detectLoginWall(info.url, elements);
    return { url: info.url, title: info.title, elements, ...(needsHuman ? { needsHuman } : {}) };
  }

  /** Resolve a ref to its element's viewport-center coordinates, or null if the
   *  ref is unknown / the node no longer has a box (DOM changed → stale). */
  private async centerOf(ref: string): Promise<{ x: number; y: number } | null> {
    const backendNodeId = this.refMap[ref];
    if (backendNodeId === undefined) return null;
    try {
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
      const { model } = (await this.send("DOM.getBoxModel", { backendNodeId })) as {
        model?: { content: number[] };
      };
      if (!model?.content || model.content.length < 8) return null;
      // content quad: [x1,y1, x2,y2, x3,y3, x4,y4] → center
      const xs = [model.content[0]!, model.content[2]!, model.content[4]!, model.content[6]!];
      const ys = [model.content[1]!, model.content[3]!, model.content[5]!, model.content[7]!];
      return { x: avg(xs), y: avg(ys) };
    } catch {
      return null; // node detached / no box → treat as stale
    }
  }

  async click(ref: string): Promise<BrowserResult> {
    const c = await this.centerOf(ref);
    if (!c) return staleOrUnknown(ref, this.refMap);
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

  async type(ref: string, text: string): Promise<BrowserResult> {
    const c = await this.centerOf(ref);
    if (!c) return staleOrUnknown(ref, this.refMap);
    try {
      // focus by clicking, then insert real text
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
      await this.send("Input.insertText", { text });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  async navigate(url: string): Promise<BrowserResult> {
    try {
      await this.send("Page.navigate", { url });
      // A navigation invalidates every ref from the previous page.
      this.refMap = {};
      this.enabled = false; // domains may need re-enabling after cross-doc nav
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: errMsg(e) };
    }
  }

  async scroll(dir: "up" | "down", amount?: number): Promise<BrowserResult> {
    const deltaY = (dir === "down" ? 1 : -1) * (amount ?? 600);
    try {
      // wheel at viewport origin; coordinates 0,0 are fine for page scroll
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A ref we never had → unknown; a ref we had but lost its box → stale. Both ask
 *  the agent to re-snapshot, but distinguish for clearer messaging. */
function staleOrUnknown(ref: string, refMap: Record<string, number>): BrowserResult {
  return refMap[ref] === undefined
    ? { ok: false, detail: `unknown ref ${ref}`, staleRef: true }
    : { ok: false, detail: `ref ${ref} no longer has a layout box`, staleRef: true };
}

/** Heuristic: a page that is essentially a login form (password field present,
 *  few elements) likely needs the human to sign in. Conservative — only fires
 *  when a sensitive (password) field is present. */
function detectLoginWall(_url: string, elements: BrowserSnapshot["elements"]): string | undefined {
  const hasPassword = elements.some((e) => e.sensitive);
  return hasPassword ? "this page requires sign-in" : undefined;
}
