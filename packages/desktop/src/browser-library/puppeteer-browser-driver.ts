import type {
  BrowserBridge,
  BrowserContent,
  BrowserElement,
  BrowserExtract,
  BrowserIdentity,
  BrowserImageData,
  BrowserInspectOptions,
  BrowserInspectResult,
  BrowserReadOptions,
  BrowserResult,
  BrowserScrollState,
  BrowserSnapshot,
  BrowserTab,
} from "@cjhyy/code-shell-core";
import {
  CONTENT_CHAR_CAP,
  EXTRACT_LINK_CAP,
  MAX_CONTENT_CHAR_CAP,
  MAX_IMAGE_DIM,
  READ_PAGE_STATE_EXPRESSION,
  encodeReadCursor,
  hashText,
  normalizePageText,
  parseReadCursor,
} from "@cjhyy/code-shell-cdp";
import type {
  ElementHandle,
  Frame,
  JSHandle,
  KeyInput,
  Page,
} from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import { collectPageNodes, readFrameText } from "./dom-observation.js";
import { observeScrollProgress } from "./scroll-observation.js";
import { createPuppeteerInspector } from "./browser-inspector.js";

export interface PuppeteerScreenshotRequest {
  /** Viewport-relative CSS pixels; the host owns native scale/zoom conversion. */
  region?: { x: number; y: number; width: number; height: number };
  maxDim: number;
}

export interface PuppeteerBrowserDriverOptions {
  captureScreenshot?: (request: PuppeteerScreenshotRequest) => Promise<BrowserImageData>;
  documentNamespace?: string;
  actionTimeoutMs?: number;
  identity?: BrowserIdentity;
  requestHumanTakeover?: () => Promise<BrowserResult>;
  isActive?: () => boolean;
  signal?: AbortSignal;
}

interface RefRecord {
  handle: ElementHandle<Element>;
  documentId: string;
  frame: Frame;
}

interface TextState {
  text: string;
  scroll: BrowserScrollState;
  contentSignature: string;
  wheelPoint?: { x: number; y: number };
}

let nextDriver = 0;

/**
 * One explicitly authorized Page. Puppeteer owns element geometry and input;
 * this adapter owns observation refs, progress and target/grant lifetime.
 * ElementHandles intentionally preserve node identity: a same-name replacement
 * never receives an action intended for an earlier observation.
 *
 * This module is shared by Electron and the Chrome service-worker bundle.
 * All core/Puppeteer imports here are type-only; no Node runtime is pulled in.
 */
export class PuppeteerBrowserDriver implements BrowserBridge {
  private readonly namespace: string;
  private generation = 1;
  private mainDocumentGeneration = 1;
  private readonly mainFrame: Frame;
  private observation = 0;
  private refs = new Map<string, RefRecord>();
  private disposed = false;
  private readonly abort = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private inspector?: ReturnType<typeof createPuppeteerInspector>;
  private readonly onDocumentChange = (frame: Frame) => {
    if (frame === this.mainFrame) this.mainDocumentGeneration++;
    this.resetRefs();
  };
  private readonly onClose = () => this.dispose();
  private readonly onAbort = () => this.dispose();

  constructor(
    readonly page: Page,
    private readonly options: PuppeteerBrowserDriverOptions = {},
  ) {
    this.namespace = `${options.documentNamespace ?? "puppeteer"}:p${++nextDriver}`;
    this.mainFrame = page.mainFrame();
    page.on("framenavigated", this.onDocumentChange);
    page.on("framedetached", this.onDocumentChange);
    page.on("close", this.onClose);
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.resetRefs();
    this.inspector?.dispose();
    this.page.off("framenavigated", this.onDocumentChange);
    this.page.off("framedetached", this.onDocumentChange);
    this.page.off("close", this.onClose);
    this.options.signal?.removeEventListener("abort", this.onAbort);
  }

  resetRefs(): void {
    this.generation++;
    this.releaseRefs();
  }

