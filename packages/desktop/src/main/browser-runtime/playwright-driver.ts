import {
  EXTRACT_LINK_CAP,
  type BrowserBridge,
  type BrowserContent,
  type BrowserElement,
  type BrowserExtract,
  type BrowserImageData,
  type BrowserReadOptions,
  type BrowserResult,
  type BrowserScrollState,
  type BrowserSnapshot,
  type BrowserTab,
} from "@cjhyy/code-shell-core";
import {
  CONTENT_CHAR_CAP,
  MAX_CONTENT_CHAR_CAP,
  encodeReadCursor,
  hashText,
  normalizePageText,
  parseReadCursor,
} from "@cjhyy/code-shell-cdp";
import type { BrowserContext, Frame, Locator, Page } from "playwright-core";

const MAX_SNAPSHOT_ELEMENTS = 250;
const DEFAULT_ACTION_TIMEOUT_MS = 12_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const MEDIA_REF_ATTR = "data-codeshell-runtime-media-ref";

interface PageState {
  id: string;
  generation: number;
}

interface ElementCandidate {
  cssPath: string;
  role: string;
  name: string;
  value?: string;
  sensitive?: boolean;
}

interface RefRecord {
  documentId: string;
  locator: Locator;
}

interface PageTextState {
  text: string;
  scroll: BrowserScrollState;
  signature: string;
}

/**
 * BrowserBridge implemented with Playwright's Page/Locator model.
 *
 * CDP is still the underlying Chromium transport, but action correctness is no
 * longer hand-written: Locator supplies strict resolution, auto-waiting and the
 * actionability checks for visibility, stability, hit targeting and editability.
 */
export class PlaywrightBrowserDriver implements BrowserBridge {
  private readonly pageStates = new Map<Page, PageState>();
  private activePage: Page;
  private nextPageId = 1;
  private snapshotCounter = 0;
  private refs = new Map<string, RefRecord>();

  constructor(
    private readonly context: BrowserContext,
    initialPage: Page,
  ) {
    this.activePage = initialPage;
    for (const page of context.pages()) this.trackPage(page);
    this.trackPage(initialPage);
    context.on("page", (page) => {
      this.trackPage(page);
      // A popup/new tab created by the last action becomes the automation
      // target. The old tab remains available through listTabs/switchTab.
      this.activePage = page;
      this.refs.clear();
    });
  }

  currentPageInfo(): { url: string; title?: string; documentId: string } {
    const page = this.page();
    return {
      url: page.url(),
      documentId: this.documentId(page),
    };
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const page = this.page();
    const documentId = this.documentId(page);
    const candidates = await collectInteractiveCandidates(page, MAX_SNAPSHOT_ELEMENTS);
    const semanticCounts = new Map<string, number>();
    for (const candidate of candidates) {
      const key = semanticLocatorKey(candidate);
      semanticCounts.set(key, (semanticCounts.get(key) ?? 0) + 1);
    }

    this.snapshotCounter += 1;
    const snapshotId = `pw${this.snapshotCounter}`;
    const elements: BrowserElement[] = [];
    const nextRefs = new Map<string, RefRecord>();
    candidates.forEach((candidate, index) => {
      const ref = `${snapshotId}:e${index + 1}`;
      const locator =
        candidate.name && semanticCounts.get(semanticLocatorKey(candidate)) === 1
          ? page.getByRole(
              candidate.role as Parameters<Page["getByRole"]>[0],
              { name: candidate.name, exact: true },
            )
          : page.locator(candidate.cssPath);
      elements.push({
        ref,
        role: candidate.role,
        name: candidate.name,
        sensitive: candidate.sensitive,
        value: candidate.sensitive ? undefined : candidate.value,
      });
      nextRefs.set(ref, { documentId, locator });
    });
    this.refs = nextRefs;

    const title = await safeTitle(page);
    return {
      url: page.url(),
      title,
      documentId,
      snapshotId,
      elements,
      ...(elements.some((element) => element.sensitive)
        ? { needsHuman: "this page requires sign-in or another sensitive input" }
        : {}),
    };
  }

  click(ref: string): Promise<BrowserResult> {
    return this.actOnRef(ref, (locator) => locator.click({ timeout: DEFAULT_ACTION_TIMEOUT_MS }));
  }

  type(ref: string, text: string): Promise<BrowserResult> {
    return this.actOnRef(ref, (locator) =>
      locator.fill(text, { timeout: DEFAULT_ACTION_TIMEOUT_MS }),
    );
  }

