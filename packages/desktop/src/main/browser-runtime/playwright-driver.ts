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
  type BrowserInspectOptions,
  type BrowserInspectResult,
} from "@cjhyy/code-shell-core";
import {
  READ_PAGE_STATE_EXPRESSION,
  CONTENT_CHAR_CAP,
  MAX_CONTENT_CHAR_CAP,
  encodeReadCursor,
  hashText,
  normalizePageText,
  parseReadCursor,
} from "@cjhyy/code-shell-cdp";
import type { BrowserContext, ElementHandle, Page } from "playwright-core";
import { collectPageNodes, readFrameText } from "../../browser-library/dom-observation.js";
import { observeScrollProgress } from "../../browser-library/scroll-observation.js";
import {
  createPlaywrightInspector,
  type BrowserInspector,
} from "../../browser-library/browser-inspector.js";

const MAX_SNAPSHOT_ELEMENTS = 250;
const DEFAULT_ACTION_TIMEOUT_MS = 12_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
let nextDriverId = 0;

interface PageState {
  id: string;
  generation: number;
}

interface RefRecord {
  documentId: string;
  handle: ElementHandle<Element>;
}

interface PageTextState {
  text: string;
  scroll: BrowserScrollState;
  signature: string;
  wheelPoint?: { x: number; y: number };
}

/**
 * BrowserBridge implemented with Playwright's Page/ElementHandle model.
 *
 * CDP is still the underlying Chromium transport, but action correctness is no
 * longer hand-written: Playwright supplies actionability, geometry and input.
 * Refs retain exact ElementHandles so a same-name DOM replacement cannot receive
 * an action intended for an earlier observation.
 */
export class PlaywrightBrowserDriver implements BrowserBridge {
  private readonly driverId = ++nextDriverId;
  private readonly pageStates = new Map<Page, PageState>();
  private activePage: Page;
  private nextPageId = 1;
  private snapshotCounter = 0;
  private refs = new Map<string, RefRecord>();
  private readonly inspectors = new Map<Page, BrowserInspector>();

  inspect(options: BrowserInspectOptions): Promise<BrowserInspectResult> {
    const page = this.page();
    let inspector = this.inspectors.get(page);
    if (!inspector) {
      inspector = createPlaywrightInspector(page);
      this.inspectors.set(page, inspector);
      page.once("close", () => {
        inspector!.dispose();
        this.inspectors.delete(page);
      });
    }
    return inspector.inspect(options);
  }

  async resumeControl(): Promise<BrowserResult> {
    this.clearRefs();
    return { ok: true, code: "OK" };
  }

  dispose(): void {
    this.clearRefs();
    for (const inspector of this.inspectors.values()) inspector.dispose();
    this.inspectors.clear();
  }

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
      this.clearRefs();
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
    this.clearRefs();
    const snapshotId = `pw${this.driverId}:s${++this.snapshotCounter}`;
    const candidates = await this.collect("interactive", MAX_SNAPSHOT_ELEMENTS, snapshotId);
    const elements: BrowserElement[] = candidates.map(({ ref, metadata }) => ({
      ref,
      role: metadata.role,
      name: metadata.name,
      sensitive: metadata.sensitive,
      value: metadata.value,
    }));