  /** Compatibility with hosts resetting a transport lease; no CDP domains exist here. */
  resetDomains(): void {
    this.resetRefs();
  }

  currentPageInfo() {
    return { url: this.page.url(), documentId: this.documentId() };
  }

  snapshot(): Promise<BrowserSnapshot> {
    return this.enqueue(async () => {
      const mainDocumentGeneration = this.mainDocumentGeneration;
      for (let attempt = 0; ; attempt++) {
        try {
          this.checkActive();
          this.releaseRefs();
          const documentId = this.documentId();
          const snapshotId = `${this.namespace}:s${++this.observation}`;
          const collected = await this.collect("interactive", 250, snapshotId);
          const title = await this.title();
          this.checkDocument(documentId);
          const elements: BrowserElement[] = collected.map(({ ref, metadata }) => ({
            ref,
            role: metadata.role,
            name: metadata.name,
            sensitive: metadata.sensitive,
            value: metadata.value,
          }));
          return {
            url: this.page.url(),
            title,
            documentId,
            snapshotId,
            elements,
            identity: this.options.identity,
            ...(elements.some((element) => element.sensitive)
              ? { needsHuman: "this page requires sign-in or another sensitive input" }
              : {}),
          };
        } catch (error) {
          this.releaseRefs();
          // Restored OOPIFs can register after the main Page is ready. Restart
          // this read with fresh refs, but never cross a main-document navigation:
          // the host must recheck the destination's authorization first.
          if (
            error instanceof DriverError &&
            error.code === "NAVIGATION" &&
            mainDocumentGeneration === this.mainDocumentGeneration &&
            attempt < 2
          )
            continue;
          return {
            url: this.page.url(),
            elements: [],
            detail: message(error),
            identity: this.options.identity,
          };
        }
      }
    });
  }

  click(ref: string): Promise<BrowserResult> {
    return this.actOnRef(ref, (handle) => handle.click());
  }

  hover(ref: string): Promise<BrowserResult> {
    return this.actOnRef(ref, (handle) => handle.hover());
  }

  type(ref: string, text: string): Promise<BrowserResult> {
    return this.actOnRef(ref, async (handle) => {
      const editable = await handle.evaluate((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          return (
            !element.readOnly &&
            !element.disabled &&
            !(
              element instanceof HTMLInputElement &&
              [
                "button",
                "submit",
                "reset",
                "checkbox",
                "radio",
                "file",
                "hidden",
                "image",
                "range",
                "color",
              ].includes(element.type)
            )
          );
        }
        return element instanceof HTMLElement && element.isContentEditable;
      });
      if (!editable) throw new Error("the referenced element is not an editable text field");
      await handle.focus();
      const nativeInput = await handle.evaluate(
        (element) =>
          element instanceof HTMLInputElement &&
          ["date", "datetime-local", "month", "time", "week"].includes(element.type),
      );
      if (nativeInput) {
        this.checkActive();
        // Puppeteer 23's Locator.fill uses DOM input/change for controls which
        // cannot accept typed text. Apply that strategy to the retained node.
        await handle.evaluate((element, value) => {
          const input = element as HTMLInputElement;
          input.value = value;
          if (input.value !== value) throw new Error("the input rejected this value format");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, text);
        return;
      }
      await handle.evaluate((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
          element.select();
        else element.ownerDocument.getSelection()?.selectAllChildren(element);
      });
      this.checkActive();
      // Keyboard supplies trusted editing events, including for contenteditable.
      if (text) await this.page.keyboard.sendCharacter(text);
      else await this.page.keyboard.press("Backspace");
    });
  }

  selectOption(ref: string, value: string): Promise<BrowserResult> {
    return this.actOnRef(ref, async (handle) => {
      const selected = await handle.evaluate((element, desired) => {
        if (!(element instanceof HTMLSelectElement))
          throw new Error("ref is not a native select element");
        return Array.from(element.options).find(
          (option) => option.value === desired || option.textContent?.trim() === desired,
        )?.value;
      }, value);
      if (selected === undefined) throw new Error(`no option matched ${JSON.stringify(value)}`);
      await handle.select(selected);
    });
  }

