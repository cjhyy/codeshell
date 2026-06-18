/**
 * CdpBrowserDriver — desktop GLUE between core's BrowserBridge contract and the
 * environment-agnostic CDP action layer (@cjhyy/code-shell-cdp).
 *
 * The actual CDP command sequences live in the package's CdpActionsDriver. This
 * glue owns the two things that carry product/security policy and therefore stay
 * out of the transport package:
 *   1. a11y flattening — turn the package's RAW AX nodes into core's ref-tagged
 *      BrowserElement[] via core's flattenAxTree (which roles count, sensitive
 *      masking, ref assignment).
 *   2. the ref→backendDOMNodeId map — held here so click/type (separate worker
 *      calls) resolve a ref from the latest snapshot. The package is
 *      ref-stateless (its action methods take a backendNodeId directly).
 *
 * Spec: docs/superpowers/specs/2026-06-18-browser-module-redesign-design.md §4.2.
 */

import {
  CdpActionsDriver,
  type CdpSender as PkgCdpSender,
  type PageInfo,
} from "@cjhyy/code-shell-cdp";
import {
  flattenAxTree,
  type BrowserBridge,
  type BrowserSnapshot,
  type BrowserResult,
  type BrowserContent,
  type BrowserExtract,
  type BrowserImageData,
  type AXNode,
} from "@cjhyy/code-shell-core";

/** Send one CDP command, resolve its result. Throws on protocol error.
 *  (Structurally the package's CdpSender; re-exported for the Electron adapter.) */
export type CdpSender = PkgCdpSender;
export type { PageInfo };

export class CdpBrowserDriver implements BrowserBridge {
  private readonly inner: CdpActionsDriver;
  /** ref (e1,e2,…) → backendDOMNodeId from the latest snapshot. Cleared each snapshot. */
  private refMap: Record<string, number> = {};

  constructor(send: CdpSender, pageInfo: () => Promise<PageInfo> | PageInfo) {
    this.inner = new CdpActionsDriver(send, pageInfo);
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const raw = await this.inner.snapshot();
    const { elements, refToBackendId } = flattenAxTree((raw.nodes ?? []) as AXNode[]);
    this.refMap = refToBackendId;
    const needsHuman = detectLoginWall(raw.url, elements);
    return { url: raw.url, title: raw.title, elements, ...(needsHuman ? { needsHuman } : {}) };
  }

  /** Resolve a ref to its backendDOMNodeId; undefined if unknown (caller re-snapshots). */
  private backendId(ref: string): number | undefined {
    return this.refMap[ref];
  }

  async click(ref: string): Promise<BrowserResult> {
    const id = this.backendId(ref);
    if (id === undefined) return unknownRef(ref);
    return this.inner.clickNode(id);
  }

  async type(ref: string, text: string): Promise<BrowserResult> {
    const id = this.backendId(ref);
    if (id === undefined) return unknownRef(ref);
    return this.inner.typeNode(id, text);
  }

  async navigate(url: string): Promise<BrowserResult> {
    const r = await this.inner.navigate(url);
    // A navigation invalidates every ref from the previous page.
    this.refMap = {};
    return r;
  }

  readContent(): Promise<BrowserContent> {
    return this.inner.readContent();
  }

  extractLinks(): Promise<BrowserExtract> {
    return this.inner.extractLinks();
  }

  waitForLoad(timeoutMs?: number): Promise<BrowserResult> {
    return this.inner.waitForLoad(timeoutMs);
  }

  async hover(ref: string): Promise<BrowserResult> {
    const id = this.backendId(ref);
    if (id === undefined) return unknownRef(ref);
    return this.inner.hoverNode(id);
  }

  async selectOption(ref: string, value: string): Promise<BrowserResult> {
    const id = this.backendId(ref);
    if (id === undefined) return unknownRef(ref);
    return this.inner.selectOptionNode(id, value);
  }

  async pressKey(key: string, ref?: string): Promise<BrowserResult> {
    // Focus the ref first (so the key lands on the right field), then dispatch.
    if (ref) {
      const id = this.backendId(ref);
      if (id === undefined) return unknownRef(ref);
      const focused = await this.inner.focusNode(id);
      if (!focused.ok) return focused;
    }
    return this.inner.pressKey(key);
  }

  scroll(dir: "up" | "down", amount?: number): Promise<BrowserResult> {
    return this.inner.scroll(dir, amount);
  }

  async fetchImages(refs: string[]): Promise<BrowserImageData[]> {
    // image refs (img1/vid1…) come from the last extract's data-cs-ref tags, not
    // the a11y refMap — the package resolves them in-page by that attribute.
    const out: BrowserImageData[] = [];
    for (const ref of refs) {
      const r = await this.inner.fetchImageData(ref);
      out.push({ ok: r.ok, base64: r.base64, mediaType: r.mediaType, ref: r.ref ?? ref, detail: r.detail });
    }
    return out;
  }

  // Tab management is panel-global (handled in automation-host via the guest
  // registry, NOT a per-guest driver). These satisfy BrowserBridge but are never
  // invoked on the driver — the host intercepts listTabs/switchTab first.
  async listTabs(): Promise<import("@cjhyy/code-shell-core").BrowserTab[]> {
    return [];
  }

  async switchTab(_tabId: string): Promise<BrowserResult> {
    return { ok: false, detail: "switchTab is handled at the panel level, not the driver" };
  }

  async screenshot(ref?: string): Promise<BrowserImageData> {
    // vision ref is an a11y element ref (eN) → resolve to backendNodeId for a
    // region capture; no ref → viewport screenshot.
    let backendId: number | undefined;
    if (ref) {
      backendId = this.backendId(ref);
      if (backendId === undefined) return { ok: false, detail: `unknown ref ${ref}` };
    }
    const r = await this.inner.screenshot(backendId);
    return { ok: r.ok, base64: r.base64, mediaType: r.mediaType, detail: r.detail };
  }
}

/** A ref we never had → unknown; ask the agent to re-snapshot. */
function unknownRef(ref: string): BrowserResult {
  return { ok: false, detail: `unknown ref ${ref}`, staleRef: true };
}

/** Heuristic: a page that is essentially a login form (password field present)
 *  likely needs the human to sign in. Conservative — only fires on a sensitive
 *  (password) field. */
function detectLoginWall(_url: string, elements: BrowserSnapshot["elements"]): string | undefined {
  const hasPassword = elements.some((e) => e.sensitive);
  return hasPassword ? "this page requires sign-in" : undefined;
}
