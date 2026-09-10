import type { CdpImageData, CdpScreenshotRequest } from "@cjhyy/code-shell-cdp";
import type { Rectangle, WebContents } from "electron";

/** Capture the existing Electron target without opening another browser or CDP port. */
export async function captureElectronPage(
  contents: WebContents,
  request: CdpScreenshotRequest,
): Promise<CdpImageData> {
  if (contents.isDestroyed()) return { ok: false, detail: "browser target was destroyed" };
  try {
    let rect: Rectangle | undefined;
    if (request.region) {
      // capturePage accepts viewport DIPs. DOM boxes use viewport CSS pixels;
      // page zoom converts those once, while Electron handles display density.
      const zoom = contents.getZoomFactor();
      const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
      const { x, y, width, height } = request.region;
      const left = Math.ceil(x * scale);
      const top = Math.ceil(y * scale);
      rect = {
        x: left,
        y: top,
        width: Math.floor((x + width) * scale) - left,
        height: Math.floor((y + height) * scale) - top,
      };
      if (rect.width < 1 || rect.height < 1) {
        return { ok: false, detail: "capture region is empty" };
      }
    }
    const image = await contents.capturePage(rect, { stayHidden: true });
    if (image.isEmpty()) return { ok: false, detail: "screenshot returned no image" };
    const size = image.getSize();
    const factor = Math.min(1, request.maxDim / Math.max(size.width, size.height));
    const output =
      factor < 1
        ? image.resize({
            width: Math.max(1, Math.floor(size.width * factor)),
            height: Math.max(1, Math.floor(size.height * factor)),
            quality: "best",
          })
        : image;
    return { ok: true, mediaType: "image/jpeg", base64: output.toJPEG(80).toString("base64") };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