  pressKey(key: string, ref?: string): Promise<BrowserResult> {
    return ref
      ? this.actOnRef(ref, async (handle) => {
          await handle.focus();
          await this.keySequence(key);
        })
      : this.resultAction(() => this.keySequence(key));
  }

  navigate(url: string): Promise<BrowserResult> {
    return this.resultAction(async () => {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    });
  }

  waitForLoad(timeoutMs = 30_000): Promise<BrowserResult> {
    return this.resultAction(async () => {
      const ready = await this.page.waitForFunction(() => document.readyState === "complete", {
        timeout: Math.max(1, Math.min(timeoutMs, 60_000)),
        signal: this.abort.signal,
      });
      await ready.dispose();
    });
  }

  scroll(dir: "up" | "down", amount?: number): Promise<BrowserResult> {
    return this.enqueue(async () => {
      const beforeDocument = this.documentId();
      try {
        this.checkActive();
        const before = await this.textState();
        const requested = Number.isFinite(amount) && amount !== 0 ? Math.abs(amount!) : 600;
        const magnitude = Math.max(
          1,
          Math.min(requested, Math.max(1, before.scroll.viewportHeight)),
        );
        await this.page.mouse.move(
          before.wheelPoint?.x ?? before.scroll.viewportWidth / 2,
          before.wheelPoint?.y ?? before.scroll.viewportHeight / 2,
        );
        const beforePixels =
          before.scroll.positionKnown === false ? await this.capture() : undefined;
        this.checkDocument(beforeDocument);
        await this.page.mouse.wheel({ deltaY: (dir === "down" ? 1 : -1) * magnitude });
        const { after, contentChanged, moved, extentChanged } = await observeScrollProgress(
          async () => {
            const after = await this.textState();
            const afterPixels = beforePixels ? await this.capture() : undefined;
            this.checkDocument(beforeDocument);
            return {
              after,
              contentChanged:
                before.contentSignature !== after.contentSignature ||
                !!(
                  beforePixels?.ok &&
                  afterPixels?.ok &&
                  beforePixels.base64 !== afterPixels.base64
                ),
              moved:
                Math.abs(before.scroll.x - after.scroll.x) > 0.5 ||
                Math.abs(before.scroll.y - after.scroll.y) > 0.5,
              extentChanged:
                before.scroll.maxX !== after.scroll.maxX ||
                before.scroll.maxY !== after.scroll.maxY,
            };
          },
          (state) => state.contentChanged || state.moved || state.extentChanged,
        );
        return {
          ok: moved || extentChanged || contentChanged,
          code: moved || extentChanged || contentChanged ? "OK" : "NO_PROGRESS",
          retryable: false,
          documentId: this.documentId(),
          documentChanged: false,
          scroll: after.scroll,
          contentChanged,
          ...(!moved && !extentChanged && !contentChanged
            ? { detail: "scroll produced no observable progress" }
            : {}),
        };
      } catch (error) {
        return this.failure(error, beforeDocument);
      }
    });
  }