  async navigate(url: string): Promise<BrowserResult> {
    const page = this.page();
    const before = this.documentId(page);
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
      });
      this.refs.clear();
      const documentId = this.documentId(this.page());
      return {
        ok: true,
        code: documentId === before ? "OK" : "NAVIGATION",
        documentId,
        documentChanged: documentId !== before,
      };
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  async scroll(dir: "up" | "down", amount?: number): Promise<BrowserResult> {
    const page = this.page();
    const beforeDocument = this.documentId(page);
    try {
      const result = await page.evaluate(
        async ({ direction, requested }) => {
          const read = () => {
            const root = document.scrollingElement ?? document.documentElement;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const maxX = Math.max(0, root.scrollWidth - viewportWidth);
            const maxY = Math.max(0, root.scrollHeight - viewportHeight);
            const x = window.scrollX;
            const y = window.scrollY;
            const text = document.body?.innerText ?? "";
            return {
              x,
              y,
              maxX,
              maxY,
              viewportWidth,
              viewportHeight,
              atTop: y <= 1,
              atEnd: y >= maxY - 1,
              signature: `${root.scrollHeight}:${text.length}:${text.slice(-256)}`,
            };
          };
          const before = read();
          const fallback = Math.max(1, Math.floor(before.viewportHeight * 0.8));
          const magnitude = Math.min(
            before.viewportHeight,
            Math.max(1, Number.isFinite(requested) ? Math.abs(requested) : fallback),
          );
          window.scrollBy({ top: direction === "down" ? magnitude : -magnitude, behavior: "instant" });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const after = read();
          return { before, after };
        },
        { direction: dir, requested: amount ?? Number.NaN },
      );
      const documentId = this.documentId(this.page());
      if (documentId !== beforeDocument) {
        this.refs.clear();
        return {
          ok: false,
          code: "NAVIGATION",
          retryable: true,
          documentId,
          documentChanged: true,
          detail: "the page navigated while scrolling; observe the new document",
        };
      }
      const scroll = stripScrollSignature(result.after);
      const moved =
        Math.round(result.before.x) !== Math.round(result.after.x) ||
        Math.round(result.before.y) !== Math.round(result.after.y);
      const contentChanged = result.before.signature !== result.after.signature;
      if (!moved && !contentChanged) {
        return {
          ok: false,
          code: "NO_PROGRESS",
          retryable: false,
          documentId,
          scroll,
          contentChanged: false,
          detail: scroll.atEnd
            ? "already at the end of the page"
            : "scroll produced no observable progress",
        };
      }
      return {
        ok: true,
        code: "OK",
        documentId,
        scroll,
        contentChanged,
      };
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  async readContent(options: BrowserReadOptions = {}): Promise<BrowserContent> {
    const page = this.page();
    const url = page.url();
    const title = await safeTitle(page);
    const documentId = this.documentId(page);
    try {
      const state = await readPageTextState(page);
      const normalized = normalizePageText(state.text);
      const contentHash = hashText(normalized);
      const parsed = options.cursor ? parseReadCursor(options.cursor) : undefined;
      if (options.cursor && !parsed) {
        return staleCursor(url, title, documentId, state.scroll, contentHash, "invalid read cursor");
      }
      if (parsed && parsed.documentId !== documentId) {
        return staleCursor(
          url,
          title,
          documentId,
          state.scroll,
          contentHash,
          "read cursor belongs to a previous document",
        );
      }
      const offset = parsed?.offset ?? 0;
      if (offset < 0 || offset > normalized.length) {
        return staleCursor(
          url,
          title,
          documentId,
          state.scroll,
          contentHash,
          "read cursor is outside the current document",
        );
      }
      const requested =
        typeof options.maxChars === "number" && Number.isFinite(options.maxChars)
          ? Math.floor(options.maxChars)
          : CONTENT_CHAR_CAP;
      const maxChars = Math.min(MAX_CONTENT_CHAR_CAP, Math.max(256, requested));
      const end = Math.min(normalized.length, offset + maxChars);
      const done = end >= normalized.length;
      return {
        ok: true,
        code: "OK",
        url,
        title,
        documentId,
        text: normalized.slice(offset, end),
        cursor: encodeReadCursor(documentId, offset),
        nextCursor: done ? undefined : encodeReadCursor(documentId, end),
        done,
        contentHash,
        scroll: state.scroll,
        truncated: !done,
      };
    } catch (error) {
      return { ok: false, code: "FAILED", url, title, documentId, text: "", detail: errMsg(error) };
    }
  }

  async extractLinks(): Promise<BrowserExtract> {
    const page = this.page();
    try {
      const extracted = await page.evaluate(
        ({ cap, mediaRefAttr }) => {
          const links: Array<{ text: string; url: string }> = [];
          const images: Array<{ url: string; alt?: string; ref?: string }> = [];
          const videos: Array<{ url: string }> = [];
          const seenLinks = new Set<string>();
          const seenImages = new Set<string>();
          const seenVideos = new Set<string>();
          let truncated = false;
          for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
            const url = anchor.href;
            if (!url || url.startsWith("javascript:") || seenLinks.has(url)) continue;
            seenLinks.add(url);
            if (links.length >= cap) {
              truncated = true;
              break;
            }
            links.push({ text: (anchor.textContent ?? "").trim().slice(0, 200), url });
          }
          let imageIndex = 0;
          for (const image of Array.from(document.querySelectorAll<HTMLImageElement>("img[src]"))) {
            const url = image.currentSrc || image.src;
            if (!url || url.startsWith("data:") || seenImages.has(url)) continue;
            seenImages.add(url);
            if (images.length >= cap) {
              truncated = true;
              break;
            }
            imageIndex += 1;
            const ref = `img${imageIndex}`;
            image.setAttribute(mediaRefAttr, ref);
            const alt = (image.alt || "").trim().slice(0, 200);
            images.push({ url, ...(alt ? { alt } : {}), ref });
          }
          let videoIndex = 0;
          for (const media of Array.from(document.querySelectorAll<HTMLMediaElement>("video,video source"))) {
            const url = media.currentSrc || media.src;
            if (!url || seenVideos.has(url)) continue;
            seenVideos.add(url);
            if (videos.length >= cap) {
              truncated = true;
              break;
            }
            videoIndex += 1;
            media.setAttribute(mediaRefAttr, `vid${videoIndex}`);
            videos.push({ url });
          }
          return { links, images, videos, truncated };
        },
        { cap: EXTRACT_LINK_CAP, mediaRefAttr: MEDIA_REF_ATTR },
      );
      return {
        ok: true,
        url: page.url(),
        title: await safeTitle(page),
        ...extracted,
      };
    } catch (error) {
      return {
        ok: false,
        url: page.url(),
        title: await safeTitle(page),
        links: [],
        images: [],
        videos: [],
        detail: errMsg(error),
      };
    }
  }

  async waitForLoad(timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS): Promise<BrowserResult> {
    try {
      await this.page().waitForLoadState("load", { timeout: timeoutMs });
      return { ok: true, code: "OK", documentId: this.documentId(this.page()) };
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  hover(ref: string): Promise<BrowserResult> {
    return this.actOnRef(ref, (locator) => locator.hover({ timeout: DEFAULT_ACTION_TIMEOUT_MS }));
  }

  async selectOption(ref: string, value: string): Promise<BrowserResult> {
    const record = this.resolveRef(ref);
    if (!record.ok) return record.result;
    try {
      const options = await record.locator.locator("option").evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: (node as HTMLOptionElement).value,
          text: (node.textContent ?? "").trim(),
        })),
      );
      const match = options.find((option) => option.value === value || option.text === value);
      if (!match) {
        return {
          ok: false,
          code: "FAILED",
          detail: `no option matched "${value}". available: ${options
            .slice(0, 50)
            .map((option) => option.text || option.value)
            .join(" / ")}`,
        };
      }
      await record.locator.selectOption(match.value, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      return this.successAfterAction(record.documentId, `selected "${match.text || match.value}"`);
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  async pressKey(key: string, ref?: string): Promise<BrowserResult> {
    const before = this.documentId(this.page());
    try {
      if (ref) {
        const record = this.resolveRef(ref);
        if (!record.ok) return record.result;
        await record.locator.press(key, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      } else {
        await this.page().keyboard.press(key);
      }
      return this.successAfterAction(before);
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  async fetchImages(refs: string[]): Promise<BrowserImageData[]> {
    const page = this.page();
    return Promise.all(
      refs.map(async (ref) => {
        try {
          const locator = page.locator(`[${MEDIA_REF_ATTR}=${JSON.stringify(ref)}]`);
          if ((await locator.count()) !== 1) {
            return { ok: false, ref, detail: `ref ${ref} not found — re-run browser_observe(extract)` };
          }
          const bytes = await locator.screenshot({ type: "png", timeout: DEFAULT_ACTION_TIMEOUT_MS });
          return { ok: true, ref, base64: bytes.toString("base64"), mediaType: "image/png" };
        } catch (error) {
          return { ok: false, ref, detail: errMsg(error) };
        }
      }),
    );
  }

  async screenshot(ref?: string): Promise<BrowserImageData> {
    try {
      const bytes = ref
        ? await this.screenshotRef(ref)
        : await this.page().screenshot({ type: "jpeg", quality: 80 });
      return { ok: true, base64: bytes.toString("base64"), mediaType: ref ? "image/png" : "image/jpeg" };
    } catch (error) {
      return { ok: false, detail: errMsg(error) };
    }
  }

  async listTabs(): Promise<BrowserTab[]> {
    const active = this.page();
    return Promise.all(
      this.context
        .pages()
        .filter((page) => !page.isClosed())
        .map(async (page) => ({
          tabId: this.trackPage(page).id,
          url: page.url(),
          title: (await safeTitle(page)) ?? "",
          active: page === active,
        })),
    );
  }

  async switchTab(tabId: string): Promise<BrowserResult> {
    const page = this.context.pages().find((candidate) => this.trackPage(candidate).id === tabId);
    if (!page || page.isClosed()) return { ok: false, code: "FAILED", detail: `tab ${tabId} not found` };
    this.activePage = page;
    this.refs.clear();
    await page.bringToFront();
    return { ok: true, code: "OK", documentId: this.documentId(page) };
  }

  private async screenshotRef(ref: string): Promise<Buffer> {
    const record = this.resolveRef(ref);
    if (!record.ok) throw new Error(record.result.detail);
    return record.locator.screenshot({ type: "png", timeout: DEFAULT_ACTION_TIMEOUT_MS });
  }

  private async actOnRef(
    ref: string,
    action: (locator: Locator) => Promise<unknown>,
  ): Promise<BrowserResult> {
    const record = this.resolveRef(ref);
    if (!record.ok) return record.result;
    try {
      await action(record.locator);
      return this.successAfterAction(record.documentId);
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  private successAfterAction(beforeDocumentId: string, detail?: string): BrowserResult {
    const documentId = this.documentId(this.page());
    const documentChanged = documentId !== beforeDocumentId;
    if (documentChanged) this.refs.clear();
    return {
      ok: true,
      code: documentChanged ? "NAVIGATION" : "OK",
      documentId,
      documentChanged,
      detail,
    };
  }

  private resolveRef(
    ref: string,
  ): { ok: true; locator: Locator; documentId: string } | { ok: false; result: BrowserResult } {
    const record = this.refs.get(ref);
    const current = this.documentId(this.page());
    if (!record || record.documentId !== current) {
      if (record) this.refs.delete(ref);
      return {
        ok: false,
        result: {
          ok: false,
          code: "STALE_SNAPSHOT",
          retryable: true,
          staleRef: true,
          documentId: current,
          detail: `unknown ref ${ref} or stale snapshot`,
        },
      };
    }
    return { ok: true, locator: record.locator, documentId: record.documentId };
  }

  private page(): Page {
    if (!this.activePage.isClosed()) return this.activePage;
    const next = this.context.pages().find((page) => !page.isClosed());
    if (!next) throw new Error("Playwright Browser Runtime has no open page");
    this.activePage = next;
    this.refs.clear();
    return next;
  }

  private trackPage(page: Page): PageState {
    const known = this.pageStates.get(page);
    if (known) return known;
    const state = { id: `p${this.nextPageId++}`, generation: 1 };
    this.pageStates.set(page, state);
    page.on("framenavigated", (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      state.generation += 1;
      if (page === this.activePage) this.refs.clear();
    });
    page.on("close", () => {
      if (page === this.activePage) this.refs.clear();
    });
    return state;
  }

  private documentId(page: Page): string {
    const state = this.trackPage(page);
    return `${state.id}:document:${state.generation}`;
  }
}

async function collectInteractiveCandidates(page: Page, cap: number): Promise<ElementCandidate[]> {
  return page.locator(INTERACTIVE_SELECTOR).evaluateAll(
    (nodes, max) => {
      const implicitRole = (element: Element): string => {
        const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button" || tag === "summary") return "button";
        if (tag === "textarea") return "textbox";
        if (tag === "select") return element.hasAttribute("multiple") ? "listbox" : "combobox";
        if (tag === "input") {
          const type = (element.getAttribute("type") || "text").toLowerCase();
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "search") return "searchbox";
          return "textbox";
        }
        return element.getAttribute("contenteditable") === "true" ? "textbox" : "button";
      };
      const clean = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      const accessibleName = (element: Element): string => {
        const aria = clean(element.getAttribute("aria-label"));
        if (aria) return aria;
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = clean(
            labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" "),
          );
          if (text) return text;
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          const label = clean(
            (element.labels ? Array.from(element.labels).map((item) => item.textContent ?? "").join(" ") : ""),
          );
          if (label) return label;
          const placeholder = clean(element.getAttribute("placeholder"));
          if (placeholder) return placeholder;
        }
        if (element instanceof HTMLImageElement) {
          const alt = clean(element.alt);
          if (alt) return alt;
        }
        return clean(
          element.getAttribute("title") ||
            (element as HTMLElement).innerText ||
            element.textContent ||
            (element as HTMLInputElement).value,
        );
      };
      const cssPath = (element: Element): string => {
        const id = element.getAttribute("id");
        if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
          return `#${CSS.escape(id)}`;
        }
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.documentElement) {
          const tag = current.tagName.toLowerCase();
          const parent: Element | null = current.parentElement;
          if (!parent) break;
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
          const index = siblings.indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
          current = parent;
        }
        return `html > ${parts.join(" > ")}`;
      };
      const visible = (element: Element): boolean => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const output: ElementCandidate[] = [];
      for (const node of nodes) {
        if (output.length >= max || !visible(node)) continue;
        const input = node instanceof HTMLInputElement ? node : undefined;
        const autocomplete = clean(node.getAttribute("autocomplete")).toLowerCase();
        const sensitive =
          input?.type === "password" ||
          ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"].includes(autocomplete);
        const value =
          node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
            ? clean(node.value)
            : undefined;
        output.push({
          cssPath: cssPath(node),
          role: implicitRole(node),
          name: accessibleName(node),
          ...(value ? { value } : {}),
          ...(sensitive ? { sensitive: true } : {}),
        });
      }
      return output;
    },
    cap,
  );
}

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "summary",
  "[contenteditable=true]",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=searchbox]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=combobox]",
  "[role=listbox]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=tab]",
].join(",");

