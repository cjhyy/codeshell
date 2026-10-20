import type { BrowserInspector, BrowserInspectorPage } from "./contracts.js";

const RECORD_CAP = 100;

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}[redacted]`;
    return `${url.origin}${url.pathname}`.slice(0, 1000);
  } catch {
    return raw.slice(0, 200);
  }
}

export function createBrowserInspector(page: BrowserInspectorPage): BrowserInspector {
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
  // Diagnostic history belongs to the current document. Discard it on
  // navigation so a later page cannot read another document's logs.
  // Start recording again explicitly on the new document.
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
                // display:none removes the subtree; visibility:hidden only hides this
                // element, and descendants may set visibility:visible again.
                if (style.display === "none") continue;
                const secret =
                  element.matches("input,textarea") ||
                  (element instanceof HTMLElement && element.isContentEditable);
                if (style.visibility !== "hidden") {
                  const rect = element.getBoundingClientRect();
                  // Read collections by index up to the budget instead of copying
                  // wide child lists in full before the caps apply.
                  let text: string | undefined;
                  if (!secret) {
                    text = "";
                    const childNodes = element.childNodes;
                    for (let i = 0; i < childNodes.length && i < 1000; i++) {
                      if (text.trim().length >= 160) break;
                      const node = childNodes[i]!;
                      if (node.nodeType !== Node.TEXT_NODE) continue;
                      text += (i === 0 ? "" : " ") + (node.textContent ?? "");
                    }
                    text = text.trim().slice(0, 160);
                  }
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
                }
                if (secret) continue;
                for (const children of [element.children, element.shadowRoot?.children]) {
                  for (let i = 0; children && i < children.length && queue.length < 1000; i++) {
                    queue.push(children[i]!);
                  }
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