  readContent(options: BrowserReadOptions = {}): Promise<BrowserContent> {
    return this.enqueue(async () => {
      const documentId = this.documentId();
      try {
        this.checkActive();
        const state = await this.textState();
        const text = normalizePageText(
          (
            await Promise.all(this.page.frames().map((frame) => frame.evaluate(readFrameText)))
          ).join("\n"),
        );
        const title = await this.title();
        this.checkDocument(documentId);
        const parsed = options.cursor ? parseReadCursor(options.cursor) : undefined;
        const offset = parsed?.offset ?? 0;
        if (
          (options.cursor && !parsed) ||
          (parsed && parsed.documentId !== documentId) ||
          offset < 0 ||
          offset > text.length
        ) {
          return {
            ok: false,
            code: "STALE_CURSOR",
            url: this.page.url(),
            documentId,
            title,
            text: "",
            detail:
              "read cursor is invalid or belongs to a previous document; read again without a cursor",
          };
        }
        const maxChars = Math.max(
          256,
          Math.min(
            MAX_CONTENT_CHAR_CAP,
            Number.isFinite(options.maxChars) ? Math.floor(options.maxChars!) : CONTENT_CHAR_CAP,
          ),
        );
        const end = Math.min(text.length, offset + maxChars);
        return {
          ok: true,
          code: "OK",
          url: this.page.url(),
          title,
          documentId,
          text: text.slice(offset, end),
          cursor: encodeReadCursor(documentId, offset),
          nextCursor: end < text.length ? encodeReadCursor(documentId, end) : undefined,
          done: end >= text.length,
          truncated: end < text.length,
          contentHash: hashText(text),
          scroll: state.scroll,
        };
      } catch (error) {
        return { ...this.failure(error, documentId), url: this.page.url(), text: "" };
      }
    });
  }

  extractLinks(): Promise<BrowserExtract> {
    return this.enqueue(async () => {
      const documentId = this.documentId();
      try {
        this.checkActive();
        for (const [ref, record] of this.refs) {
          if (ref.startsWith(`${this.namespace}:m`)) {
            this.refs.delete(ref);
            void record.handle.dispose().catch(() => undefined);
          }
        }
        const collected = await this.collect(
          "media",
          EXTRACT_LINK_CAP * 3,
          `${this.namespace}:m${++this.observation}`,
        );
        const links: BrowserExtract["links"] = [];
        const images: BrowserExtract["images"] = [];
        const videos: BrowserExtract["videos"] = [];
        const seen = new Set<string>();
        for (const { ref, metadata } of collected) {
          const { kind, url, name } = metadata;
          if (!url || seen.has(`${kind}:${url}`)) continue;
          seen.add(`${kind}:${url}`);
          if (kind === "link" && links.length < EXTRACT_LINK_CAP) links.push({ text: name, url });
          if (kind === "image" && images.length < EXTRACT_LINK_CAP)
            images.push({ ref, alt: name, url });
          if (kind === "video" && videos.length < EXTRACT_LINK_CAP) videos.push({ url });
        }
        const title = await this.title();
        this.checkDocument(documentId);
        return {
          ok: true,
          url: this.page.url(),
          title,
          links,
          images,
          videos,
          truncated: collected.truncated,
        };
      } catch (error) {
        return {
          ok: false,
          url: this.page.url(),
          links: [],
          images: [],
          videos: [],
          detail: message(error),
        };
      }
    });
  }