    const title = await safeTitle(page);
    if (this.documentId(this.page()) !== documentId) {
      this.clearRefs();
      return {
        url: page.url(),
        elements: [],
        detail: "the page or a frame navigated while observing; observe again",
      };
    }
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
    return this.actOnRef(ref, (handle) => handle.click({ timeout: DEFAULT_ACTION_TIMEOUT_MS }));
  }

  type(ref: string, text: string): Promise<BrowserResult> {
    return this.actOnRef(ref, (handle) =>
      handle.fill(text, { timeout: DEFAULT_ACTION_TIMEOUT_MS }),
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
      this.clearRefs();
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
      // Share region discovery with the embedded browser; let Playwright own
      // input and screenshot transport instead of opening another CDP session.
      const before = await readPageTextState(page);
      const requested =
        typeof amount === "number" && Number.isFinite(amount) && amount !== 0
          ? Math.abs(amount)
          : 600;
      const magnitude = Math.max(1, Math.min(requested, Math.max(1, before.scroll.viewportHeight)));
      await page.mouse.move(
        before.wheelPoint?.x ?? before.scroll.viewportWidth / 2,
        before.wheelPoint?.y ?? before.scroll.viewportHeight / 2,
      );
      const beforePixels =
        before.scroll.positionKnown === false
          ? await page.screenshot({ type: "png", scale: "css" })
          : undefined;
      await page.mouse.wheel(0, (dir === "down" ? 1 : -1) * magnitude);
      const { after, contentChanged, moved, extentChanged } = await observeScrollProgress(
        async () => {
          const after = await readPageTextState(page);
          const afterPixels = beforePixels
            ? await page.screenshot({ type: "png", scale: "css" })
            : undefined;
          return {
            after,
            documentChanged: this.documentId(this.page()) !== beforeDocument,
            contentChanged:
              before.signature !== after.signature ||
              !!(beforePixels && afterPixels && !beforePixels.equals(afterPixels)),
            moved:
              Math.abs(before.scroll.x - after.scroll.x) > 0.5 ||
              Math.abs(before.scroll.y - after.scroll.y) > 0.5,
            extentChanged:
              before.scroll.maxX !== after.scroll.maxX || before.scroll.maxY !== after.scroll.maxY,
          };
        },
        (state) =>
          state.documentChanged || state.contentChanged || state.moved || state.extentChanged,
      );
      const documentId = this.documentId(this.page());
      if (documentId !== beforeDocument) {
        this.clearRefs();
        return {
          ok: false,
          code: "NAVIGATION",
          retryable: true,
          documentId,
          documentChanged: true,
          detail: "the page navigated while scrolling; observe the new document",
        };
      }
      if (!moved && !extentChanged && !contentChanged) {
        return {
          ok: false,
          code: "NO_PROGRESS",
          retryable: false,
          documentId,
          scroll: after.scroll,
          contentChanged: false,
          detail: after.scroll.atEnd
            ? "already at the end of the page"
            : "scroll produced no observable progress",
        };
      }
      return {
        ok: true,
        code: "OK",
        documentId,
        documentChanged: false,
        scroll: after.scroll,
        contentChanged,
      };
    } catch (error) {
      // Navigation can destroy evaluate/screenshot's execution context before
      // the normal post-observation identity check is reached.
      const documentId = this.documentId(this.activePage);
      if (documentId !== beforeDocument) {
        this.clearRefs();
        return {
          ok: false,
          code: "NAVIGATION",
          retryable: true,
          documentId,
          documentChanged: true,
          detail: "the page navigated while scrolling; observe the new document",
        };
      }
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
      const normalized = normalizePageText(
        (await Promise.all(page.frames().map((frame) => frame.evaluate(readFrameText)))).join("\n"),
      );
      if (this.documentId(this.page()) !== documentId) {
        return {
          ok: false,
          code: "NAVIGATION",
          url: page.url(),
          documentId: this.documentId(this.page()),
          text: "",
          detail: "the page or a frame navigated while reading; read again",
        };
      }
      const contentHash = hashText(normalized);
      const parsed = options.cursor ? parseReadCursor(options.cursor) : undefined;
      if (options.cursor && !parsed) {
        return staleCursor(
          url,
          title,
          documentId,
          state.scroll,
          contentHash,
          "invalid read cursor",
        );
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
      for (const [ref, record] of this.refs) {
        if (ref.startsWith(`pw${this.driverId}:m`)) {
          this.refs.delete(ref);
          void record.handle.dispose().catch(() => undefined);
        }
      }
      const collected = await this.collect(
        "media",
        EXTRACT_LINK_CAP * 3,
        `pw${this.driverId}:m${++this.snapshotCounter}`,
      );
      const links: BrowserExtract["links"] = [];
      const images: BrowserExtract["images"] = [];
      const videos: BrowserExtract["videos"] = [];
      const seen = new Set<string>();
      for (const {
        ref,
        metadata: { kind, url, name },
      } of collected) {
        if (!url || seen.has(`${kind}:${url}`)) continue;
        seen.add(`${kind}:${url}`);
        if (kind === "link" && links.length < EXTRACT_LINK_CAP) links.push({ text: name, url });
        if (kind === "image" && images.length < EXTRACT_LINK_CAP)
          images.push({ ref, alt: name, url });
        if (kind === "video" && videos.length < EXTRACT_LINK_CAP) videos.push({ url });
      }
      const extracted = {
        links,
        images,
        videos,
        truncated: collected.truncated,
      };
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
    return this.actOnRef(ref, (handle) => handle.hover({ timeout: DEFAULT_ACTION_TIMEOUT_MS }));
  }

  async selectOption(ref: string, value: string): Promise<BrowserResult> {
    const record = await this.resolveRef(ref);
    if (!record.ok) return record.result;
    try {
      const options = await record.handle.$$eval("option", (nodes) =>
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
      await record.handle.selectOption(match.value, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      return this.successAfterAction(record.documentId, `selected "${match.text || match.value}"`);
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  async pressKey(key: string, ref?: string): Promise<BrowserResult> {
    const before = this.documentId(this.page());
    try {
      if (ref) {
        const record = await this.resolveRef(ref);
        if (!record.ok) return record.result;
        await record.handle.press(key, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      } else {
        await this.page().keyboard.press(key);
      }
      return this.successAfterAction(before);
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  async fetchImages(refs: string[]): Promise<BrowserImageData[]> {
    return Promise.all(
      refs.map(async (ref) => {
        try {
          const record = await this.resolveRef(ref);
          if (!record.ok) return { ok: false, ref, detail: record.result.detail };
          const bytes = await record.handle.screenshot({
            type: "png",
            timeout: DEFAULT_ACTION_TIMEOUT_MS,
          });
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
      return {
        ok: true,
        base64: bytes.toString("base64"),
        mediaType: ref ? "image/png" : "image/jpeg",
      };
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
    if (!page || page.isClosed())
      return { ok: false, code: "FAILED", detail: `tab ${tabId} not found` };
    this.activePage = page;
    this.clearRefs();
    await page.bringToFront();
    return { ok: true, code: "OK", documentId: this.documentId(page) };
  }

  private async screenshotRef(ref: string): Promise<Buffer> {
    const record = await this.resolveRef(ref);
    if (!record.ok) throw new Error(record.result.detail);
    return record.handle.screenshot({ type: "png", timeout: DEFAULT_ACTION_TIMEOUT_MS });
  }

  private async actOnRef(
    ref: string,
    action: (handle: ElementHandle<Element>) => Promise<unknown>,
  ): Promise<BrowserResult> {
    const record = await this.resolveRef(ref);
    if (!record.ok) return record.result;
    try {
      await action(record.handle);
      return this.successAfterAction(record.documentId);
    } catch (error) {
      return playwrightFailure(error);
    }
  }

  private successAfterAction(beforeDocumentId: string, detail?: string): BrowserResult {
    const documentId = this.documentId(this.page());
    const documentChanged = documentId !== beforeDocumentId;
    if (documentChanged) this.clearRefs();
    return {
      ok: true,
      code: documentChanged ? "NAVIGATION" : "OK",
      documentId,
      documentChanged,
      detail,
    };
  }

  private async resolveRef(
    ref: string,
  ): Promise<
    | { ok: true; handle: ElementHandle<Element>; documentId: string }
    | { ok: false; result: BrowserResult }
  > {
    const record = this.refs.get(ref);
    const current = this.documentId(this.page());
    const connected = record
      ? await record.handle
          .evaluate((element) => element.isConnected && element.ownerDocument === document)
          .catch(() => false)
      : false;
    if (!record || record.documentId !== current || !connected) {
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
    return { ok: true, handle: record.handle, documentId: record.documentId };
  }

  private page(): Page {
    if (!this.activePage.isClosed()) return this.activePage;
    const next = this.context.pages().find((page) => !page.isClosed());
    if (!next) throw new Error("Playwright Browser Runtime has no open page");
    this.activePage = next;
    this.clearRefs();
    return next;
  }

  private trackPage(page: Page): PageState {
    const known = this.pageStates.get(page);
    if (known) return known;
    const state = { id: `pw${this.driverId}:p${this.nextPageId++}`, generation: 1 };
    this.pageStates.set(page, state);
    const documentChanged = () => {
      state.generation += 1;
      if (page === this.activePage) this.clearRefs();
    };
    page.on("framenavigated", documentChanged);
    page.on("framedetached", documentChanged);
    page.on("close", () => {
      if (page === this.activePage) this.clearRefs();
    });
    return state;
  }

  private documentId(page: Page): string {
    const state = this.trackPage(page);
    return `${state.id}:document:${state.generation}`;
  }

  private clearRefs(): void {
    for (const { handle } of this.refs.values()) void handle.dispose().catch(() => undefined);
    this.refs.clear();
  }

  private async collect(mode: "interactive" | "media", cap: number, prefix: string) {
    const output: Array<{
      ref: string;
      metadata: ReturnType<typeof collectPageNodes>["metadata"][number];
    }> & { truncated: boolean } = Object.assign([], { truncated: false });
    const mediaLimits = { link: cap / 3, image: cap / 3, video: cap / 3 };
    const seenMedia: string[] = [];
    const page = this.page();
    const documentId = this.documentId(page);
    for (const frame of page.frames()) {
      if (output.length >= cap) break;
      const result = await frame.evaluateHandle(collectPageNodes, {
        mode,
        cap: cap - output.length,
        mediaLimits: mode === "media" ? mediaLimits : undefined,
        seenMedia,
      });
      const nodes = await result.getProperty("nodes");
      const metadataHandle = await result.getProperty("metadata");
      try {
        const metadata = (await metadataHandle.jsonValue()) as ReturnType<
          typeof collectPageNodes
        >["metadata"];
        output.truncated ||= await result.evaluate((value) => value.truncated);
        for (const [key, node] of await nodes.getProperties()) {
          const handle = node.asElement() as ElementHandle<Element> | null;
          if (!handle || !metadata[Number(key)]) {
            await node.dispose();
            continue;
          }
          const ref = `${prefix}:e${output.length + 1}`;
          this.refs.set(ref, { handle, documentId });
          const item = metadata[Number(key)]!;
          output.push({ ref, metadata: item });
          if (item.kind) {
            mediaLimits[item.kind]--;
            seenMedia.push(`${item.kind}:${item.url}`);
          }
        }
      } finally {
        await Promise.all([result.dispose(), nodes.dispose(), metadataHandle.dispose()]);
      }
      if (this.documentId(this.page()) !== documentId) {
        this.clearRefs();
        throw new Error("the page or a frame navigated while observing; observe again");
      }
    }
    return output;
  }
}

async function readPageTextState(page: Page): Promise<PageTextState> {
  const state = (await page.evaluate(READ_PAGE_STATE_EXPRESSION)) as PageTextState & {
    contentSignature: string;
  };
  return { ...state, signature: state.contentSignature };
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
