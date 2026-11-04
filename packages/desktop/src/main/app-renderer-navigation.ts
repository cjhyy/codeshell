import type { IpcMainInvokeEvent, WebContents } from "electron";

export function checkedExternalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8_192)
    throw new Error("openExternal requires a bounded url");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("unsupported external URL scheme");
  return url.href;
}

/** Every window with the application preload stays on the application document.
 * Guest webviews have their own navigation policy and never join this registry. */
export class AppRendererNavigation {
  private readonly trusted = new WeakSet<WebContents>();
  constructor(
    private readonly rendererUrl: string,
    private readonly openExternal: (url: string) => Promise<unknown>,
  ) {}

  private isRenderer(url: string): boolean {
    try {
      const target = new URL(url);
      const app = new URL(this.rendererUrl);
      return (
        target.protocol === app.protocol &&
        target.origin === app.origin &&
        target.host === app.host &&
        target.pathname === app.pathname &&
        !target.username &&
        !target.password
      );
    } catch {
      return false;
    }
  }

  bind(contents: WebContents): void {
    if (this.trusted.has(contents)) return;
    this.trusted.add(contents);
    const open = (url: string) => {
      try {
        void this.openExternal(checkedExternalUrl(url)).catch(() => undefined);
      } catch {
        /* Unsupported schemes stay blocked. */
      }
    };
    contents.setWindowOpenHandler(({ url }) => {
      open(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (this.isRenderer(url)) return;
      event.preventDefault();
      open(url);
    });
    // A redirect must not turn a permitted dev document navigation into a
    // remote page with the application's preload.
    contents.on("will-redirect", (event, url) => {
      if (!this.isRenderer(url)) event.preventDefault();
    });
  }

  assertSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): void {
    if (
      !this.trusted.has(event.sender) ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !this.isRenderer(event.sender.getURL())
    )
      throw new Error("external links require an application window");
  }
}