function semanticLocatorKey(candidate: ElementCandidate): string {
  return `${candidate.role}\u0000${candidate.name}`;
}

async function readPageTextState(page: Page): Promise<PageTextState> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxX = Math.max(0, root.scrollWidth - viewportWidth);
    const maxY = Math.max(0, root.scrollHeight - viewportHeight);
    const x = window.scrollX;
    const y = window.scrollY;
    const text = document.body?.innerText ?? "";
    return {
      text,
      signature: `${root.scrollHeight}:${text.length}:${text.slice(-256)}`,
      scroll: {
        x,
        y,
        maxX,
        maxY,
        viewportWidth,
        viewportHeight,
        atTop: y <= 1,
        atEnd: y >= maxY - 1,
      },
    };
  });
}

function stripScrollSignature(
  state: BrowserScrollState & { signature: string },
): BrowserScrollState {
  const { signature: _signature, ...scroll } = state;
  return scroll;
}

function staleCursor(
  url: string,
  title: string | undefined,
  documentId: string,
  scroll: BrowserScrollState,
  contentHash: string,
  detail: string,
): BrowserContent {
  return {
    ok: false,
    code: "STALE_CURSOR",
    url,
    title,
    documentId,
    text: "",
    scroll,
    contentHash,
    detail: `${detail} — restart browser_observe(read) without a cursor`,
  };
}

function playwrightFailure(error: unknown): BrowserResult {
  const detail = errMsg(error);
  const stale = /strict mode|not attached|detached|resolved to \d+ elements/i.test(detail);
  return {
    ok: false,
    code: stale ? "STALE_SNAPSHOT" : "FAILED",
    retryable: stale || /timeout/i.test(detail),
    staleRef: stale || undefined,
    detail,
  };
}

async function safeTitle(page: Page): Promise<string | undefined> {
  try {
    return await page.title();
  } catch {
    return undefined;
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
