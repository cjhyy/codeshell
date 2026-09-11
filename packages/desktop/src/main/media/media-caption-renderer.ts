import { BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptionImageRequest } from "./media-processors.js";
import type { MediaJobContext } from "./media-types.js";

export function validateCaptionImageRequest(request: CaptionImageRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some(
      (key) => !["width", "height", "fontSize", "texts", "style"].includes(key),
    )
  )
    throw new Error("Invalid caption image request");
  if (request.style !== undefined && !["classic", "bold", "minimal"].includes(request.style))
    throw new Error("Unsupported caption style");
  if (
    ![request.width, request.height].every(
      (value) => Number.isSafeInteger(value) && value >= 16 && value <= 8192,
    ) ||
    !Number.isSafeInteger(request.fontSize) ||
    request.fontSize < 1 ||
    request.fontSize > 512 ||
    !Array.isArray(request.texts) ||
    request.texts.length > 10000 ||
    request.texts.some((text) => typeof text !== "string" || text.length > 4000)
  )
    throw new Error("Invalid caption image dimensions or text");
}

// Kept consistent with Video Studio's canvas compositor so downloaded MP4s
// have the same Unicode shaping, wrapping, four-line cap and background box.
export function drawCaptionPng(request: CaptionImageRequest): string {
  const canvas = document.createElement("canvas");
  canvas.width = request.width;
  canvas.height = request.height;
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h, fontSize } = request;
  const style = request.style ?? "classic";
  if (!["classic", "bold", "minimal"].includes(style)) throw new Error("Unsupported caption style");
  ctx.save();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = `${style === "bold" ? 800 : style === "minimal" ? 500 : 600} ${fontSize}px system-ui`;
  ctx.textAlign = "center";
  const lines: string[] = [];
  outer: for (const text of request.texts) {
    let line = "";
    for (const char of text) {
      if (char === "\n" || (line && ctx.measureText(line + char).width > w * 0.85)) {
        lines.push(line);
        if (lines.length === 4) break outer;
        line = char === "\n" ? "" : char;
      } else line += char;
    }
    if (line) lines.push(line);
    if (lines.length === 4) break;
  }
  const visible = lines.slice(0, 4),
    lineHeight = fontSize * 1.4;
  if (visible.length) {
    const y = h * 0.9 - visible.length * lineHeight;
    if (style === "classic") {
      const boxWidth = Math.min(
        w * 0.93,
        Math.max(...visible.map((line) => ctx.measureText(line).width)) + fontSize,
      );
      ctx.fillStyle = "#050909b8";
      ctx.beginPath();
      ctx.roundRect(
        (w - boxWidth) / 2,
        y,
        boxWidth,
        visible.length * lineHeight + fontSize * 0.5,
        8,
      );
      ctx.fill();
    } else if (style === "minimal") {
      ctx.shadowColor = "#000b";
      ctx.shadowBlur = Math.max(2, fontSize * 0.08);
      ctx.shadowOffsetY = Math.max(1, fontSize * 0.04);
    }
    ctx.fillStyle = style === "bold" ? "#ffe46b" : "#fff";
    if (style === "bold") {
      ctx.strokeStyle = "#101010";
      ctx.lineWidth = Math.max(2, fontSize * 0.12);
      ctx.lineJoin = "round";
    }
    visible.forEach((line, i) => {
      const baseline = y + lineHeight * (i + 1) - fontSize * 0.1;
      if (style === "bold") ctx.strokeText(line, w / 2, baseline);
      ctx.fillText(line, w / 2, baseline);
    });
  }
  ctx.restore();
  return canvas.toDataURL("image/png");
}

/** One isolated Chromium canvas per render job; it has no filesystem or network bridge. */
export class MediaCaptionRenderer {
  private windows = new Map<
    string,
    {
      window: BrowserWindow;
      ready: Promise<unknown>;
      closed: AbortController;
      signal: AbortSignal;
      onAbort: () => void;
    }
  >();

  constructor(
    private readonly options: { createWindow?: () => BrowserWindow; timeoutMs?: number } = {},
  ) {}

  close(jobId: string): void {
    const entry = this.windows.get(jobId);
    if (!entry) return;
    this.windows.delete(jobId);
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.closed.abort();
    // Retain the actual window while it is loading. Waiting for loadURL before
    // destroying it can hang cancellation and Host shutdown indefinitely.
    if (!entry.window.isDestroyed()) entry.window.destroy();
  }

  private wait<T>(jobId: string, promise: Promise<T>, closed: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (closed.aborted) {
        reject(new Error("Caption render cancelled"));
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        closed.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error("Caption render cancelled"));
      };
      closed.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Caption renderer timed out"));
        this.close(jobId);
      }, this.options.timeoutMs ?? 30_000);
      void promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  async render(request: CaptionImageRequest, context: MediaJobContext): Promise<string> {
    validateCaptionImageRequest(request);
    if (context.signal.aborted) throw new Error("Caption render cancelled");
    let entry = this.windows.get(context.jobId);
    try {
      if (!entry) {
        const window =
          this.options.createWindow?.() ??
          new BrowserWindow({
            show: false,
            width: 400,
            height: 300,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              backgroundThrottling: false,
            },
          });
        const onAbort = () => this.close(context.jobId);
        entry = {
          window,
          ready: Promise.resolve(),
          closed: new AbortController(),
          signal: context.signal,
          onAbort,
        };
        this.windows.set(context.jobId, entry);
        context.signal.addEventListener("abort", onAbort, { once: true });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) => event.preventDefault());
        entry.ready = window.loadURL(
          "data:text/html;charset=utf-8," +
            encodeURIComponent(
              "<!doctype html><meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; script-src 'none'; style-src 'none'\"><title>Video caption renderer</title>",
            ),
        );
      }
      await this.wait(context.jobId, entry.ready, entry.closed.signal);
      if (context.signal.aborted || entry.window.isDestroyed())
        throw new Error("Caption render cancelled");
      const image = (await this.wait(
        context.jobId,
        entry.window.webContents.executeJavaScript(
          `(${drawCaptionPng.toString()})(${JSON.stringify(request)})`,
        ),
        entry.closed.signal,
      )) as string;
      context.signal.throwIfAborted();
      if (typeof image !== "string" || !image.startsWith("data:image/png;base64,"))
        throw new Error("Caption renderer returned invalid PNG");
      const path = join(
        context.workDir,
        `caption-${createHash("sha256").update(JSON.stringify(request)).digest("hex")}.png`,
      );
      await writeFile(path, Buffer.from(image.slice("data:image/png;base64,".length), "base64"), {
        signal: context.signal,
      });
      return path;
    } catch (error) {
      if (this.windows.get(context.jobId) === entry) this.close(context.jobId);
      throw error;
    }
  }
}
