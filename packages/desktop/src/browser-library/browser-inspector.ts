import type { BrowserInspectOptions, BrowserInspectResult } from "@cjhyy/code-shell-core";
import type { Page as PuppeteerPage } from "puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js";
import type { Page as PlaywrightPage } from "playwright-core";

const RECORD_CAP = 100;

/** Both libraries supply this public event/evaluation surface. No raw CDP. */
interface InspectorPage {
  url(): string;
  isClosed(): boolean;
  mainFrame?(): unknown;
  evaluate: (fn: any, arg?: any) => Promise<any>;
  on: (event: any, listener: any) => unknown;
  off: (event: any, listener: any) => unknown;
}

export interface BrowserInspector {
  inspect(options: BrowserInspectOptions): Promise<BrowserInspectResult>;
  dispose(): void;
}

export const createPuppeteerInspector = (page: PuppeteerPage): BrowserInspector =>
  createInspector(page);
export const createPlaywrightInspector = (page: PlaywrightPage): BrowserInspector =>
  createInspector(page);

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}[redacted]`;
    return `${url.origin}${url.pathname}`.slice(0, 1000);
  } catch {
    return raw.slice(0, 200);
  }
}

function createInspector(page: InspectorPage): BrowserInspector {
  let disposed = false;
  let consoleActive = false;
  let networkActive = false;
  const consoleRecords: unknown[] = [];
  const networkRecords: unknown[] = [];
  const evaluate = async (fn: any, arg?: any) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.evaluate(fn, arg),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("developer inspection timed out")), 8000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const push = (records: unknown[], record: unknown) => {
    if (disposed) return;
    records.push(record);
    if (records.length > RECORD_CAP) records.shift();
  };
  const onConsole = (message: { type(): string; text(): string }) =>
    push(consoleRecords, {
      time: new Date().toISOString(),
      type: message.type(),
      text: message.text().slice(0, 1000),
    });
  const onError = (error: Error) =>
    push(consoleRecords, {
      time: new Date().toISOString(),
      type: "error",
      text: String(error).slice(0, 1000),
    });
  const onResponse = (response: any) => {
    const request = response.request();
    push(networkRecords, {
      time: new Date().toISOString(),
      url: safeUrl(response.url()),
      method: request.method(),
      type: request.resourceType(),
      status: response.status(),
    });
  };
  const onFailed = (request: any) =>
    push(networkRecords, {
      time: new Date().toISOString(),
      url: safeUrl(request.url()),
      method: request.method(),
      error: String(request.failure()?.errorText ?? "request failed").slice(0, 300),
    });
  const stop = () => {
    if (consoleActive) {
      page.off("console", onConsole);
      page.off("pageerror", onError);
    }
    if (networkActive) {
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
    }
    consoleActive = false;
    networkActive = false;
    consoleRecords.length = 0;
    networkRecords.length = 0;
  };
  // A grant authorizes the current page, not future origins. Discard diagnostic
  // history on document navigation so a later allowed page cannot read another
  // origin's logs. Start recording again explicitly on the new document.
  const onNavigation = (frame: unknown) => {
    if (!page.mainFrame || frame === page.mainFrame()) stop();
  };
  const dispose = () => {
    disposed = true;
    stop();
    page.off("framenavigated", onNavigation);
    page.off("close", dispose);
  };
  page.on("framenavigated", onNavigation);
  page.on("close", dispose);
  return {
    dispose,
    async inspect(options) {
      const mode = options?.mode;
      if (disposed || page.isClosed()) {
        return { ok: false, mode, code: "TARGET_CLOSED", detail: "browser control ended" };
      }
      const limit = Number.isFinite(options.maxEntries)
        ? Math.max(1, Math.min(RECORD_CAP, Math.floor(options.maxEntries!)))
        : 50;
      try {
        let data: unknown;
        if (mode === "stop") {
          stop();
          data = { recording: false };
        } else if (mode === "console") {
          if (!consoleActive) {
            page.on("console", onConsole);
            page.on("pageerror", onError);
            consoleActive = true;
          }
          data = { recording: true, entries: consoleRecords.slice(-limit) };
        } else if (mode === "network") {
          if (!networkActive) {
            page.on("response", onResponse);
            page.on("requestfailed", onFailed);
            networkActive = true;
          }
          data = { recording: true, entries: networkRecords.slice(-limit) };
        } else if (mode === "dom") {
          data = await evaluate(
            ({ selector, limit }: { selector: string; limit: number }) => {
              const root = document.querySelector(selector);
              if (!root) return { nodes: [], detail: "selector matched no element" };
              const queue: Element[] = [root];
              const nodes: unknown[] = [];
              // Bound traversal separately: hidden/script-heavy pages cannot allocate an unbounded queue.
              let visited = 0;
              while (queue.length && nodes.length < limit && visited++ < 1000) {
                const element = queue.shift()!;
                if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) continue;
                const style = getComputedStyle(element);
                if (style.display === "none" || style.visibility === "hidden") continue;
                const rect = element.getBoundingClientRect();
                const secret =
                  element.matches("input,textarea") ||
                  (element instanceof HTMLElement && element.isContentEditable);
                const text = secret
                  ? undefined
                  : Array.from(element.childNodes)
                      .filter((node) => node.nodeType === Node.TEXT_NODE)
                      .map((node) => node.textContent ?? "")
                      .join(" ")
                      .trim()
                      .slice(0, 160);
                nodes.push({
                  tag: element.tagName.toLowerCase(),
                  id: element.id.slice(0, 100),
                  role: element.getAttribute("role")?.slice(0, 100),
                  text,
                  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  styles: {
                    display: style.display,
                    position: style.position,
                    overflow: style.overflow,
                    color: style.color,
                    fontSize: style.fontSize,
                    zIndex: style.zIndex,
                  },
                });
                if (secret) continue;
                for (const child of Array.from(element.children)) {
                  if (queue.length >= 1000) break;
                  queue.push(child);
                }
                for (const child of Array.from(element.shadowRoot?.children ?? [])) {
                  if (queue.length >= 1000) break;
                  queue.push(child);
                }
              }
              return { nodes, truncated: queue.length > 0 };
            },
            { selector: options.selector?.slice(0, 1000) || "body", limit },
          );
        } else if (mode === "performance") {
          data = await evaluate((limit: number) => {
            const entries = [
              ...performance.getEntriesByType("navigation"),
              ...performance.getEntriesByType("paint"),
              ...performance.getEntriesByType("resource"),
            ];
            return {
              timeOrigin: performance.timeOrigin,
              now: performance.now(),
              entries: entries.slice(0, limit).map((entry) => {
                let name = entry.name;
                try {
                  const url = new URL(name);
                  name =
                    url.protocol === "http:" || url.protocol === "https:"
                      ? `${url.origin}${url.pathname}`
                      : `${url.protocol}[redacted]`;
                } catch {
                  /* paint name */
                }
                return {
                  name: name.slice(0, 500),
                  type: entry.entryType,
                  startTime: entry.startTime,
                  duration: entry.duration,
                };
              }),
              truncated: entries.length > limit,
            };
          }, limit);
        } else {
          return {
            ok: false,
            mode,
            code: "BLOCKED",
            detail: "unsupported developer inspection mode",
          };
        }
        if (disposed)
          return { ok: false, mode, code: "TARGET_CLOSED", detail: "browser control ended" };
        return { ok: true, mode, url: safeUrl(page.url()), data };
      } catch (error) {
        return { ok: false, mode, code: "FAILED", detail: String(error).slice(0, 1000) };
      }
    },
  };
}