  fetchImages(refs: string[]): Promise<BrowserImageData[]> {
    return this.enqueue(async () => {
      const results: BrowserImageData[] = [];
      for (const ref of refs) {
        try {
          const record = await this.resolve(ref);
          const data = await record.handle.evaluate((element, maxDim) => {
            if (
              !(element instanceof HTMLImageElement) ||
              !element.complete ||
              !element.naturalWidth
            )
              return null;
            try {
              const scale = Math.min(
                1,
                maxDim / Math.max(element.naturalWidth, element.naturalHeight),
              );
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.round(element.naturalWidth * scale));
              canvas.height = Math.max(1, Math.round(element.naturalHeight * scale));
              canvas.getContext("2d")!.drawImage(element, 0, 0, canvas.width, canvas.height);
              return canvas.toDataURL("image/png").split(",")[1] ?? null;
            } catch {
              return null;
            }
          }, MAX_IMAGE_DIM);
          this.checkDocument(record.documentId);
          const result = data
            ? { ok: true, ref, base64: data, mediaType: "image/png" }
            : { ...(await this.capture(record.handle)), ref };
          this.checkDocument(record.documentId);
          results.push(result);
        } catch (error) {
          results.push({ ok: false, ref, detail: message(error) });
        }
      }
      return results;
    });
  }

  screenshot(ref?: string): Promise<BrowserImageData> {
    return this.enqueue(async () => {
      const documentId = this.documentId();
      try {
        this.checkActive();
        const image = await this.capture(ref ? (await this.resolve(ref)).handle : undefined);
        this.checkDocument(documentId);
        return { ...image, ref };
      } catch (error) {
        return { ok: false, ref, detail: message(error) };
      }
    });
  }

  listTabs(): Promise<BrowserTab[]> {
    return this.enqueue(async () => {
      this.checkActive();
      return [
        {
          tabId: this.namespace,
          url: this.page.url(),
          title: (await this.title()) ?? "",
          active: true,
        },
      ];
    });
  }

  switchTab(tabId: string): Promise<BrowserResult> {
    return this.resultAction(async () => {
      if (tabId !== this.namespace)
        throw new DriverError("BLOCKED", "this driver can only use its explicitly authorized page");
      await this.page.bringToFront();
    });
  }

  requestHumanTakeover(): Promise<BrowserResult> {
    return this.enqueue(async () => {
      try {
        this.checkActive();
        return (
          (await this.options.requestHumanTakeover?.()) ?? {
            ok: false,
            code: "NEEDS_HUMAN",
            detail: "manual browser control is required",
          }
        );
      } catch (error) {
        return this.failure(error);
      }
    });
  }

  inspect(options: BrowserInspectOptions): Promise<BrowserInspectResult> {
    return this.enqueue(async () => {
      try {
        this.checkActive();
        this.inspector ??= createPuppeteerInspector(this.page);
        const result = await this.inspector.inspect(options);
        this.checkActive();
        return result;
      } catch (error) {
        return { ...this.failure(error), mode: options.mode };
      }
    });
  }

  private actOnRef(
    ref: string,
    action: (handle: ElementHandle<Element>) => Promise<unknown>,
  ): Promise<BrowserResult> {
    return this.enqueue(async () => {
      const before = this.documentId();
      let record: RefRecord | undefined;
      try {
        record = await this.resolve(ref);
        await this.ready(record.handle);
        this.checkDocument(before);
        await action(record.handle);
        this.checkActive();
        return this.success(before);
      } catch (error) {
        if (record && before === this.documentId() && !(await this.connected(record)))
          return this.stale(ref);
        return this.failure(error, before);
      }
    });
  }

  private resultAction(action: () => Promise<unknown>): Promise<BrowserResult> {
    return this.enqueue(async () => {
      const before = this.documentId();
      try {
        this.checkActive();
        await action();
        this.checkActive();
        return this.success(before);
      } catch (error) {
        return this.failure(error, before);
      }
    });
  }

  private async ready(handle: ElementHandle<Element>): Promise<void> {
    const ready = await handle.frame.waitForFunction(
      (element) => {
        if (!element.isConnected) throw new Error("referenced node is detached");
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          !element.hasAttribute("disabled")
        );
      },
      { timeout: this.options.actionTimeoutMs ?? 12_000, signal: this.abort.signal },
      handle,
    );
    await ready.dispose();
    this.checkActive();
    await handle.scrollIntoView();
    // A child-frame box can be correct before the parent's scroll is painted.
    // Settle after the library scrolls, before it computes the input target.
    const stable = await handle.frame.waitForFunction(
      async (element) => {
        const first = element.getBoundingClientRect();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (!element.isConnected) throw new Error("referenced node is detached");
        const second = element.getBoundingClientRect();
        return (
          first.x === second.x &&
          first.y === second.y &&
          first.width === second.width &&
          first.height === second.height
        );
      },
      { timeout: this.options.actionTimeoutMs ?? 12_000, signal: this.abort.signal },
      handle,
    );
    await stable.dispose();
  }

  private async keySequence(combination: string): Promise<void> {
    const isMac = await this.page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
    const aliases: Record<string, string> = {
      ControlOrMeta: isMac ? "Meta" : "Control",
      CmdOrCtrl: isMac ? "Meta" : "Control",
      Cmd: "Meta",
      Command: "Meta",
      Ctrl: "Control",
      Esc: "Escape",
      Return: "Enter",
    };
    const keys = combination.split("+").map((key) => (aliases[key] ?? key) as KeyInput);
    const pressed: KeyInput[] = [];
    try {
      for (const modifier of keys.slice(0, -1)) {
        this.checkActive();
        await this.page.keyboard.down(modifier);
        pressed.push(modifier);
      }
      this.checkActive();
      await this.page.keyboard.press(keys.at(-1)!);
    } finally {
      for (const modifier of pressed.reverse())
        await this.page.keyboard.up(modifier).catch(() => undefined);
    }
  }

  private async collect(mode: "interactive" | "media", cap: number, prefix: string) {
    const output: Array<{
      ref: string;
      metadata: ReturnType<typeof collectPageNodes>["metadata"][number];
    }> & { truncated: boolean } = Object.assign([], { truncated: false });
    const mediaLimits = { link: cap / 3, image: cap / 3, video: cap / 3 };
    const seenMedia: string[] = [];
    const documentId = this.documentId();
    for (const frame of this.page.frames()) {
      if (output.length >= cap) break;
      const result = await frame.evaluateHandle(collectPageNodes, {
        mode,
        cap: cap - output.length,
        mediaLimits: mode === "media" ? mediaLimits : undefined,
        seenMedia,
      });
      let nodes: JSHandle<ReturnType<typeof collectPageNodes>["nodes"]> | undefined;
      let metadataHandle: JSHandle<ReturnType<typeof collectPageNodes>["metadata"]> | undefined;
      const unclaimed = new Set<JSHandle>();
      try {
        this.checkDocument(documentId);
        nodes = await result.getProperty("nodes");
        metadataHandle = await result.getProperty("metadata");
        const metadata = await metadataHandle.jsonValue();
        output.truncated ||= await result.evaluate((value) => value.truncated);
        const properties = await nodes.getProperties();
        for (const node of properties.values()) unclaimed.add(node);
        for (const [key, node] of properties) {
          const handle = node.asElement() as ElementHandle<Element> | null;
          if (!handle || !metadata[Number(key)]) {
            continue;
          }
          const ref = `${prefix}:e${output.length + 1}`;
          this.refs.set(ref, { handle, documentId, frame });
          unclaimed.delete(node);
          const item = metadata[Number(key)]!;
          output.push({ ref, metadata: item });
          if (item.kind) {
            mediaLimits[item.kind]--;
            seenMedia.push(`${item.kind}:${item.url}`);
          }
        }
      } finally {
        await Promise.all(
          [result, nodes, metadataHandle, ...unclaimed].map((handle) =>
            handle?.dispose().catch(() => undefined),
          ),
        );
      }
      this.checkDocument(documentId);
    }
    return output;
  }

  private async resolve(ref: string): Promise<RefRecord> {
    this.checkActive();
    const record = this.refs.get(ref);
    if (!record || record.documentId !== this.documentId() || !(await this.connected(record))) {
      throw new DriverError(
        "STALE_SNAPSHOT",
        `unknown or detached ref ${ref}; take a new snapshot`,
      );
    }
    return record;
  }

  private async connected(record: RefRecord): Promise<boolean> {
    try {
      return (
        !record.frame.detached &&
        (await record.handle.evaluate(
          (element) => element.isConnected && element.ownerDocument === document,
        ))
      );
    } catch {
      return false;
    }
  }

  private async capture(handle?: ElementHandle<Element>): Promise<BrowserImageData> {
    this.checkActive();
    if (handle) await handle.scrollIntoView();
    const viewport = await this.page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      x: scrollX,
      y: scrollY,
      dpr: devicePixelRatio,
    }));
    let region: PuppeteerScreenshotRequest["region"];
    if (handle) {
      const box = await handle.boundingBox();
      if (!box) throw new Error("referenced element has no visible box");
      const x = Math.max(0, box.x),
        y = Math.max(0, box.y);
      region = {
        x,
        y,
        width: Math.min(viewport.width, box.x + box.width) - x,
        height: Math.min(viewport.height, box.y + box.height) - y,
      };
      if (region.width <= 0 || region.height <= 0)
        throw new Error("referenced element is outside the viewport");
    }
    this.checkActive();
    if (this.options.captureScreenshot) {
      return this.options.captureScreenshot({ region, maxDim: MAX_IMAGE_DIM });
    }
    const area = region ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const base64 = await this.page.screenshot({
      encoding: "base64",
      type: "jpeg",
      quality: 80,
      // The clip is already inside the viewport. Puppeteer 23's additional
      // viewport intersection drops clip.scale, so keep its clipping step off.
      captureBeyondViewport: true,
      clip: {
        ...area,
        x: area.x + viewport.x,
        y: area.y + viewport.y,
        scale: Math.min(1, MAX_IMAGE_DIM / (Math.max(area.width, area.height) * viewport.dpr)),
      },
    });
    return { ok: true, base64, mediaType: "image/jpeg" };
  }

  private async textState(): Promise<TextState> {
    this.checkActive();
    return this.page.evaluate(READ_PAGE_STATE_EXPRESSION) as Promise<TextState>;
  }

  private releaseRefs(): void {
    for (const { handle } of this.refs.values()) void handle.dispose().catch(() => undefined);
    this.refs.clear();
  }

  private documentId(): string {
    return `${this.namespace}:document:${this.generation}`;
  }
  private checkActive(): void {
    if (
      this.disposed ||
      this.page.isClosed() ||
      this.options.signal?.aborted ||
      this.options.isActive?.() === false
    ) {
      throw new DriverError(
        this.page.isClosed() ? "TARGET_CLOSED" : "BLOCKED",
        "browser control lease has ended",
      );
    }
  }
  private checkDocument(before: string): void {
    this.checkActive();
    if (before !== this.documentId())
      throw new DriverError(
        "NAVIGATION",
        "the page or a frame navigated; observe the new document",
      );
  }
  private stale(ref: string): BrowserResult {
    return {
      ok: false,
      code: "STALE_SNAPSHOT",
      retryable: true,
      staleRef: true,
      documentId: this.documentId(),
      detail: `ref ${ref} is no longer attached; take a new snapshot`,
    };
  }
  private failure(error: unknown, before?: string): BrowserResult {
    if (this.disposed || this.page.isClosed() || this.options.isActive?.() === false) {
      return {
        ok: false,
        code: this.page.isClosed() ? "TARGET_CLOSED" : "BLOCKED",
        retryable: false,
        detail: "browser control lease has ended",
      };
    }
    if (before && before !== this.documentId() && !this.disposed)
      return {
        ok: false,
        code: "NAVIGATION",
        retryable: true,
        documentChanged: true,
        documentId: this.documentId(),
        detail: "the page or a frame navigated; observe the new document",
      };
    const code =
      error instanceof DriverError
        ? error.code
        : /detached|not attached/i.test(message(error))
          ? "STALE_SNAPSHOT"
          : "FAILED";
    return {
      ok: false,
      code,
      retryable: code === "STALE_SNAPSHOT",
      staleRef: code === "STALE_SNAPSHOT" || undefined,
      documentId: this.documentId(),
      detail: message(error),
    };
  }
  private success(before: string): BrowserResult {
    const documentId = this.documentId();
    return {
      ok: true,
      code: documentId === before ? "OK" : "NAVIGATION",
      documentId,
      documentChanged: documentId !== before,
    };
  }
  private async title(): Promise<string | undefined> {
    try {
      return await this.page.title();
    } catch {
      return undefined;
    }
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(action, action);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}

class DriverError extends Error {
  constructor(
    readonly code: NonNullable<BrowserResult["code"]>,
    detail: string,
  ) {
    super(detail);
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
